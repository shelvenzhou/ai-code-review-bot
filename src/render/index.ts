/**
 * M7 — render（纯函数）
 *
 * 把 `ReviewResult` + 已锚定的 `inlineFindings` 渲染成三种输出：
 * - `inlineComments`：逐条行内评论（path/line/body），喂给 GitHubPort.postReview
 * - `markdownSummary`：PR 级别的汇总评论 markdown（含统计 + 未能行内展示的发现列表）
 * - `text`：人类可读的终端输出（按严重度分组 + 统计 + 总体 status）
 *
 * 纯函数：无 I/O、无 Date.now、无随机性。
 * 设计依据：docs/specs/02-design.md；工单见 docs/specs/03-tasks.md（T6）。
 */
import type {
  Finding,
  InlineComment,
  RenderFn,
  RenderInput,
  RenderOutput,
  ReviewResult,
  ReviewStats,
  Severity,
} from "../core/contracts.ts";
import { CATEGORIES, SEVERITIES } from "../core/contracts.ts";

/* ───────────────────────── “是否已被行内展示”判定规则 ─────────────────────────
 *
 * 规则：一个 `result.findings` 中的 finding，若在 `inlineFindings` 中存在
 * **同对象引用（===）** 的条目，则视为“已行内展示”；否则视为“未行内展示”，
 * 需在 markdownSummary 中以列表形式兜底，避免信息丢失。
 *
 * 选择对象引用而非 file+line+title 结构相等的原因：
 * - `inlineFindings` 按契约定义为 `result.findings` 的子集（M6 用 IsCommentableFn
 *   从 `result.findings` 中筛选出可锚定的条目），自然保留对象引用；
 * - 结构相等在重复 finding（同 file/line/title 但不同 description/severity）场景下
 *   会产生歧义匹配，对象引用判定无歧义、O(1) 可比较（经 Set 优化为 O(n)）。
 */
function buildInlineSet(inlineFindings: readonly Finding[]): ReadonlySet<Finding> {
  return new Set(inlineFindings);
}

/* ───────────────────────── 小工具 ───────────────────────── */

function severityLabel(severity: Severity): string {
  return severity.toUpperCase();
}

/** 启发式判断 suggestion 文本是否“看起来像代码”，决定是否用 fenced code block 包裹。 */
function looksLikeCode(suggestion: string): boolean {
  const trimmed = suggestion.trim();
  if (trimmed === "") {
    return false;
  }
  if (trimmed.includes("```")) {
    // 已自带 fenced block，不重复包裹
    return false;
  }
  const codeIndicatorRe = /[{};()=<>[\]]|=>|^[-+*]\s|^\s{2,}\S/m;
  return trimmed.includes("\n") || codeIndicatorRe.test(trimmed);
}

/** 渲染单条 finding 的行内评论 body：标题行 + 空行 + description + 可选 Suggestion 段。 */
function renderInlineCommentBody(finding: Finding): string {
  const header = `**[${severityLabel(finding.severity)} · ${finding.category}] ${finding.title}**`;
  const parts = [header, "", finding.description];

  if (finding.suggestion !== undefined && finding.suggestion.trim() !== "") {
    const suggestion = finding.suggestion.trim();
    const body = looksLikeCode(suggestion) ? `\`\`\`\n${suggestion}\n\`\`\`` : suggestion;
    parts.push("", "Suggestion:", body);
  }

  return parts.join("\n");
}

function renderInlineComments(inlineFindings: readonly Finding[]): InlineComment[] {
  return inlineFindings.map((finding) => ({
    path: finding.file,
    line: finding.line,
    body: renderInlineCommentBody(finding),
  }));
}

/* ───────────────────────── 统计区块（markdownSummary / text 共用文案结构） ───────────────────────── */

function renderStatsLines(stats: ReviewStats): string[] {
  const bySeverity = SEVERITIES.map((s) => `${s}: ${stats.bySeverity[s]}`).join(", ");
  const byCategory = CATEGORIES.map((c) => `${c}: ${stats.byCategory[c]}`).join(", ");
  return [
    "Stats:",
    `- By severity — ${bySeverity}`,
    `- By category — ${byCategory}`,
    `- Files reviewed: ${stats.filesReviewed}`,
    `- Files skipped: ${stats.filesSkipped}`,
  ];
}

/* ───────────────────────── markdownSummary ───────────────────────── */

function renderUnanchoredLine(finding: Finding): string {
  return `- ${finding.file}:${finding.line} [${finding.severity}/${finding.category}] ${finding.title}`;
}

function renderMarkdownSummary(result: ReviewResult, inlineSet: ReadonlySet<Finding>): string {
  const sections: string[] = [result.summary, "", ...renderStatsLines(result.stats)];

  const unanchored = result.findings.filter((finding) => !inlineSet.has(finding));
  sections.push("", "Findings not shown inline:");
  if (unanchored.length === 0) {
    sections.push("- (none — all findings were anchored inline)");
  } else {
    for (const finding of unanchored) {
      sections.push(renderUnanchoredLine(finding));
    }
  }

  return sections.join("\n");
}

/* ───────────────────────── text（终端输出） ───────────────────────── */

function renderTextFindingLine(finding: Finding): string {
  return `${finding.file}:${finding.line} [${finding.category}] ${finding.title} — ${finding.description}`;
}

function renderTextGroups(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  for (const severity of SEVERITIES) {
    const group = findings.filter((finding) => finding.severity === severity);
    lines.push(`${severityLabel(severity)} (${group.length})`);
    if (group.length === 0) {
      lines.push("  (none)");
    } else {
      for (const finding of group) {
        lines.push(`  ${renderTextFindingLine(finding)}`);
      }
    }
  }
  return lines;
}

function renderText(result: ReviewResult): string {
  const lines: string[] = [
    `Review for ${result.pr} @ ${result.commitSha}`,
    "",
    ...renderTextGroups(result.findings),
  ];

  lines.push("", ...renderStatsLines(result.stats));
  lines.push(
    "",
    `Status: ${result.status.toUpperCase()} (${result.status === "fail" ? "blocking" : "not blocking"})`,
  );

  return lines.join("\n");
}

/* ───────────────────────── 主函数 ───────────────────────── */

export const render: RenderFn = (input: RenderInput): RenderOutput => {
  const { result, inlineFindings } = input;
  const inlineSet = buildInlineSet(inlineFindings);

  return {
    text: renderText(result),
    markdownSummary: renderMarkdownSummary(result, inlineSet),
    inlineComments: renderInlineComments(inlineFindings),
  };
};

export default render;
