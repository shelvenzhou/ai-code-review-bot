import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import type {
  Finding,
  GitHubPort,
  LLMPort,
  PrRef,
  PullRequestData,
  ReviewPayload,
} from "../../src/core/contracts.ts";
import { runReview } from "../../src/review/run.ts";

const REF: PrRef = { owner: "octo", repo: "demo", number: 7 };

// 新文件侧可评论行：1(ctx) 2(add) 3(add) 4(ctx)
const PATCH = [
  "@@ -1,2 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
].join("\n");

function basePr(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    owner: "octo",
    repo: "demo",
    number: 7,
    headSha: "deadbeef",
    baseSha: "cafef00d",
    title: "demo PR",
    body: "",
    labels: [],
    files: [
      { path: "src/app.ts", status: "modified", patch: PATCH, additions: 2, deletions: 0 },
      { path: "bun.lock", status: "modified", patch: "+lock", additions: 1, deletions: 0 },
    ],
    ...overrides,
  };
}

function fakeGitHub(pr: PullRequestData) {
  const posted: ReviewPayload[] = [];
  const github: GitHubPort = {
    getPullRequest: async () => pr,
    postReview: async (_ref, payload) => {
      posted.push(payload);
    },
  };
  return { github, posted };
}

function fakeLLM(byFile: Record<string, Finding[]>): LLMPort {
  return { review: async (unit) => byFile[unit.file] ?? [] };
}

const APP_FINDINGS: Finding[] = [
  {
    file: "src/app.ts",
    line: 2,
    severity: "high",
    category: "correctness",
    title: "A",
    description: "a",
    confidence: 0.9,
  },
  {
    file: "src/app.ts",
    line: 99,
    severity: "medium",
    category: "maintainability",
    title: "B",
    description: "b",
    confidence: 0.8,
  },
  {
    file: "src/app.ts",
    line: 3,
    severity: "low",
    category: "performance",
    title: "C",
    description: "c",
    confidence: 0.4,
  },
  {
    file: "src/app.ts",
    line: 1,
    severity: "critical",
    category: "security",
    title: "D",
    description: "d",
    confidence: 0.95,
  },
];

describe("runReview integration", () => {
  test("full pipeline: threshold, dedupe/sort, status, anchoring, post", async () => {
    const { github, posted } = fakeGitHub(basePr());
    const llm = fakeLLM({ "src/app.ts": APP_FINDINGS });

    const result = await runReview(REF, { github, llm, config: DEFAULT_CONFIG });

    // C (confidence 0.4 < postConfidence 0.6) dropped; sorted critical→high→medium.
    expect(result.findings.map((f) => f.title)).toEqual(["D", "A", "B"]);
    // D is critical @ 0.95 ≥ blockConfidence 0.85 → blocking.
    expect(result.status).toBe("fail");
    // 1 reviewable (src/app.ts), 1 skipped (bun.lock).
    expect(result.stats.filesReviewed).toBe(1);
    expect(result.stats.filesSkipped).toBe(1);
    expect(result.stats.bySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
    expect(result.pr).toBe("octo/demo#7");
    expect(result.commitSha).toBe("deadbeef");

    // posted exactly once; inline comments only for commentable lines (D@1, A@2); B@99 not inline.
    expect(posted).toHaveLength(1);
    const payload = posted[0];
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments.map((c) => c.line).sort((x, y) => x - y)).toEqual([1, 2]);
    expect(payload.comments.every((c) => c.path === "src/app.ts")).toBe(true);
    // unanchored finding B is folded into the summary, not lost.
    expect(payload.summary).toContain("src/app.ts:99");
  });

  test("skip label short-circuits: no review, no post", async () => {
    const { github, posted } = fakeGitHub(basePr({ labels: [DEFAULT_CONFIG.skipLabel] }));
    const llm = fakeLLM({ "src/app.ts": APP_FINDINGS });

    const result = await runReview(REF, { github, llm, config: DEFAULT_CONFIG });

    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("pass");
    expect(result.summary.toLowerCase()).toContain("skip");
    expect(posted).toHaveLength(0);
  });

  test("no findings: passes and still posts a summary with zero comments", async () => {
    const { github, posted } = fakeGitHub(basePr());
    const llm = fakeLLM({});

    const result = await runReview(REF, { github, llm, config: DEFAULT_CONFIG });

    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("pass");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.comments).toHaveLength(0);
  });
});
