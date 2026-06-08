/**
 * M3 — filter（纯函数）
 *
 * 把 PR 改动文件分成「可送评的 ReviewUnit」和「跳过的 SkippedFile（带原因）」。
 * 设计依据：docs/specs/02-design.md，工单见 docs/specs/03-tasks.md（T3）。
 *
 * 纯函数：无 I/O、无网络、无全局状态。
 */
import type {
  ChangedFile,
  Config,
  FilterFn,
  FilterResult,
  SkippedFile,
} from "../core/contracts.ts";

/* ───────────────────────── 跳过规则用到的静态表 ───────────────────────── */

/** basename 精确匹配的 lockfile 列表（规则 3）。 */
const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

/** 视为生成/第三方代码的目录前缀（路径片段，规则 4）。 */
const GENERATED_DIR_SEGMENTS: readonly string[] = ["dist", "build", "node_modules", "vendor"];

/** 视为生成/第三方代码的 basename glob（规则 4）。 */
const GENERATED_BASENAME_GLOBS: readonly string[] = ["*.min.js", "*.map", "*.snap"];

/* ───────────────────────── 小工具 ───────────────────────── */

/** 取路径最后一段（basename）。统一用 "/" 分隔（GitHub diff 路径恒为 "/"）。 */
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** 路径是否落在某个目录片段下（如 "dist/" 开头，或路径中含 "/dist/"）。 */
function isUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`);
}

/** UTF-8 字节长度（不依赖 Buffer，跨运行时通用）。 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 极简 glob → RegExp 编译器。
 *
 * 支持：
 * - `*`  匹配单个路径片段内的任意字符（不跨越 "/"）
 * - `**` 匹配任意字符，可跨越 "/"（含零个片段）
 * - 其余字符按字面量转义
 *
 * 仅实现到能覆盖本模块测试用例所需的程度，不追求完整 glob 语义
 * （例如不支持 `?`、字符集 `[abc]`、花括号 `{a,b}`）。
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === undefined) {
      break;
    }
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          // `**/`：匹配零个或多个完整路径片段（含各自的 "/"）
          pattern += "(?:.*/)?";
          i += 1;
        } else {
          // `**`（不接 "/"）：匹配任意内容，可跨越 "/"
          pattern += ".*";
        }
      } else {
        // 单个 `*`：片段内任意字符，不跨越 "/"
        pattern += "[^/]*";
        i += 1;
      }
    } else {
      pattern += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

const REGEXP_SPECIAL = new Set([".", "+", "?", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"]);

function escapeRegExpChar(ch: string): string {
  return REGEXP_SPECIAL.has(ch) ? `\\${ch}` : ch;
}

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/* ───────────────────────── 跳过原因判定（规则 1~6，顺序即优先级） ───────────────────────── */

/**
 * 对单个文件依次检查规则 1~5（不含 maxFiles 上限，那是整体阶段后处理）。
 * 返回命中的跳过原因；若全部规则都不命中则返回 `undefined`，文件可送评。
 */
function skipReasonFor(file: ChangedFile, cfg: Config): string | undefined {
  // 1. 无 patch（二进制 / 无 diff）
  if (file.patch === undefined || file.patch.length === 0) {
    return "binary or no patch";
  }

  // 2. 已删除文件
  if (file.status === "removed") {
    return "removed file";
  }

  // 3. lockfile（按 basename 精确匹配）
  if (LOCKFILE_BASENAMES.has(basename(file.path))) {
    return "lockfile";
  }

  // 4. 生成/第三方代码：目录前缀 或 basename glob
  if (
    GENERATED_DIR_SEGMENTS.some((dir) => isUnderDir(file.path, dir)) ||
    matchesAnyGlob(basename(file.path), GENERATED_BASENAME_GLOBS)
  ) {
    return "generated or vendored";
  }

  // 5. 命中 ignoreGlobs（对完整路径匹配）
  if (matchesAnyGlob(file.path, cfg.ignoreGlobs)) {
    return "matched ignore glob";
  }

  // 6. 超过单文件 diff 大小上限（按 UTF-8 字节）
  if (byteLength(file.patch) > cfg.maxDiffBytes) {
    return "diff too large";
  }

  return undefined;
}

/* ───────────────────────── 主函数 ───────────────────────── */

export const filter: FilterFn = (files, cfg) => {
  const units: FilterResult["units"] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    const reason = skipReasonFor(file, cfg);
    if (reason !== undefined) {
      skipped.push({ path: file.path, reason });
      continue;
    }
    // skipReasonFor 的规则 1 已确保通过校验的文件一定有非空 patch；
    // 这里再次窄化类型（而非断言），避免 `string | undefined`。
    const { patch } = file;
    if (patch === undefined) {
      skipped.push({ path: file.path, reason: "binary or no patch" });
      continue;
    }
    units.push({ file: file.path, patch });
  }

  // maxFiles 上限：保留前 N 个，其余移入 skipped
  if (units.length > cfg.maxFiles) {
    const overflow = units.splice(cfg.maxFiles);
    for (const unit of overflow) {
      skipped.push({ path: unit.file, reason: "exceeds maxFiles cap" });
    }
  }

  return { units, skipped };
};

export default filter;
