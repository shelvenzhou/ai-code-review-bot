/**
 * M4 diff（纯函数）：解析 GitHub 返回的 unified diff `patch` 文本为 `DiffHunk[]`，
 * 并判断新文件侧某行是否「可行内评论」（即出现在 diff 右侧：add 或 ctx）。
 *
 * 设计依据：docs/specs/03-tasks.md T4；契约见 src/core/contracts.ts（冻结，仅 import）。
 */
import type { DiffHunk, DiffLine, IsCommentableFn, ParsePatch } from "../core/contracts.ts";

/** 匹配 hunk 头：`@@ -oldStart[,oldLines] +newStart[,newLines] @@ optional context` */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析单个文件的 unified diff patch 文本为 hunks。
 *
 * - 行首 ` `（空格）= 上下文（ctx，新旧行号都推进）
 * - 行首 `+` = 新增（add，仅新行号推进）
 * - 行首 `-` = 删除（del，仅旧行号推进）
 * - 行首 `\` = "\ No newline at end of file" 等元信息标记，忽略
 * - `text` 不含上述前缀字符
 */
export const parsePatch = ((patch: string): DiffHunk[] => {
  if (patch.trim() === "") {
    return [];
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const rawLine of patch.split("\n")) {
    const headerMatch = HUNK_HEADER_RE.exec(rawLine);
    if (headerMatch !== null) {
      const oldStart = Number(headerMatch[1]);
      const oldLines = headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1;
      const newStart = Number(headerMatch[3]);
      const newLines = headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1;

      current = { oldStart, oldLines, newStart, newLines, lines: [] };
      hunks.push(current);
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }

    if (current === null) {
      // 头部之外的行（理论上不会出现在单文件 patch 中）：忽略
      continue;
    }

    if (rawLine.startsWith("\\")) {
      // "\ No newline at end of file" 等标记，忽略
      continue;
    }

    const prefix = rawLine.charAt(0);
    const text = rawLine.slice(1);

    let line: DiffLine;
    if (prefix === "+") {
      line = { kind: "add", newLine: newCursor, text };
      newCursor += 1;
    } else if (prefix === "-") {
      line = { kind: "del", oldLine: oldCursor, text };
      oldCursor += 1;
    } else if (prefix === " ") {
      line = { kind: "ctx", oldLine: oldCursor, newLine: newCursor, text };
      oldCursor += 1;
      newCursor += 1;
    } else {
      // 容错：没有前缀字符的空行按上下文处理（部分 diff 末尾会出现裸的空行）
      line = { kind: "ctx", oldLine: oldCursor, newLine: newCursor, text: rawLine };
      oldCursor += 1;
      newCursor += 1;
    }

    current.lines.push(line);
  }

  return hunks;
}) satisfies ParsePatch;

/**
 * 判断新文件侧 `line` 是否可行内评论：必须作为 add 或 ctx 出现在某个 hunk 的右侧
 * （GitHub 仅接受落在 diff 内、且位于新文件侧的行作为 inline comment 锚点）。
 * 删除行只有 oldLine、没有 newLine，因此天然不会匹配。
 */
export const isCommentable = ((line: number, hunks: DiffHunk[]): boolean => {
  for (const hunk of hunks) {
    for (const diffLine of hunk.lines) {
      if ((diffLine.kind === "add" || diffLine.kind === "ctx") && diffLine.newLine === line) {
        return true;
      }
    }
  }
  return false;
}) satisfies IsCommentableFn;
