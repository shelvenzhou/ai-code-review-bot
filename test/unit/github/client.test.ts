import { describe, expect, test } from "bun:test";
import type { ChangedFile, PrRef, ReviewPayload } from "../../../src/core/contracts.ts";
import {
  createGitHubClient,
  GitHubError,
  type OctokitFile,
  type OctokitLike,
  type OctokitPullRequest,
} from "../../../src/github/client.ts";

const ref: PrRef = { owner: "octo", repo: "hello-world", number: 42 };

const basePullRequest: OctokitPullRequest = {
  number: 42,
  title: "Add feature X",
  body: "Some description",
  head: { sha: "head-sha-123" },
  base: { sha: "base-sha-456" },
  labels: [{ name: "enhancement" }, { name: "needs-review" }],
};

/** 构造一个 fake `OctokitLike`：可定制 PR 数据、文件列表（支持分页）、createReview 行为。 */
function makeFakeOctokit(opts: {
  pr?: OctokitPullRequest;
  filePages?: OctokitFile[][];
  onCreateReview?: (params: unknown) => void;
  getThrows?: unknown;
  listFilesThrows?: unknown;
  createReviewThrows?: unknown;
}): { octokit: OctokitLike; calls: { listFiles: unknown[]; createReview: unknown[] } } {
  const calls = { listFiles: [] as unknown[], createReview: [] as unknown[] };
  const pages = opts.filePages ?? [[]];

  const octokit: OctokitLike = {
    pulls: {
      async get(params) {
        if (opts.getThrows !== undefined) {
          throw opts.getThrows;
        }
        return { data: opts.pr ?? { ...basePullRequest, number: params.pull_number } };
      },
      async listFiles(params) {
        calls.listFiles.push(params);
        if (opts.listFilesThrows !== undefined) {
          throw opts.listFilesThrows;
        }
        const page = params.page ?? 1;
        const data = pages[page - 1] ?? [];
        return { data };
      },
      async createReview(params) {
        calls.createReview.push(params);
        if (opts.createReviewThrows !== undefined) {
          throw opts.createReviewThrows;
        }
        opts.onCreateReview?.(params);
        return { data: {} };
      },
    },
  };

  return { octokit, calls };
}

describe("createGitHubClient — getPullRequest", () => {
  test("maps PR fields: owner/repo/number from ref, shas, title, labels", async () => {
    const { octokit } = makeFakeOctokit({
      pr: basePullRequest,
      filePages: [[]],
    });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.owner).toBe("octo");
    expect(data.repo).toBe("hello-world");
    expect(data.number).toBe(42);
    expect(data.headSha).toBe("head-sha-123");
    expect(data.baseSha).toBe("base-sha-456");
    expect(data.title).toBe("Add feature X");
    expect(data.body).toBe("Some description");
    expect(data.labels).toEqual(["enhancement", "needs-review"]);
  });

  test("maps null body to empty string", async () => {
    const { octokit } = makeFakeOctokit({
      pr: { ...basePullRequest, body: null },
      filePages: [[]],
    });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.body).toBe("");
  });

  test("filters out labels without a usable name", async () => {
    const { octokit } = makeFakeOctokit({
      pr: { ...basePullRequest, labels: [{ name: "ok" }, { name: null }, {}] },
      filePages: [[]],
    });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.labels).toEqual(["ok"]);
  });

  test("maps a binary/no-patch file (patch undefined)", async () => {
    const binaryFile: OctokitFile = {
      filename: "assets/logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
    };
    const { octokit } = makeFakeOctokit({ filePages: [[binaryFile]] });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.files).toHaveLength(1);
    const file = data.files[0];
    expect(file).toBeDefined();
    expect(file?.path).toBe("assets/logo.png");
    expect(file?.patch).toBeUndefined();
    expect("patch" in (file as object)).toBe(false);
  });

  test("maps a renamed file: previousPath set, status mapped", async () => {
    const renamedFile: OctokitFile = {
      filename: "src/new-name.ts",
      status: "renamed",
      additions: 3,
      deletions: 1,
      patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      previous_filename: "src/old-name.ts",
    };
    const { octokit } = makeFakeOctokit({ filePages: [[renamedFile]] });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    const file = data.files[0];
    expect(file?.status).toBe("renamed");
    expect(file?.previousPath).toBe("src/old-name.ts");
    expect(file?.path).toBe("src/new-name.ts");
    expect(file?.patch).toBe("@@ -1,1 +1,1 @@\n-old\n+new");
  });

  test("does not set previousPath when previous_filename absent", async () => {
    const file: OctokitFile = {
      filename: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-a\n+b",
    };
    const { octokit } = makeFakeOctokit({ filePages: [[file]] });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.files[0]?.previousPath).toBeUndefined();
    expect("previousPath" in (data.files[0] as object)).toBe(false);
  });

  test("maps additions/deletions through", async () => {
    const file: OctokitFile = {
      filename: "src/a.ts",
      status: "added",
      additions: 10,
      deletions: 2,
      patch: "@@ -0,0 +1,10 @@",
    };
    const { octokit } = makeFakeOctokit({ filePages: [[file]] });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.files[0]?.additions).toBe(10);
    expect(data.files[0]?.deletions).toBe(2);
  });

  describe("status mapping (octokit union → contract union)", () => {
    const cases: Array<{ octokitStatus: OctokitFile["status"]; expected: ChangedFile["status"] }> =
      [
        { octokitStatus: "added", expected: "added" },
        { octokitStatus: "copied", expected: "added" },
        { octokitStatus: "removed", expected: "removed" },
        { octokitStatus: "renamed", expected: "renamed" },
        { octokitStatus: "modified", expected: "modified" },
        { octokitStatus: "changed", expected: "modified" },
        { octokitStatus: "unchanged", expected: "modified" },
      ];

    for (const { octokitStatus, expected } of cases) {
      test(`"${octokitStatus}" → "${expected}"`, async () => {
        const file: OctokitFile = {
          filename: "f.ts",
          status: octokitStatus,
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@",
        };
        const { octokit } = makeFakeOctokit({ filePages: [[file]] });
        const client = createGitHubClient(octokit);

        const data = await client.getPullRequest(ref);

        expect(data.files[0]?.status).toBe(expected);
      });
    }
  });

  test("paginates through multiple pages of listFiles", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `file-${i}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@",
    }));
    const page2: OctokitFile[] = [
      {
        filename: "file-100.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@",
      },
    ];
    const { octokit, calls } = makeFakeOctokit({ filePages: [page1, page2] });
    const client = createGitHubClient(octokit);

    const data = await client.getPullRequest(ref);

    expect(data.files).toHaveLength(101);
    expect(data.files[100]?.path).toBe("file-100.ts");
    expect(calls.listFiles).toHaveLength(2);
  });

  test("wraps a thrown error from pulls.get into GitHubError", async () => {
    const { octokit } = makeFakeOctokit({ getThrows: new Error("404 Not Found") });
    const client = createGitHubClient(octokit);

    await expect(client.getPullRequest(ref)).rejects.toThrow(GitHubError);
    await expect(client.getPullRequest(ref)).rejects.toThrow(/404 Not Found/);
  });

  test("wraps a thrown error from pulls.listFiles into GitHubError", async () => {
    const { octokit } = makeFakeOctokit({ listFilesThrows: new Error("rate limited") });
    const client = createGitHubClient(octokit);

    await expect(client.getPullRequest(ref)).rejects.toThrow(GitHubError);
    await expect(client.getPullRequest(ref)).rejects.toThrow(/rate limited/);
  });

  test("wraps a thrown non-Error value into GitHubError", async () => {
    const { octokit } = makeFakeOctokit({ getThrows: { status: 500, message: "boom" } });
    const client = createGitHubClient(octokit);

    let error: unknown;
    try {
      await client.getPullRequest(ref);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).operation).toContain("getPullRequest");
  });
});

describe("createGitHubClient — postReview", () => {
  const review: ReviewPayload = {
    summary: "Overall looks good, a few nits.",
    event: "COMMENT",
    comments: [
      { path: "src/a.ts", line: 10, body: "Consider renaming this." },
      { path: "src/b.ts", line: 22, body: "Possible off-by-one." },
    ],
  };

  test("calls createReview with mapped body/event/comments (path/line/side/body)", async () => {
    let captured: unknown;
    const { octokit } = makeFakeOctokit({
      onCreateReview: (params) => {
        captured = params;
      },
    });
    const client = createGitHubClient(octokit);

    await client.postReview(ref, review);

    expect(captured).toEqual({
      owner: "octo",
      repo: "hello-world",
      pull_number: 42,
      body: "Overall looks good, a few nits.",
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 10, side: "RIGHT", body: "Consider renaming this." },
        { path: "src/b.ts", line: 22, side: "RIGHT", body: "Possible off-by-one." },
      ],
    });
  });

  test("passes summary through as the review body verbatim", async () => {
    let captured: { body?: string } | undefined;
    const { octokit } = makeFakeOctokit({
      onCreateReview: (params) => {
        captured = params as { body?: string };
      },
    });
    const client = createGitHubClient(octokit);

    await client.postReview(ref, { ...review, summary: "custom summary text" });

    expect(captured?.body).toBe("custom summary text");
  });

  test("handles an empty comments array", async () => {
    let captured: { comments?: unknown[] } | undefined;
    const { octokit } = makeFakeOctokit({
      onCreateReview: (params) => {
        captured = params as { comments?: unknown[] };
      },
    });
    const client = createGitHubClient(octokit);

    await client.postReview(ref, { summary: "nothing to say", event: "COMMENT", comments: [] });

    expect(captured?.comments).toEqual([]);
  });

  test("wraps a thrown error from pulls.createReview into GitHubError", async () => {
    const { octokit } = makeFakeOctokit({ createReviewThrows: new Error("422 Unprocessable") });
    const client = createGitHubClient(octokit);

    await expect(client.postReview(ref, review)).rejects.toThrow(GitHubError);
    await expect(client.postReview(ref, review)).rejects.toThrow(/422 Unprocessable/);
  });

  test("wraps a thrown non-Error value into GitHubError with operation context", async () => {
    const { octokit } = makeFakeOctokit({ createReviewThrows: "network down" });
    const client = createGitHubClient(octokit);

    let error: unknown;
    try {
      await client.postReview(ref, review);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).operation).toContain("postReview");
    expect((error as Error).message).toContain("network down");
  });
});
