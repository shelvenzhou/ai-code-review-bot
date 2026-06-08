/**
 * M2 — github（adapter，实现 GitHubPort）
 *
 * 用 Octokit 拉取 PR 数据并发布评审结果。
 * 设计依据：docs/specs/02-design.md，工单见 docs/specs/03-tasks.md（T2）。
 *
 * 关键点：Octokit 实例可注入（`OctokitLike`），测试用 fake，不打真实网络。
 * 真实网络路径（`createGitHubClientFromToken`）只是组装 + 委托，测试不覆盖。
 */
import { Octokit } from "@octokit/rest";
import type {
  ChangedFile,
  GitHubPort,
  PrRef,
  PullRequestData,
  ReviewPayload,
} from "../core/contracts.ts";

/* ───────────────────────── 注入用最小 Octokit 接口 ─────────────────────────
 * 只声明我们调用的方法 + 我们读取的字段，方便测试用 fake 注入（不依赖 @octokit 的
 * 巨大生成类型，符合 CLAUDE.md「优先纯净、可测」的原则）。
 */

/** GitHub REST 返回的文件变更状态（diff entry）。 */
export type OctokitFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

/** `pulls.get` 响应里我们读取的字段子集。 */
export interface OctokitPullRequest {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string };
  base: { sha: string };
  labels: ReadonlyArray<{ name?: string | null | undefined }>;
}

/** `pulls.listFiles` 响应单条目里我们读取的字段子集（diff entry）。 */
export interface OctokitFile {
  filename: string;
  status: OctokitFileStatus;
  additions: number;
  deletions: number;
  patch?: string | undefined;
  previous_filename?: string | undefined;
}

/** 我们调用的 Octokit 方法的最小签名集合。 */
export interface OctokitLike {
  pulls: {
    get(params: { owner: string; repo: string; pull_number: number }): Promise<{
      data: OctokitPullRequest;
    }>;
    listFiles(params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: OctokitFile[] }>;
    createReview(params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
      event: "COMMENT";
      comments: Array<{ path: string; line: number; side: string; body: string }>;
    }): Promise<unknown>;
  };
}

/* ───────────────────────── 领域错误 ───────────────────────── */

/** 把外部（Octokit / 网络）错误包成清晰的领域错误，附带操作上下文。 */
export class GitHubError extends Error {
  readonly operation: string;
  override readonly cause?: unknown;

  constructor(operation: string, cause: unknown) {
    super(`GitHub API error during ${operation}: ${describeCause(cause)}`);
    this.name = "GitHubError";
    this.operation = operation;
    this.cause = cause;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** 把任意 thrown 值包成 `GitHubError`（保留原始 cause 供排查）。 */
function wrap(operation: string, cause: unknown): GitHubError {
  return cause instanceof GitHubError ? cause : new GitHubError(operation, cause);
}

/* ───────────────────────── 字段映射 ───────────────────────── */

/** Octokit 的文件状态 → 我们契约里的 union（copied→added；changed/unchanged→modified）。 */
function mapFileStatus(status: OctokitFileStatus): ChangedFile["status"] {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "modified":
    case "changed":
    case "unchanged":
      return "modified";
    default: {
      // 穷举守卫：未知值时退化为 "modified"，不抛出（GitHub 未来可能扩展枚举）。
      const _exhaustive: never = status;
      void _exhaustive;
      return "modified";
    }
  }
}

function mapFile(file: OctokitFile): ChangedFile {
  const mapped: ChangedFile = {
    path: file.filename,
    status: mapFileStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
  };
  if (file.patch !== undefined) {
    mapped.patch = file.patch;
  }
  if (file.previous_filename !== undefined) {
    mapped.previousPath = file.previous_filename;
  }
  return mapped;
}

function mapLabels(labels: OctokitPullRequest["labels"]): string[] {
  return labels
    .map((label) => label.name)
    .filter((name): name is string => typeof name === "string");
}

const LIST_FILES_PER_PAGE = 100;

/** 翻页拉取 PR 改动文件（GitHub 单页最多 100 条）。 */
async function listAllFiles(octokit: OctokitLike, ref: PrRef): Promise<OctokitFile[]> {
  const all: OctokitFile[] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.pulls.listFiles({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: LIST_FILES_PER_PAGE,
      page,
    });
    all.push(...data);
    if (data.length < LIST_FILES_PER_PAGE) {
      break;
    }
    page += 1;
  }
  return all;
}

/* ───────────────────────── 工厂函数 ───────────────────────── */

/** 用注入的 `OctokitLike` 构造 `GitHubPort`（测试用 fake 注入这里）。 */
export function createGitHubClient(octokit: OctokitLike): GitHubPort {
  return {
    async getPullRequest(ref: PrRef): Promise<PullRequestData> {
      let pr: OctokitPullRequest;
      try {
        const response = await octokit.pulls.get({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
        });
        pr = response.data;
      } catch (cause) {
        throw wrap("getPullRequest (pulls.get)", cause);
      }

      let files: OctokitFile[];
      try {
        files = await listAllFiles(octokit, ref);
      } catch (cause) {
        throw wrap("getPullRequest (pulls.listFiles)", cause);
      }

      return {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        title: pr.title,
        body: pr.body ?? "",
        labels: mapLabels(pr.labels),
        files: files.map(mapFile),
      };
    },

    async postReview(ref: PrRef, review: ReviewPayload): Promise<void> {
      try {
        await octokit.pulls.createReview({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          body: review.summary,
          event: review.event,
          comments: review.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: "RIGHT",
            body: comment.body,
          })),
        });
      } catch (cause) {
        throw wrap("postReview (pulls.createReview)", cause);
      }
    },
  } satisfies GitHubPort;
}

/**
 * 用真实 token 构造客户端（生产路径）。
 * 仅做组装 + 委托给 `createGitHubClient`；不在测试中覆盖（不打真实网络）。
 */
export function createGitHubClientFromToken(token: string): GitHubPort {
  const octokit = new Octokit({ auth: token });
  return createGitHubClient(octokit);
}
