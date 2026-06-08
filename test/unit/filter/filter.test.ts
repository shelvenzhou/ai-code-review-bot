import { describe, expect, test } from "bun:test";
import type { ChangedFile, Config } from "../../../src/core/contracts.ts";
import { filter } from "../../../src/filter/index.ts";

/* ───────────────────────── fixtures ───────────────────────── */

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "gpt-4.1",
    categories: ["correctness", "security", "maintainability", "performance"],
    ignoreGlobs: [],
    maxFiles: 50,
    maxDiffBytes: 200_000,
    tokenBudget: 100_000,
    thresholds: { postConfidence: 0.6, blockSeverity: "critical", blockConfidence: 0.85 },
    commentLanguage: "en",
    skipLabel: "skip-ai-review",
    ...overrides,
  };
}

function makeFile(overrides: Partial<ChangedFile> & { path: string }): ChangedFile {
  return {
    status: "modified",
    patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}

/* ───────────────────────── 表驱动：跳过原因 + 正常通过 ───────────────────────── */

describe("filter — skip reasons (priority order)", () => {
  const cases: Array<{
    name: string;
    file: ChangedFile;
    cfg?: Partial<Config>;
    expectedReason: string;
  }> = [
    {
      name: "rule 1: no patch (binary)",
      file: makeFile({ path: "assets/logo.png", patch: undefined }),
      expectedReason: "binary or no patch",
    },
    {
      name: "rule 1: empty patch string treated as no patch",
      file: makeFile({ path: "assets/blob.bin", patch: "" }),
      expectedReason: "binary or no patch",
    },
    {
      name: "rule 2: removed file",
      file: makeFile({ path: "src/old.ts", status: "removed" }),
      expectedReason: "removed file",
    },
    {
      name: "rule 3: lockfile (bun.lock)",
      file: makeFile({ path: "bun.lock" }),
      expectedReason: "lockfile",
    },
    {
      name: "rule 3: lockfile nested (package-lock.json)",
      file: makeFile({ path: "packages/api/package-lock.json" }),
      expectedReason: "lockfile",
    },
    {
      name: "rule 3: lockfile (pnpm-lock.yaml)",
      file: makeFile({ path: "pnpm-lock.yaml" }),
      expectedReason: "lockfile",
    },
    {
      name: "rule 4: generated/vendored — under dist/",
      file: makeFile({ path: "dist/index.js" }),
      expectedReason: "generated or vendored",
    },
    {
      name: "rule 4: generated/vendored — under nested node_modules/",
      file: makeFile({ path: "packages/app/node_modules/lib/index.js" }),
      expectedReason: "generated or vendored",
    },
    {
      name: "rule 4: generated/vendored — *.min.js basename",
      file: makeFile({ path: "public/js/app.min.js" }),
      expectedReason: "generated or vendored",
    },
    {
      name: "rule 4: generated/vendored — *.map basename",
      file: makeFile({ path: "public/js/app.js.map" }),
      expectedReason: "generated or vendored",
    },
    {
      name: "rule 4: generated/vendored — *.snap basename",
      file: makeFile({ path: "test/__snapshots__/app.test.ts.snap" }),
      expectedReason: "generated or vendored",
    },
    {
      name: "rule 5: matches ignoreGlobs (literal)",
      file: makeFile({ path: "docs/CHANGELOG.md" }),
      cfg: { ignoreGlobs: ["docs/CHANGELOG.md"] },
      expectedReason: "matched ignore glob",
    },
    {
      name: "rule 5: matches ignoreGlobs (single * within segment)",
      file: makeFile({ path: "src/generated/foo.ts" }),
      cfg: { ignoreGlobs: ["src/generated/*.ts"] },
      expectedReason: "matched ignore glob",
    },
    {
      name: "rule 5: matches ignoreGlobs (** across segments)",
      file: makeFile({ path: "src/foo/bar/baz.gen.ts" }),
      cfg: { ignoreGlobs: ["**/*.gen.ts"] },
      expectedReason: "matched ignore glob",
    },
    {
      name: "rule 6: oversized diff (UTF-8 byte length)",
      file: makeFile({ path: "src/big.ts", patch: "x".repeat(101) }),
      cfg: { maxDiffBytes: 100 },
      expectedReason: "diff too large",
    },
    {
      name: "priority: removed beats lockfile-looking name",
      file: makeFile({ path: "yarn.lock", status: "removed" }),
      expectedReason: "removed file",
    },
    {
      name: "priority: lockfile beats ignoreGlobs / oversized",
      file: makeFile({ path: "Cargo.lock", patch: "x".repeat(1000) }),
      cfg: { ignoreGlobs: ["**/*"], maxDiffBytes: 1 },
      expectedReason: "lockfile",
    },
    {
      name: "priority: generated/vendored beats ignoreGlobs",
      file: makeFile({ path: "dist/bundle.js" }),
      cfg: { ignoreGlobs: ["**/*"] },
      // would also match "**/*" but generated check (rule 4) comes first
      expectedReason: "generated or vendored",
    },
  ];

  for (const { name, file, cfg, expectedReason } of cases) {
    test(name, () => {
      const result = filter([file], makeConfig(cfg));
      expect(result.units).toEqual([]);
      expect(result.skipped).toEqual([{ path: file.path, reason: expectedReason }]);
    });
  }

  test("normal file passes through as a ReviewUnit", () => {
    const file = makeFile({ path: "src/feature.ts", patch: "@@ -1,2 +1,3 @@\n context\n+added\n" });
    const result = filter([file], makeConfig());
    expect(result.skipped).toEqual([]);
    expect(result.units).toEqual([{ file: "src/feature.ts", patch: file.patch as string }]);
  });

  test("added and renamed files with patches pass through", () => {
    const added = makeFile({ path: "src/new.ts", status: "added" });
    const renamed = makeFile({
      path: "src/renamed.ts",
      status: "renamed",
      previousPath: "src/old-name.ts",
    });
    const result = filter([added, renamed], makeConfig());
    expect(result.skipped).toEqual([]);
    expect(result.units.map((u) => u.file)).toEqual(["src/new.ts", "src/renamed.ts"]);
  });
});

/* ───────────────────────── maxFiles cap ───────────────────────── */

describe("filter — maxFiles cap", () => {
  test("keeps the first maxFiles units, moves the rest to skipped with 'exceeds maxFiles cap'", () => {
    const files = [
      makeFile({ path: "src/a.ts" }),
      makeFile({ path: "src/b.ts" }),
      makeFile({ path: "src/c.ts" }),
      makeFile({ path: "src/d.ts" }),
    ];
    const result = filter(files, makeConfig({ maxFiles: 2 }));

    expect(result.units.map((u) => u.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.skipped).toEqual([
      { path: "src/c.ts", reason: "exceeds maxFiles cap" },
      { path: "src/d.ts", reason: "exceeds maxFiles cap" },
    ]);
  });

  test("maxFiles cap applies after other skip rules removed files", () => {
    const files = [
      makeFile({ path: "src/a.ts" }),
      makeFile({ path: "bun.lock" }), // skipped as lockfile, doesn't count toward cap
      makeFile({ path: "src/b.ts" }),
      makeFile({ path: "src/c.ts" }),
    ];
    const result = filter(files, makeConfig({ maxFiles: 2 }));

    expect(result.units.map((u) => u.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.skipped).toEqual([
      { path: "bun.lock", reason: "lockfile" },
      { path: "src/c.ts", reason: "exceeds maxFiles cap" },
    ]);
  });

  test("does not trigger when surviving units equal maxFiles", () => {
    const files = [makeFile({ path: "src/a.ts" }), makeFile({ path: "src/b.ts" })];
    const result = filter(files, makeConfig({ maxFiles: 2 }));

    expect(result.units.map((u) => u.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.skipped).toEqual([]);
  });
});

/* ───────────────────────── empty input ───────────────────────── */

describe("filter — empty input", () => {
  test("returns empty units and skipped for empty file list", () => {
    const result = filter([], makeConfig());
    expect(result).toEqual({ units: [], skipped: [] });
  });
});
