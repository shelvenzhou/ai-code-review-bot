import { describe, expect, test } from "bun:test";
import type { Category, Config, ReviewUnit } from "../../../src/core/contracts.ts";
import { buildPrompt, CATEGORY_RUBRIC, languageInstruction } from "../../../src/llm/prompt.ts";

/* ───────────────────────── fixtures ───────────────────────── */

const UNIT: ReviewUnit = {
  file: "src/foo.ts",
  patch: "@@ -1,3 +1,3 @@\n-const x = 1;\n+const x = unsafeEval(input);\n context line\n",
};

function pickCfg(
  overrides: Partial<Pick<Config, "categories" | "commentLanguage">> = {},
): Pick<Config, "categories" | "commentLanguage"> {
  return {
    categories: ["correctness", "security", "maintainability", "performance"],
    commentLanguage: "en",
    ...overrides,
  };
}

/* ───────────────────────── buildPrompt ───────────────────────── */

describe("buildPrompt", () => {
  test("user message includes the file path and the unit's patch verbatim", () => {
    const { user } = buildPrompt(UNIT, pickCfg());
    expect(user).toContain(UNIT.file);
    expect(user).toContain(UNIT.patch);
  });

  test("system message frames a senior reviewer who reviews ONLY the provided diff", () => {
    const { system } = buildPrompt(UNIT, pickCfg());
    expect(system.toLowerCase()).toContain("senior code reviewer");
    expect(system.toLowerCase()).toContain("only");
    expect(system.toLowerCase()).toContain("diff");
  });

  test("system message documents the Finding fields agents must produce", () => {
    const { system } = buildPrompt(UNIT, pickCfg());
    for (const field of [
      "file",
      "line",
      "severity",
      "category",
      "title",
      "description",
      "suggestion",
      "confidence",
    ]) {
      expect(system).toContain(field);
    }
    // line anchoring requirement: must be visible / on the new-file side of the diff
    expect(system.toLowerCase()).toContain("new-file-side");
  });

  test("system message instructs to be precise and avoid nitpicks / false positives", () => {
    const { system } = buildPrompt(UNIT, pickCfg());
    expect(system.toLowerCase()).toContain("nitpick");
    expect(system.toLowerCase()).toContain("false positive");
  });

  describe("category rubric is restricted to ENABLED categories", () => {
    const allCategories: Category[] = ["correctness", "security", "maintainability", "performance"];

    test("includes rubric text for every enabled category, when all are enabled", () => {
      const { system } = buildPrompt(UNIT, pickCfg({ categories: allCategories }));
      for (const category of allCategories) {
        expect(system).toContain(CATEGORY_RUBRIC[category]);
      }
    });

    test("omits rubric text for categories that are NOT enabled", () => {
      const enabled: Category[] = ["security", "performance"];
      const { system } = buildPrompt(UNIT, pickCfg({ categories: enabled }));

      expect(system).toContain(CATEGORY_RUBRIC.security);
      expect(system).toContain(CATEGORY_RUBRIC.performance);
      expect(system).not.toContain(CATEGORY_RUBRIC.correctness);
      expect(system).not.toContain(CATEGORY_RUBRIC.maintainability);
    });

    test("a single enabled category yields rubric text for only that category", () => {
      const { system } = buildPrompt(UNIT, pickCfg({ categories: ["correctness"] }));

      expect(system).toContain(CATEGORY_RUBRIC.correctness);
      expect(system).not.toContain(CATEGORY_RUBRIC.security);
      expect(system).not.toContain(CATEGORY_RUBRIC.maintainability);
      expect(system).not.toContain(CATEGORY_RUBRIC.performance);
    });
  });

  describe("output language instruction", () => {
    test("English: system carries the languageInstruction for 'en'", () => {
      const { system } = buildPrompt(UNIT, pickCfg({ commentLanguage: "en" }));
      expect(system).toContain(languageInstruction("en"));
      expect(system).not.toContain(languageInstruction("zh"));
    });

    test("Chinese: system carries the languageInstruction for 'zh'", () => {
      const { system } = buildPrompt(UNIT, pickCfg({ commentLanguage: "zh" }));
      expect(system).toContain(languageInstruction("zh"));
      expect(system).not.toContain(languageInstruction("en"));
    });

    test("languageInstruction differs by language and names the target language", () => {
      expect(languageInstruction("en")).toContain("English");
      expect(languageInstruction("zh")).toContain("Chinese");
      expect(languageInstruction("en")).not.toEqual(languageInstruction("zh"));
    });
  });
});
