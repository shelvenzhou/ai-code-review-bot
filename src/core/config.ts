/**
 * M1 — config（纯函数）
 *
 * 把「默认值 / 仓库配置文件覆盖 / 环境变量」按优先级合并成最终 `Config`，
 * 并用 `ConfigSchema` 校验，保证产出始终合法。
 * 设计依据：docs/specs/02-design.md，工单见 docs/specs/03-tasks.md（T1）。
 *
 * 纯函数：不读 `process.env`、不做文件 I/O —— 由调用方（入口模块）传入。
 */
import { CATEGORIES, type Config, ConfigSchema } from "./contracts.ts";

/* ───────────────────────── 默认配置 ───────────────────────── */

export const DEFAULT_CONFIG: Config = {
  model: "gpt-4o",
  categories: [...CATEGORIES],
  ignoreGlobs: [],
  maxFiles: 50,
  maxDiffBytes: 200_000,
  tokenBudget: 100_000,
  thresholds: {
    postConfidence: 0.6,
    blockSeverity: "critical",
    blockConfidence: 0.85,
  },
  commentLanguage: "en",
  skipLabel: "skip-ai-review",
};

/* ───────────────────────── fileOverrides（未受信任输入）的窄化 ───────────────────────── */

/** `fileOverrides` 中允许覆盖的顶层键——其余一律忽略。 */
const KNOWN_CONFIG_KEYS = [
  "model",
  "categories",
  "ignoreGlobs",
  "maxFiles",
  "maxDiffBytes",
  "tokenBudget",
  "thresholds",
  "commentLanguage",
  "skipLabel",
] as const satisfies readonly (keyof Config)[];

type KnownConfigKey = (typeof KNOWN_CONFIG_KEYS)[number];

function isKnownConfigKey(key: string): key is KnownConfigKey {
  return (KNOWN_CONFIG_KEYS as readonly string[]).includes(key);
}

/** 是否为「普通对象」（非 null、非数组）——粗粒度地把不可信输入拒之门外。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 浅合并 `fileOverrides` 的已知顶层键到 `base`。
 *
 * - `fileOverrides` 不是普通对象 → 整体忽略（视为无覆盖）。
 * - 未知键 → 忽略。
 * - 已知键 → 直接覆盖（浅合并；最终交给 `ConfigSchema.parse` 兜底校验形状/取值范围）。
 */
function applyFileOverrides(base: Config, fileOverrides: unknown): Config {
  if (!isPlainObject(fileOverrides)) {
    return base;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(fileOverrides)) {
    if (isKnownConfigKey(key)) {
      merged[key] = value;
    }
  }
  return merged as unknown as Config;
}

/* ───────────────────────── env 覆盖（小而明确的表面） ───────────────────────── */

/** 取一个非空字符串环境变量；缺失或空串返回 `undefined`（视为「未设置」）。 */
function readEnvString(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return raw;
}

/** 把字符串解析成整数；非法（含 NaN）返回 `undefined`，留给 schema 报错或保持原值。 */
function parseIntStrict(raw: string): number | undefined {
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 应用 env 覆盖（最高优先级）。仅在变量存在且非空时生效；
 * 解析失败（如 `AI_REVIEW_MAX_FILES` 非数字）时保留已合并的值，交给最终 schema 校验报错。
 */
function applyEnvOverrides(base: Config, env: Record<string, string | undefined>): Config {
  const merged: Record<string, unknown> = { ...base };

  const model = readEnvString(env, "OPENAI_MODEL");
  if (model !== undefined) {
    merged.model = model;
  }

  const maxFilesRaw = readEnvString(env, "AI_REVIEW_MAX_FILES");
  if (maxFilesRaw !== undefined) {
    const parsed = parseIntStrict(maxFilesRaw);
    merged.maxFiles = parsed ?? maxFilesRaw;
  }

  const commentLanguage = readEnvString(env, "AI_REVIEW_COMMENT_LANGUAGE");
  if (commentLanguage !== undefined) {
    merged.commentLanguage = commentLanguage;
  }

  const skipLabel = readEnvString(env, "AI_REVIEW_SKIP_LABEL");
  if (skipLabel !== undefined) {
    merged.skipLabel = skipLabel;
  }

  return merged as unknown as Config;
}

/* ───────────────────────── 主函数 ───────────────────────── */

/**
 * 合并优先级：`DEFAULT_CONFIG` < `fileOverrides`（仓库配置文件，未受信任）< `env`（最高）。
 *
 * - `fileOverrides`：未受信的 `unknown`；非普通对象则整体忽略；只接受已知顶层键，浅合并。
 * - `env`：仅 `OPENAI_MODEL` / `AI_REVIEW_MAX_FILES` / `AI_REVIEW_COMMENT_LANGUAGE` /
 *   `AI_REVIEW_SKIP_LABEL`，且仅在存在且非空时生效；`AI_REVIEW_MAX_FILES` 解析为整数，
 *   `NaN` 时不覆盖（保留已合并值，交给最终校验报错）。
 * - 最终用 `ConfigSchema.parse` 校验；非法时抛出包含 zod 错误信息的 `Error`。
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  fileOverrides?: unknown,
): Config {
  const withFileOverrides = applyFileOverrides(DEFAULT_CONFIG, fileOverrides);
  const withEnvOverrides = applyEnvOverrides(withFileOverrides, env);

  const result = ConfigSchema.safeParse(withEnvOverrides);
  if (!result.success) {
    throw new Error(`invalid config: ${result.error.message}`);
  }
  return result.data;
}

export default loadConfig;
