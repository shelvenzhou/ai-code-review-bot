/**
 * M8 — GitHub Action 入口。
 *
 * 从 Actions 环境解析 PR（GITHUB_REPOSITORY + 事件 payload 的 pull_request.number），
 * 跑评审，按 status 设退出码（fail → 1，阻断合并）。
 * 依赖环境：GITHUB_TOKEN、OPENAI_API_KEY、GITHUB_EVENT_PATH（+ 可选 OPENAI_MODEL 等）。
 */
import { loadConfig } from "../core/config.ts";
import type { PrRef } from "../core/contracts.ts";
import { createGitHubClientFromToken } from "../github/client.ts";
import { createOpenAILLMFromEnv } from "../llm/client.ts";
import { runReview } from "../review/run.ts";

/** 从未知对象安全取属性（不依赖断言成具体类型）。 */
function getProp(obj: unknown, key: string): unknown {
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

/** 从 Actions 事件 payload 中取 pull_request.number。 */
export function extractPrNumber(payload: unknown): number | undefined {
  const n = getProp(getProp(payload, "pull_request"), "number");
  return typeof n === "number" ? n : undefined;
}

/** 用 GITHUB_REPOSITORY（"owner/repo"）+ 事件 payload 解析出 PrRef。 */
export function resolvePrRefFromActionEnv(
  env: Record<string, string | undefined>,
  payload: unknown,
): PrRef {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const slash = repository.indexOf("/");
  if (slash <= 0) {
    throw new Error('GITHUB_REPOSITORY missing or invalid (expected "owner/repo").');
  }
  const owner = repository.slice(0, slash);
  const repo = repository.slice(slash + 1);
  const number = extractPrNumber(payload);
  if (number === undefined) {
    throw new Error("Could not find pull_request.number in the event payload.");
  }
  return { owner, repo, number };
}

async function main(): Promise<number> {
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !apiKey || !eventPath) {
    console.error("GITHUB_TOKEN, OPENAI_API_KEY and GITHUB_EVENT_PATH must be set.");
    return 2;
  }

  const payload: unknown = JSON.parse(await Bun.file(eventPath).text());
  const ref = resolvePrRefFromActionEnv(process.env, payload);

  const config = loadConfig(process.env);
  const github = createGitHubClientFromToken(token);
  const llm = createOpenAILLMFromEnv(apiKey, config.model);

  const result = await runReview(ref, { github, llm, config });
  console.log(`AI review of ${result.pr}: ${result.summary} [${result.status}]`);
  return result.status === "fail" ? 1 : 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
