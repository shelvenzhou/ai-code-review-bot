/**
 * M8 — CLI 入口。
 *
 * 用法：bun run src/entrypoints/cli.ts <owner/repo#number> [--dry-run] [--json]
 *   --dry-run  仍拉取并评审，但不回帖（本地试跑用）
 *   --json     stdout 打印结构化 ReviewResult（默认打印人读文本）
 * 退出码：status==="fail" → 1，否则 0；参数/环境缺失 → 2。
 */
import { loadConfig } from "../core/config.ts";
import type { GitHubPort, PrRef } from "../core/contracts.ts";
import { createGitHubClientFromToken } from "../github/client.ts";
import { createOpenAILLMFromEnv } from "../llm/client.ts";
import { render } from "../render/index.ts";
import { runReview } from "../review/run.ts";

/** 解析 "owner/repo#number" 为 PrRef。 */
export function parsePrRef(spec: string): PrRef {
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(spec.trim());
  if (match === null) {
    throw new Error(`Invalid PR ref "${spec}". Expected "owner/repo#number".`);
  }
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(`Invalid PR ref "${spec}".`);
  }
  return { owner, repo, number: Number(number) };
}

/** 包一层使 postReview 变 no-op（--dry-run）。 */
function dryRun(github: GitHubPort): GitHubPort {
  return {
    getPullRequest: (ref) => github.getPullRequest(ref),
    postReview: async () => {},
  };
}

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));

  const spec = positional[0];
  if (spec === undefined) {
    console.error("usage: cli <owner/repo#number> [--dry-run] [--json]");
    return 2;
  }
  const ref = parsePrRef(spec);

  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  if (token === undefined || apiKey === undefined || token === "" || apiKey === "") {
    console.error("GITHUB_TOKEN and OPENAI_API_KEY must be set in the environment.");
    return 2;
  }

  const config = loadConfig(process.env);
  const baseGitHub = createGitHubClientFromToken(token);
  const github = flags.has("--dry-run") ? dryRun(baseGitHub) : baseGitHub;
  const llm = createOpenAILLMFromEnv(apiKey, config.model);

  const result = await runReview(ref, { github, llm, config });

  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(render({ result, inlineFindings: [] }).text);
  }
  return result.status === "fail" ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
