import { describe, expect, test } from "bun:test";
import { isCommentable, parsePatch } from "../../../src/diff/index.ts";

/** 真实风格的多 hunk patch：第一段改了函数体，第二段在文件末尾追加了新行。 */
const MULTI_HUNK_PATCH = [
  "@@ -1,5 +1,6 @@",
  " function add(a, b) {",
  "-  return a + b;",
  "+  // sum two numbers",
  "+  return a + b;",
  " }",
  " ",
  "@@ -10,3 +11,5 @@ export function main() {",
  " export function main() {",
  "-  console.log(add(1, 2));",
  "+  const result = add(1, 2);",
  "+  console.log(result);",
  "+  return result;",
  " }",
].join("\n");

const ADD_ONLY_PATCH = [
  "@@ -0,0 +1,3 @@",
  '+export const greeting = "hi";',
  "+",
  "+console.log(greeting);",
].join("\n");

const DELETE_ONLY_PATCH = [
  "@@ -1,3 +0,0 @@",
  '-export const greeting = "hi";',
  "-",
  "-console.log(greeting);",
].join("\n");

const NO_NEWLINE_PATCH = [
  "@@ -1,2 +1,2 @@",
  " line one",
  "-line two",
  "+line two!",
  "\\ No newline at end of file",
].join("\n");

describe("parsePatch", () => {
  test("parses a multi-hunk patch into hunks with correct headers", () => {
    const hunks = parsePatch(MULTI_HUNK_PATCH);

    expect(hunks).toHaveLength(2);

    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6 });
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 11, newLines: 5 });
  });

  test("assigns correct kinds and line numbers in the first hunk", () => {
    const [first] = parsePatch(MULTI_HUNK_PATCH);
    if (first === undefined) throw new Error("expected first hunk");

    // " function add(a, b) {" → ctx, old=1, new=1
    expect(first.lines[0]).toEqual({
      kind: "ctx",
      oldLine: 1,
      newLine: 1,
      text: "function add(a, b) {",
    });

    // "-  return a + b;" → del, old=2 (no newLine)
    expect(first.lines[1]).toEqual({
      kind: "del",
      oldLine: 2,
      text: "  return a + b;",
    });

    // "+  // sum two numbers" → add, new=2 (no oldLine)
    expect(first.lines[2]).toEqual({
      kind: "add",
      newLine: 2,
      text: "  // sum two numbers",
    });

    // "+  return a + b;" → add, new=3
    expect(first.lines[3]).toEqual({
      kind: "add",
      newLine: 3,
      text: "  return a + b;",
    });

    // " }" → ctx, old=3, new=4
    expect(first.lines[4]).toEqual({
      kind: "ctx",
      oldLine: 3,
      newLine: 4,
      text: "}",
    });

    // " " (trailing context blank line) → ctx, old=4, new=5
    expect(first.lines[5]).toEqual({
      kind: "ctx",
      oldLine: 4,
      newLine: 5,
      text: "",
    });
  });

  test("continues counters independently per hunk based on its own header", () => {
    const [, second] = parsePatch(MULTI_HUNK_PATCH);
    if (second === undefined) throw new Error("expected second hunk");

    // " export function main() {" → ctx, old=10, new=11 (from header @@ -10,3 +11,5 @@)
    expect(second.lines[0]).toEqual({
      kind: "ctx",
      oldLine: 10,
      newLine: 11,
      text: "export function main() {",
    });

    // "-  console.log(add(1, 2));" → del, old=11
    expect(second.lines[1]).toEqual({
      kind: "del",
      oldLine: 11,
      text: "  console.log(add(1, 2));",
    });

    // "+  const result = add(1, 2);" → add, new=12
    expect(second.lines[2]).toEqual({
      kind: "add",
      newLine: 12,
      text: "  const result = add(1, 2);",
    });

    // "+  console.log(result);" → add, new=13
    expect(second.lines[3]).toEqual({
      kind: "add",
      newLine: 13,
      text: "  console.log(result);",
    });

    // "+  return result;" → add, new=14
    expect(second.lines[4]).toEqual({
      kind: "add",
      newLine: 14,
      text: "  return result;",
    });

    // " }" → ctx, old=12, new=15
    expect(second.lines[5]).toEqual({
      kind: "ctx",
      oldLine: 12,
      newLine: 15,
      text: "}",
    });
  });

  test("parses an add-only patch (header with ,0 old range defaulting via explicit 0)", () => {
    const hunks = parsePatch(ADD_ONLY_PATCH);
    expect(hunks).toHaveLength(1);

    const [hunk] = hunks;
    if (hunk === undefined) throw new Error("expected hunk");

    expect(hunk).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 });
    expect(hunk.lines).toHaveLength(3);
    for (const line of hunk.lines) {
      expect(line.kind).toBe("add");
      expect(line.oldLine).toBeUndefined();
    }
    expect(hunk.lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
    expect(hunk.lines.map((l) => l.text)).toEqual([
      'export const greeting = "hi";',
      "",
      "console.log(greeting);",
    ]);
  });

  test("parses a delete-only patch", () => {
    const hunks = parsePatch(DELETE_ONLY_PATCH);
    expect(hunks).toHaveLength(1);

    const [hunk] = hunks;
    if (hunk === undefined) throw new Error("expected hunk");

    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 });
    expect(hunk.lines).toHaveLength(3);
    for (const line of hunk.lines) {
      expect(line.kind).toBe("del");
      expect(line.newLine).toBeUndefined();
    }
    expect(hunk.lines.map((l) => l.oldLine)).toEqual([1, 2, 3]);
  });

  test("ignores '\\ No newline at end of file' marker lines", () => {
    const hunks = parsePatch(NO_NEWLINE_PATCH);
    expect(hunks).toHaveLength(1);

    const [hunk] = hunks;
    if (hunk === undefined) throw new Error("expected hunk");

    // Marker line must not produce a DiffLine entry.
    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines.every((l) => !l.text.startsWith("\\"))).toBe(true);
  });

  test("defaults omitted ',count' in the header to 1", () => {
    const patch = ["@@ -5 +5 @@", " unchanged line"].join("\n");
    const [hunk] = parsePatch(patch);
    if (hunk === undefined) throw new Error("expected hunk");

    expect(hunk).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  test.each<[string, string]>([
    ["empty string", ""],
    ["whitespace only (spaces)", "   "],
    ["whitespace only (newlines)", "\n\n  \n"],
  ])("returns [] for %s", (_label, input) => {
    expect(parsePatch(input)).toEqual([]);
  });
});

/**
 * Purpose-built two-hunk patch for isCommentable. Old- and new-side ranges are chosen
 * far apart (50s/100s vs. 1s/9-11) so that an old-side line number can NEVER coincide
 * with a new-side line number — making "deleted line's old position is not commentable"
 * unambiguous (it can't accidentally match some unrelated add/ctx newLine).
 *
 * Resulting structure (see parsePatch behavior verified in the suite above):
 *   Hunk 1 "@@ -50,4 +1,2 @@":
 *     ctx  old=50 new=1  "kept-1"
 *     del  old=51        "doomed-51"
 *     del  old=52        "doomed-52"
 *     ctx  old=53 new=2  "kept-2"
 *   Hunk 2 "@@ -100,2 +9,3 @@":
 *     ctx  old=100 new=9   "kept-9"
 *     add        new=10   "added-10"
 *     ctx  old=101 new=11  "kept-11"
 */
const ANCHOR_PATCH = [
  "@@ -50,4 +1,2 @@",
  " kept-1",
  "-doomed-51",
  "-doomed-52",
  " kept-2",
  "@@ -100,2 +9,3 @@",
  " kept-9",
  "+added-10",
  " kept-11",
].join("\n");

describe("isCommentable", () => {
  const hunks = parsePatch(ANCHOR_PATCH);

  test.each<[string, number, boolean]>([
    ["a context line in the first hunk (new=1) is commentable", 1, true],
    ["a context line in the first hunk (new=2) is commentable", 2, true],
    ["an added line in the SECOND hunk (new=10) is commentable", 10, true],
    ["a context line in the SECOND hunk (new=11) is commentable", 11, true],
    ["the old-side position of a deleted line (old=51) is not commentable", 51, false],
    ["the old-side position of a deleted line (old=52) is not commentable", 52, false],
    ["a line not present in any hunk is not commentable", 999, false],
    ["line 0, outside any hunk, is not commentable", 0, false],
  ])("%s", (_label, line, expected) => {
    expect(isCommentable(line, hunks)).toBe(expected);
  });

  test("deleted lines carry only oldLine (never newLine), so they can't satisfy a RIGHT-side query", () => {
    const deletedLines = hunks[0]?.lines.filter((l) => l.kind === "del") ?? [];
    expect(deletedLines).toHaveLength(2);
    expect(deletedLines.map((l) => l.oldLine)).toEqual([51, 52]);
    for (const del of deletedLines) {
      expect(del.newLine).toBeUndefined();
    }
  });

  test("returns false for any line when there are no hunks", () => {
    expect(isCommentable(1, [])).toBe(false);
  });
});
