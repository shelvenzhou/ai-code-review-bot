import { describe, expect, test } from "bun:test";
import {
  CATEGORIES,
  type Config,
  ConfigSchema,
  type Finding,
  FindingSchema,
  type ReviewResult,
  ReviewResultSchema,
  SEVERITIES,
} from "../../../src/core/contracts.ts";

describe("contracts schemas", () => {
  const validFinding: Finding = {
    file: "src/foo.ts",
    line: 12,
    severity: "high",
    category: "correctness",
    title: "Possible null dereference",
    description: "`user` may be undefined here.",
    confidence: 0.8,
  };

  test("FindingSchema accepts a valid finding (optional fields omitted)", () => {
    expect(FindingSchema.parse(validFinding)).toEqual(validFinding);
  });

  test("FindingSchema rejects confidence out of [0,1]", () => {
    expect(() => FindingSchema.parse({ ...validFinding, confidence: 1.5 })).toThrow();
  });

  test("FindingSchema rejects unknown severity/category", () => {
    expect(() => FindingSchema.parse({ ...validFinding, severity: "blocker" })).toThrow();
  });

  test("ConfigSchema validates a full config", () => {
    const cfg: Config = {
      model: "gpt-4.1",
      categories: [...CATEGORIES],
      ignoreGlobs: ["**/*.lock"],
      maxFiles: 50,
      maxDiffBytes: 200_000,
      tokenBudget: 100_000,
      thresholds: { postConfidence: 0.6, blockSeverity: "critical", blockConfidence: 0.85 },
      commentLanguage: "en",
      skipLabel: "skip-ai-review",
    };
    expect(ConfigSchema.parse(cfg)).toEqual(cfg);
  });

  test("ReviewResultSchema validates a result with full stats", () => {
    const result: ReviewResult = {
      pr: "octo/repo#1",
      commitSha: "abc123",
      findings: [validFinding],
      summary: "1 finding.",
      stats: {
        bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
        byCategory: { correctness: 1, security: 0, maintainability: 0, performance: 0 },
        filesReviewed: 1,
        filesSkipped: 0,
      },
      status: "pass",
    };
    expect(ReviewResultSchema.parse(result)).toEqual(result);
  });

  test("enums are exhaustive constants", () => {
    expect(SEVERITIES).toEqual(["critical", "high", "medium", "low"]);
    expect(CATEGORIES).toEqual(["correctness", "security", "maintainability", "performance"]);
  });
});
