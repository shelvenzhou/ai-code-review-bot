/**
 * 🔒 FROZEN CONTRACT — 全项目共享的类型 / schema / 接口。
 *
 * 规则（见 CLAUDE.md）：只能 import，禁止修改。需要变更先停下上报，由人统一改。
 * 这是多 agent 并行的地基：各模块只依赖本文件，不依赖彼此实现。
 *
 * 设计依据：docs/specs/02-design.md §3。
 */
import { z } from "zod";

/* ───────────────────────── 枚举 ───────────────────────── */

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = ["correctness", "security", "maintainability", "performance"] as const;

export const SeveritySchema = z.enum(SEVERITIES);
export const CategorySchema = z.enum(CATEGORIES);

export type Severity = z.infer<typeof SeveritySchema>;
export type Category = z.infer<typeof CategorySchema>;

/* ───────────────────────── Finding / 结果 ─────────────────────────
 * 注意：可选字段用 optional（idiomatic TS）。
 * LLM adapter（M5）需另建 strict 变体（可选→nullable）供 OpenAI structured outputs，
 * 并把返回的 null 归一为 undefined 再交给下游。
 */

export const FindingSchema = z.object({
  /** 相对仓库根的路径 */
  file: z.string(),
  /** 锚点：新文件侧行号 */
  line: z.number().int(),
  endLine: z.number().int().optional(),
  severity: SeveritySchema,
  category: CategorySchema,
  /** 一句话标题 */
  title: z.string(),
  /** 为什么是问题 */
  description: z.string(),
  /** 怎么改（可含代码） */
  suggestion: z.string().optional(),
  /** 0..1 */
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewStatsSchema = z.object({
  bySeverity: z.object({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }),
  byCategory: z.object({
    correctness: z.number().int(),
    security: z.number().int(),
    maintainability: z.number().int(),
    performance: z.number().int(),
  }),
  filesReviewed: z.number().int(),
  filesSkipped: z.number().int(),
});
export type ReviewStats = z.infer<typeof ReviewStatsSchema>;

export const ReviewResultSchema = z.object({
  /** owner/repo#number */
  pr: z.string(),
  commitSha: z.string(),
  findings: z.array(FindingSchema),
  summary: z.string(),
  stats: ReviewStatsSchema,
  /** fail = 存在高置信 critical → 阻断合并 */
  status: z.enum(["pass", "fail"]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/* ───────────────────────── 领域类型（来自 GitHub） ───────────────────────── */

export const PrRefSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
});
export type PrRef = z.infer<typeof PrRefSchema>;

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  /** unified diff hunk 文本；二进制文件为空 */
  patch: z.string().optional(),
  additions: z.number().int(),
  deletions: z.number().int(),
  previousPath: z.string().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const PullRequestDataSchema = PrRefSchema.extend({
  headSha: z.string(),
  baseSha: z.string(),
  title: z.string(),
  body: z.string(),
  files: z.array(ChangedFileSchema),
  labels: z.array(z.string()),
});
export type PullRequestData = z.infer<typeof PullRequestDataSchema>;

/* ───────────────────────── Diff（M4 解析产物） ───────────────────────── */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** 新文件侧行号（add / ctx 有） */
  newLine?: number;
  /** 旧文件侧行号（del / ctx 有） */
  oldLine?: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/* ───────────────────────── 过滤（M3 产物） ───────────────────────── */

export interface ReviewUnit {
  file: string;
  patch: string;
  hunks: DiffHunk[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface FilterResult {
  units: ReviewUnit[];
  skipped: SkippedFile[];
}

/* ───────────────────────── 配置（M1） ───────────────────────── */

export const ConfigSchema = z.object({
  /** OPENAI_MODEL */
  model: z.string(),
  /** 启用的评审维度 */
  categories: z.array(CategorySchema),
  ignoreGlobs: z.array(z.string()),
  maxFiles: z.number().int().positive(),
  maxDiffBytes: z.number().int().positive(),
  tokenBudget: z.number().int().positive(),
  thresholds: z.object({
    /** ≥ 才回帖 (FR-6) */
    postConfidence: z.number().min(0).max(1),
    /** 触发阻断的最低严重度 */
    blockSeverity: SeveritySchema,
    /** 触发阻断的最低置信度 (A-7) */
    blockConfidence: z.number().min(0).max(1),
  }),
  commentLanguage: z.enum(["en", "zh"]),
  skipLabel: z.string(),
});
export type Config = z.infer<typeof ConfigSchema>;

/* ───────────────────────── Ports（DI 接缝，可 mock） ───────────────────────── */

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewPayload {
  summary: string;
  comments: InlineComment[];
  event: "COMMENT";
}

export interface GitHubPort {
  getPullRequest(ref: PrRef): Promise<PullRequestData>;
  postReview(ref: PrRef, review: ReviewPayload): Promise<void>;
}

export interface LLMPort {
  review(
    unit: ReviewUnit,
    cfg: Pick<Config, "model" | "categories" | "commentLanguage">,
  ): Promise<Finding[]>;
}

/* ───────────────────────── 各模块对外签名（用 satisfies 对齐） ─────────────────────────
 * 实现放各自模块；这里只声明类型，作为不可偏离的对外约定。
 */

/** M3 filter */
export type FilterFn = (files: ChangedFile[], cfg: Config) => FilterResult;

/** M4 diff：解析 patch 为 hunks */
export type ParsePatch = (patch: string) => DiffHunk[];
/** M4 diff：新文件某行是否落在 diff 内（GitHub 仅允许评论 diff 内的行）。
 *  评论用 finding.line + side:"RIGHT" 直接定位，无需 legacy 的 diff position。 */
export type IsCommentableFn = (line: number, hunks: DiffHunk[]) => boolean;

/** M7 render（纯格式化）。anchoring 决策在 M6：用 IsCommentableFn 选出可行内评论的
 *  findings 作为 inlineFindings 传入；其余由 render 归入 summary。 */
export interface RenderInput {
  result: ReviewResult;
  /** result.findings 中可作行内评论的子集 */
  inlineFindings: Finding[];
}
export interface RenderOutput {
  text: string;
  markdownSummary: string;
  inlineComments: InlineComment[];
}
export type RenderFn = (input: RenderInput) => RenderOutput;

/** M6 review orchestrator */
export interface ReviewDeps {
  github: GitHubPort;
  llm: LLMPort;
  config: Config;
}
export type RunReview = (ref: PrRef, deps: ReviewDeps) => Promise<ReviewResult>;
