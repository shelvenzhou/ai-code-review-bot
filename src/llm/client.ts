/**
 * M5 llm — adapter：用 OpenAI structured outputs 实现 `LLMPort`。
 *
 * 副作用集中在这里（HTTP 调用 OpenAI）；prompt 构造交给 ./prompt.ts（纯函数）。
 * 设计依据：docs/specs/03-tasks.md T5；契约见 ../core/contracts.ts（冻结，仅 import）。
 *
 * 关于 structured outputs schema（见 CLAUDE.md「关键技术点」）：
 * `contracts.ts` 里 `Finding` 的可选字段（`endLine` / `suggestion`）用的是 idiomatic
 * `optional()`。OpenAI 的 strict structured outputs 要求**每个 key 都必须出现在
 * `required` 里**，所以可选字段必须改建模为 `nullable()`。我们在本文件本地建一个
 * strict 变体 schema（不改 contracts.ts），并把模型返回的 `null` 归一为 `undefined`
 * 后再交给下游（与契约一致）。
 */
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  CategorySchema,
  type Finding,
  type LLMPort,
  type ReviewUnit,
  SeveritySchema,
} from "../core/contracts.ts";
import { buildPrompt } from "./prompt.ts";

/* ───────────────────────── strict 变体 schema（仅本文件内部使用） ─────────────────────────
 * OpenAI strict JSON-schema 模式下，每个 object 的每个 key 都必须出现在 `required` 中；
 * 可选字段需建模为「类型 | null」（即 zod 的 `.nullable()`），而不是 `.optional()`。
 * 所以这里复刻 contracts.ts 的 FindingSchema，把 `endLine` / `suggestion` 改为 nullable。
 *
 * 注意 `confidence` 故意不在 schema 层做 [0,1] range 校验（不像契约的 FindingSchema）：
 * 越界钳制是 normalizeFinding 的职责（防御模型偶尔产生的轻微越界值，例如 1.0000001），
 * 若在这里就用 min/max 拒绝，越界响应会在到达归一化之前被当成"schema 不匹配"抛出。
 */
const StrictFindingSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  endLine: z.number().int().nullable(),
  severity: SeveritySchema,
  category: CategorySchema,
  title: z.string(),
  description: z.string(),
  suggestion: z.string().nullable(),
  confidence: z.number(),
});
type StrictFinding = z.infer<typeof StrictFindingSchema>;

const StrictReviewSchema = z.object({
  findings: z.array(StrictFindingSchema),
});
type StrictReview = z.infer<typeof StrictReviewSchema>;

const RESPONSE_FORMAT = zodResponseFormat(StrictReviewSchema, "code_review_findings");

/* ───────────────────────── 最小 OpenAI 接口（仅声明用到的调用） ───────────────────────── */

/** 与 `OpenAI#chat.completions.create` 兼容的最小子集——仅声明本 adapter 用到的形状。 */
export interface OpenAILike {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: ReturnType<typeof zodResponseFormat>;
      }): Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            refusal?: string | null;
          };
        }>;
      }>;
    };
  };
}

/* ───────────────────────── 归一化：strict → 契约 Finding ───────────────────────── */

/** 把 [0,1] 之外的置信度钳制回区间内（防止模型偶尔输出越界值）。 */
function clampConfidence(confidence: number): number {
  if (Number.isNaN(confidence)) {
    return 0;
  }
  return Math.min(1, Math.max(0, confidence));
}

/**
 * 把 structured-output 返回的 strict finding 归一化为契约 `Finding`：
 * - `endLine` / `suggestion` 的 `null` → `undefined`（契约用 optional）
 * - 缺省/空 `file` → 回退到 `unit.file`（模型偶尔会漏填或填错）
 * - `confidence` 钳制进 [0, 1]
 */
function normalizeFinding(raw: StrictFinding, unit: ReviewUnit): Finding {
  const finding: Finding = {
    file: raw.file.length > 0 ? raw.file : unit.file,
    line: raw.line,
    severity: raw.severity,
    category: raw.category,
    title: raw.title,
    description: raw.description,
    confidence: clampConfidence(raw.confidence),
  };
  if (raw.endLine !== null) {
    finding.endLine = raw.endLine;
  }
  if (raw.suggestion !== null) {
    finding.suggestion = raw.suggestion;
  }
  return finding;
}

/** 解析模型返回的 JSON 字符串为 strict 结构；包裹解析错误为清晰的领域错误。 */
function parseStructuredContent(content: string): StrictReview {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (cause) {
    throw new Error("LLM adapter: model returned content that is not valid JSON", { cause });
  }

  const result = StrictReviewSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `LLM adapter: structured response did not match the expected schema: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/* ───────────────────────── adapter 工厂 ───────────────────────── */

/**
 * 用注入的 OpenAI 兼容客户端构造 `LLMPort`。
 *
 * `client` 通过依赖注入传入（测试用 fake，真实运行用 `createOpenAILLMFromEnv` 构造的客户端），
 * 保证本模块的测试不打真实网络。
 */
export function createOpenAILLM(client: OpenAILike, model: string): LLMPort {
  const review: LLMPort["review"] = async (unit, cfg) => {
    const { system, user } = buildPrompt(unit, cfg);

    let response: Awaited<ReturnType<OpenAILike["chat"]["completions"]["create"]>>;
    try {
      response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: RESPONSE_FORMAT,
      });
    } catch (cause) {
      throw new Error(`LLM adapter: OpenAI request failed for ${unit.file}`, { cause });
    }

    const choice = response.choices[0];
    if (choice === undefined) {
      throw new Error(`LLM adapter: OpenAI returned no choices for ${unit.file}`);
    }

    const { message } = choice;
    if (message.refusal !== undefined && message.refusal !== null && message.refusal !== "") {
      throw new Error(`LLM adapter: model refused to review ${unit.file}: ${message.refusal}`);
    }
    if (message.content === undefined || message.content === null) {
      throw new Error(`LLM adapter: OpenAI returned empty content for ${unit.file}`);
    }

    const structured = parseStructuredContent(message.content);

    return structured.findings
      .map((raw) => normalizeFinding(raw, unit))
      .filter((finding) => cfg.categories.includes(finding.category));
  };

  return { review };
}

/**
 * 构造真实的 OpenAI 客户端并装配成 `LLMPort`。
 * 不在本模块的单元测试中覆盖（会触发真实网络）——由集成层在真实环境下使用。
 */
export function createOpenAILLMFromEnv(apiKey: string, model: string): LLMPort {
  const client = new OpenAI({ apiKey });
  return createOpenAILLM(client, model);
}

export default createOpenAILLM;
