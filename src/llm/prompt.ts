/**
 * M5 llm — prompt 构造（纯函数）。
 *
 * 把一个 `ReviewUnit`（文件 + patch）和启用的评审维度 / 输出语言，
 * 编译成发给 OpenAI 的 system / user 消息文本。
 *
 * 设计依据：docs/specs/03-tasks.md T5；契约见 ../core/contracts.ts（冻结，仅 import）。
 */
import type { Category, Config, ReviewUnit } from "../core/contracts.ts";

/* ───────────────────────── 四维 rubric ───────────────────────── */

/**
 * 四个评审维度的描述文本，按 `Category` 枚举的字面量取键。
 * 导出以便测试 / 其它模块复用（例如校验 prompt 是否按启用维度裁剪）。
 */
export const CATEGORY_RUBRIC: Readonly<Record<Category, string>> = {
  correctness:
    "Correctness — bugs, logic errors, incorrect edge-case handling, broken control flow, " +
    "off-by-one errors, type mismatches, unhandled exceptions, or code that does not do what " +
    "it appears to intend to do.",
  security:
    "Security — injection (SQL/command/template), unsafe deserialization, secrets or " +
    "credentials in code, missing authn/authz checks, unsafe handling of user input, " +
    "path traversal, SSRF, insecure cryptography, or other exploitable weaknesses.",
  maintainability:
    "Maintainability — unclear naming, dead code, duplicated logic, missing or misleading " +
    "comments/docs, overly complex functions, poor structure, or violations of the " +
    "project's established conventions that will make future changes harder or riskier.",
  performance:
    "Performance — unnecessary work in hot paths, quadratic or worse algorithms where a " +
    "better one is straightforward, redundant I/O or network calls, unbounded memory growth, " +
    "missing batching/caching, or other inefficiencies with a real, demonstrable impact.",
};

/** rubric 文本块的标题，便于测试按行匹配。 */
const RUBRIC_HEADING = "Review along these four dimensions (only the ENABLED ones below):";

/**
 * 把启用的维度渲染成「标题 + 编号列表」的 rubric 文本块。
 * 只包含 `categories` 中列出的维度——未启用的维度完全不出现在 prompt 里。
 */
function renderRubric(categories: readonly Category[]): string {
  const lines = categories.map((category, index) => `${index + 1}. ${CATEGORY_RUBRIC[category]}`);
  return [RUBRIC_HEADING, ...lines].join("\n");
}

/* ───────────────────────── 输出语言指示 ───────────────────────── */

const LANGUAGE_NAME: Readonly<Record<Config["commentLanguage"], string>> = {
  en: "English",
  zh: "Chinese (中文)",
};

/**
 * 输出语言指示文本。
 * 导出以便测试断言「system prompt 含语言指示，且与 cfg.commentLanguage 对应」。
 */
export function languageInstruction(language: Config["commentLanguage"]): string {
  return (
    `Write the "description" and "suggestion" fields in ${LANGUAGE_NAME[language]}. ` +
    'Keep "title", "file", "severity", "category" in their normal (English) form, ' +
    "since they are structured fields, not prose."
  );
}

/* ───────────────────────── system / user 构造 ───────────────────────── */

const FINDING_FIELDS_SPEC = [
  "- file: the file path being reviewed (use the path given to you).",
  "- line: a NEW-file-side line number that is VISIBLE in the provided diff " +
    '(i.e. an added or context line — a line you could anchor a comment to with side="RIGHT"). ' +
    "Never invent a line number that does not appear in the diff.",
  "- severity: one of critical | high | medium | low.",
  "- category: one of the ENABLED categories listed in the rubric above — never report a " +
    "finding for a disabled category.",
  "- title: a short, single-sentence summary of the issue.",
  "- description: why this is a problem, grounded in the actual diff content.",
  "- suggestion (optional): a concrete fix, may include a short code snippet.",
  "- confidence: a number in [0, 1] reflecting how sure you are this is a real, actionable issue.",
].join("\n");

/**
 * 构造发给 OpenAI 的 system / user 消息。
 *
 * - system：定位「资深代码评审者」角色 + 只评审给定 diff + 只按启用维度评审 +
 *   每条 finding 的字段规范 + 「精确、避免吹毛求疵和误报」的指引 + 输出语言指示。
 * - user：文件路径 + 该单元的 patch 文本。
 */
export function buildPrompt(
  unit: ReviewUnit,
  cfg: Pick<Config, "categories" | "commentLanguage">,
): { system: string; user: string } {
  const system = [
    "You are a senior code reviewer performing an automated review of a single file's diff " +
      "from a pull request.",
    "Review ONLY the changes shown in the diff that is provided to you in the user message — " +
      "do not speculate about code outside the diff, and do not review the file as a whole.",
    renderRubric(cfg.categories),
    "For each issue you find, report a finding with exactly these fields:",
    FINDING_FIELDS_SPEC,
    "Be precise: avoid nitpicks, style bikeshedding, and speculative or low-confidence " +
      "findings. Prefer reporting fewer, well-grounded issues over many marginal ones — " +
      "false positives erode trust in this review. If the diff has no issues worth reporting " +
      "along the enabled dimensions, return an empty list of findings.",
    languageInstruction(cfg.commentLanguage),
  ].join("\n\n");

  const user = [
    `File: ${unit.file}`,
    "Diff (unified patch format; review only the lines shown here):",
    "```diff",
    unit.patch,
    "```",
  ].join("\n");

  return { system, user };
}

export default buildPrompt;
