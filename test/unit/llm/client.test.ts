import { describe, expect, test } from "bun:test";
import type { Config, Finding, ReviewUnit } from "../../../src/core/contracts.ts";
import { createOpenAILLM, type OpenAILike } from "../../../src/llm/client.ts";

/* ───────────────────────── fixtures / fakes ─────────────────────────
 * CRITICAL: no real network — `OpenAILike` is faked end-to-end.
 */

const UNIT: ReviewUnit = {
  file: "src/foo.ts",
  patch: "@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = unsafeEval(input);\n",
};

const MODEL = "gpt-4.1-mini";

function pickCfg(
  overrides: Partial<Pick<Config, "model" | "categories" | "commentLanguage">> = {},
): Pick<Config, "model" | "categories" | "commentLanguage"> {
  return {
    model: MODEL,
    categories: ["correctness", "security", "maintainability", "performance"],
    commentLanguage: "en",
    ...overrides,
  };
}

/** Strict-shaped raw finding as the model would emit it (nullable optional fields present). */
interface RawStrictFinding {
  file: string;
  line: number;
  endLine: number | null;
  severity: "critical" | "high" | "medium" | "low";
  category: "correctness" | "security" | "maintainability" | "performance";
  title: string;
  description: string;
  suggestion: string | null;
  confidence: number;
}

/** Builds a fake `OpenAILike` that returns a canned structured-output JSON string. */
function fakeClientReturning(
  findings: readonly RawStrictFinding[],
  opts: { refusal?: string | null; content?: string | null; noChoices?: boolean } = {},
): { client: OpenAILike; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: OpenAILike = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          if (opts.noChoices === true) {
            return { choices: [] };
          }
          const content = opts.content !== undefined ? opts.content : JSON.stringify({ findings });
          return {
            choices: [
              {
                message: {
                  content,
                  refusal: opts.refusal ?? null,
                },
              },
            ],
          };
        },
      },
    },
  };
  return { client, calls };
}

/** A throwing fake `OpenAILike`, to test error wrapping. */
function fakeClientThrowing(error: unknown): OpenAILike {
  return {
    chat: {
      completions: {
        create: async () => {
          throw error;
        },
      },
    },
  };
}

/* ───────────────────────── review(): happy paths ───────────────────────── */

describe("createOpenAILLM().review", () => {
  test("returns Finding[] parsed from the structured response", async () => {
    const raw: RawStrictFinding = {
      file: "src/foo.ts",
      line: 2,
      endLine: null,
      severity: "high",
      category: "security",
      title: "Untrusted input passed to eval",
      description: "`unsafeEval(input)` executes attacker-controlled input.",
      suggestion: "Avoid eval; parse the input safely instead.",
      confidence: 0.9,
    };
    const { client, calls } = fakeClientReturning([raw]);
    const llm = createOpenAILLM(client, MODEL);

    const findings = await llm.review(UNIT, pickCfg());

    expect(findings).toHaveLength(1);
    const expected: Finding = {
      file: "src/foo.ts",
      line: 2,
      severity: "high",
      category: "security",
      title: "Untrusted input passed to eval",
      description: "`unsafeEval(input)` executes attacker-controlled input.",
      suggestion: "Avoid eval; parse the input safely instead.",
      confidence: 0.9,
    };
    expect(findings[0]).toEqual(expected);

    // sanity: the fake was actually invoked with the requested model
    expect(calls).toHaveLength(1);
    expect((calls[0] as { model: string }).model).toBe(MODEL);
  });

  test("normalizes null endLine/suggestion to undefined (and keeps non-null endLine)", async () => {
    const withNulls: RawStrictFinding = {
      file: "src/foo.ts",
      line: 3,
      endLine: null,
      severity: "low",
      category: "maintainability",
      title: "Unclear name",
      description: "Rename `x`.",
      suggestion: null,
      confidence: 0.5,
    };
    const withEndLine: RawStrictFinding = {
      file: "src/foo.ts",
      line: 5,
      endLine: 8,
      severity: "medium",
      category: "performance",
      title: "Quadratic loop",
      description: "Nested loop over the same collection.",
      suggestion: "Hoist the inner lookup into a Map.",
      confidence: 0.7,
    };
    const { client } = fakeClientReturning([withNulls, withEndLine]);
    const llm = createOpenAILLM(client, MODEL);

    const findings = await llm.review(UNIT, pickCfg());

    expect(findings).toHaveLength(2);
    expect(findings[0]?.endLine).toBeUndefined();
    expect(findings[0]?.suggestion).toBeUndefined();
    expect("endLine" in (findings[0] as object)).toBe(false);
    expect("suggestion" in (findings[0] as object)).toBe(false);

    expect(findings[1]?.endLine).toBe(8);
    expect(findings[1]?.suggestion).toBe("Hoist the inner lookup into a Map.");
  });

  test("defaults file to unit.file when the model returns an empty file path", async () => {
    const raw: RawStrictFinding = {
      file: "",
      line: 1,
      endLine: null,
      severity: "critical",
      category: "correctness",
      title: "Off-by-one",
      description: "Loop bound is wrong.",
      suggestion: null,
      confidence: 0.95,
    };
    const { client } = fakeClientReturning([raw]);
    const llm = createOpenAILLM(client, MODEL);

    const [finding] = await llm.review(UNIT, pickCfg());

    expect(finding?.file).toBe(UNIT.file);
  });

  describe("clamps confidence into [0, 1]", () => {
    const cases: Array<{ name: string; input: number; expected: number }> = [
      { name: "above range", input: 1.5, expected: 1 },
      { name: "below range", input: -0.3, expected: 0 },
      { name: "in range — passes through unchanged", input: 0.42, expected: 0.42 },
      { name: "exactly 0", input: 0, expected: 0 },
      { name: "exactly 1", input: 1, expected: 1 },
    ];

    for (const { name, input, expected } of cases) {
      test(name, async () => {
        const raw: RawStrictFinding = {
          file: "src/foo.ts",
          line: 1,
          endLine: null,
          severity: "low",
          category: "correctness",
          title: "t",
          description: "d",
          suggestion: null,
          confidence: input,
        };
        const { client } = fakeClientReturning([raw]);
        const llm = createOpenAILLM(client, MODEL);

        const [finding] = await llm.review(UNIT, pickCfg());

        expect(finding?.confidence).toBe(expected);
      });
    }
  });

  test("filters out findings whose category is not in cfg.categories", async () => {
    const correctness: RawStrictFinding = {
      file: "src/foo.ts",
      line: 1,
      endLine: null,
      severity: "high",
      category: "correctness",
      title: "Bug",
      description: "d",
      suggestion: null,
      confidence: 0.8,
    };
    const security: RawStrictFinding = {
      file: "src/foo.ts",
      line: 2,
      endLine: null,
      severity: "high",
      category: "security",
      title: "Vuln",
      description: "d",
      suggestion: null,
      confidence: 0.8,
    };
    const performance: RawStrictFinding = {
      file: "src/foo.ts",
      line: 3,
      endLine: null,
      severity: "low",
      category: "performance",
      title: "Slow",
      description: "d",
      suggestion: null,
      confidence: 0.6,
    };
    const { client } = fakeClientReturning([correctness, security, performance]);
    const llm = createOpenAILLM(client, MODEL);

    const findings = await llm.review(UNIT, pickCfg({ categories: ["correctness", "security"] }));

    expect(findings.map((f) => f.category).sort()).toEqual(["correctness", "security"]);
  });

  test("returns an empty array when the model reports no findings", async () => {
    const { client } = fakeClientReturning([]);
    const llm = createOpenAILLM(client, MODEL);

    const findings = await llm.review(UNIT, pickCfg());

    expect(findings).toEqual([]);
  });
});

/* ───────────────────────── error wrapping ───────────────────────── */

describe("createOpenAILLM().review — error handling", () => {
  test("wraps a thrown API error into a domain Error", async () => {
    const llm = createOpenAILLM(fakeClientThrowing(new Error("network down")), MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(/OpenAI request failed/);
  });

  test("wraps a non-Error throw (unknown) into a domain Error", async () => {
    const llm = createOpenAILLM(fakeClientThrowing("boom"), MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(Error);
  });

  test("throws a domain Error when the model refuses", async () => {
    const { client } = fakeClientReturning([], { refusal: "I can't help with that." });
    const llm = createOpenAILLM(client, MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(/refused/);
  });

  test("throws a domain Error when there are no choices", async () => {
    const { client } = fakeClientReturning([], { noChoices: true });
    const llm = createOpenAILLM(client, MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(/no choices/);
  });

  test("throws a domain Error when content is null", async () => {
    const { client } = fakeClientReturning([], { content: null });
    const llm = createOpenAILLM(client, MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(/empty content/);
  });

  test("throws a domain Error when content is not valid JSON", async () => {
    const { client } = fakeClientReturning([], { content: "not json {" });
    const llm = createOpenAILLM(client, MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(/not valid JSON/);
  });

  test("throws a domain Error when content does not match the expected schema", async () => {
    const { client } = fakeClientReturning([], {
      content: JSON.stringify({ findings: [{ totally: "wrong shape" }] }),
    });
    const llm = createOpenAILLM(client, MODEL);

    await expect(llm.review(UNIT, pickCfg())).rejects.toThrow(/did not match the expected schema/);
  });
});
