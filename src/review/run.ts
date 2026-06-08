/**
 * M6 review — orchestrator（集成点）。
 *
 * 把各模块串成完整流水线：
 *   fetch(github) → filter(M3) → review(llm, 逐 unit) → postprocess(阈值/去重/排序)
 *   → status 计算 → anchor(M4 isCommentable) → render(M7) → post(github)
 *
 * 副作用只经 ports（github / llm）注入；纯逻辑（filter / diff / render）直接 import。
 * 编排层自身的决策（顺序调用、去重键、status 语义、summary 生成）不属于任何单一模块，
 * 是集成者的职责。设计依据：docs/specs/02-design.md §1。
 */
import {
  type DiffHunk,
  type Finding,
  type ReviewResult,
  type ReviewStats,
  type RunReview,
  SEVERITIES,
  type Severity,
} from "../core/contracts.ts";
import { isCommentable, parsePatch } from "../diff/index.ts";
import { filter } from "../filter/index.ts";
import { render } from "../render/index.ts";

/** 严重度排序权重（critical 最高）。 */
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** 统计各维度计数。 */
function computeStats(
  findings: Finding[],
  filesReviewed: number,
  filesSkipped: number,
): ReviewStats {
  const bySeverity: ReviewStats["bySeverity"] = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: ReviewStats["byCategory"] = {
    correctness: 0,
    security: 0,
    maintainability: 0,
    performance: 0,
  };
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byCategory[f.category] += 1;
  }
  return { bySeverity, byCategory, filesReviewed, filesSkipped };
}

/** 去重：同 文件:行:严重度:维度:标题 视为重复，保留置信度最高者。 */
function dedupe(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.severity}:${f.category}:${f.title}`;
    const existing = byKey.get(key);
    if (existing === undefined || f.confidence > existing.confidence) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}

/** 排序：严重度降序 → 文件升序 → 行升序。 */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySev !== 0) {
      return bySev;
    }
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.line - b.line;
  });
}

/** 生成 PR 级别的一句话 summary。 */
function buildSummary(
  findings: Finding[],
  filesReviewed: number,
  filesSkipped: number,
  status: "pass" | "fail",
): string {
  if (findings.length === 0) {
    return `No issues found across ${filesReviewed} reviewed file(s) (${filesSkipped} skipped).`;
  }
  const parts: string[] = [];
  for (const s of SEVERITIES) {
    const n = findings.filter((f) => f.severity === s).length;
    if (n > 0) {
      parts.push(`${n} ${s}`);
    }
  }
  const blocking = status === "fail" ? " — blocking issue(s) present" : "";
  return `Found ${findings.length} issue(s) (${parts.join(", ")}) across ${filesReviewed} reviewed file(s)${blocking}.`;
}

export const runReview: RunReview = async (ref, deps) => {
  const { github, llm, config } = deps;
  const pr = await github.getPullRequest(ref);
  const prLabel = `${pr.owner}/${pr.repo}#${pr.number}`;

  // skip-label 短路：不评审、不回帖。
  if (pr.labels.includes(config.skipLabel)) {
    return {
      pr: prLabel,
      commitSha: pr.headSha,
      findings: [],
      summary: `Skipped: PR is labeled "${config.skipLabel}".`,
      stats: computeStats([], 0, pr.files.length),
      status: "pass",
    };
  }

  const { units, skipped } = filter(pr.files, config);

  // 逐 unit 评审（顺序调用，避免限流；并行可作后续优化）。
  const raw: Finding[] = [];
  for (const unit of units) {
    raw.push(...(await llm.review(unit, config)));
  }

  // postprocess：置信度阈值 → 去重 → 排序。
  const passed = raw.filter((f) => f.confidence >= config.thresholds.postConfidence);
  const findings = sortFindings(dedupe(passed));

  // status：存在「严重度 ≥ blockSeverity 且 置信度 ≥ blockConfidence」的发现 → fail。
  const blockRank = SEVERITY_RANK[config.thresholds.blockSeverity];
  const status: "pass" | "fail" = findings.some(
    (f) =>
      SEVERITY_RANK[f.severity] >= blockRank && f.confidence >= config.thresholds.blockConfidence,
  )
    ? "fail"
    : "pass";

  const stats = computeStats(findings, units.length, skipped.length);
  const result: ReviewResult = {
    pr: prLabel,
    commitSha: pr.headSha,
    findings,
    summary: buildSummary(findings, units.length, skipped.length, status),
    stats,
    status,
  };

  // anchor：判断每条发现能否行内评论（解析交给 M4）。
  const hunksByFile = new Map<string, DiffHunk[]>();
  for (const unit of units) {
    hunksByFile.set(unit.file, parsePatch(unit.patch));
  }
  const inlineFindings = findings.filter((f) =>
    isCommentable(f.line, hunksByFile.get(f.file) ?? []),
  );

  // render → post。
  const rendered = render({ result, inlineFindings });
  await github.postReview(ref, {
    summary: rendered.markdownSummary,
    comments: rendered.inlineComments,
    event: "COMMENT",
  });

  return result;
};

export default runReview;
