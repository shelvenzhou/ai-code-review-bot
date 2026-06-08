import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "../../../src/core/config.ts";
import { CATEGORIES, type Config, ConfigSchema } from "../../../src/core/contracts.ts";

const NO_ENV: Record<string, string | undefined> = {};

describe("DEFAULT_CONFIG", () => {
  test("matches the spec'd defaults exactly", () => {
    expect(DEFAULT_CONFIG).toEqual({
      model: "gpt-4o",
      categories: ["correctness", "security", "maintainability", "performance"],
      ignoreGlobs: [],
      maxFiles: 50,
      maxDiffBytes: 200_000,
      tokenBudget: 100_000,
      thresholds: { postConfidence: 0.6, blockSeverity: "critical", blockConfidence: 0.85 },
      commentLanguage: "en",
      skipLabel: "skip-ai-review",
    } satisfies Config);
  });

  test("passes ConfigSchema", () => {
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  test("categories cover all known categories", () => {
    expect(DEFAULT_CONFIG.categories).toEqual([...CATEGORIES]);
  });
});

describe("loadConfig — base behavior", () => {
  test("loadConfig({}) returns DEFAULT_CONFIG", () => {
    expect(loadConfig(NO_ENV)).toEqual(DEFAULT_CONFIG);
  });

  test("loadConfig({}, undefined) returns DEFAULT_CONFIG", () => {
    expect(loadConfig(NO_ENV, undefined)).toEqual(DEFAULT_CONFIG);
  });

  test("returned config is a fresh object (not the same reference as DEFAULT_CONFIG)", () => {
    const cfg = loadConfig(NO_ENV);
    expect(cfg).not.toBe(DEFAULT_CONFIG);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig — env overrides", () => {
  test("OPENAI_MODEL overrides model", () => {
    const cfg = loadConfig({ OPENAI_MODEL: "gpt-4o-mini" });
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, model: "gpt-4o-mini" });
  });

  test("empty-string env vars are treated as unset", () => {
    const cfg = loadConfig({ OPENAI_MODEL: "", AI_REVIEW_MAX_FILES: "" });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  test("AI_REVIEW_MAX_FILES parses as an int and overrides maxFiles", () => {
    const cfg = loadConfig({ AI_REVIEW_MAX_FILES: "10" });
    expect(cfg.maxFiles).toBe(10);
  });

  test("AI_REVIEW_MAX_FILES tolerates surrounding non-numeric suffix via parseInt", () => {
    // Number.parseInt("12abc", 10) === 12 — documents the parsing behavior explicitly.
    const cfg = loadConfig({ AI_REVIEW_MAX_FILES: "12abc" });
    expect(cfg.maxFiles).toBe(12);
  });

  test("AI_REVIEW_MAX_FILES rejects NaN-producing values (throws)", () => {
    expect(() => loadConfig({ AI_REVIEW_MAX_FILES: "not-a-number" })).toThrow();
  });

  test("AI_REVIEW_COMMENT_LANGUAGE overrides commentLanguage", () => {
    const cfg = loadConfig({ AI_REVIEW_COMMENT_LANGUAGE: "zh" });
    expect(cfg.commentLanguage).toBe("zh");
  });

  test("AI_REVIEW_SKIP_LABEL overrides skipLabel", () => {
    const cfg = loadConfig({ AI_REVIEW_SKIP_LABEL: "no-ai-review" });
    expect(cfg.skipLabel).toBe("no-ai-review");
  });
});

describe("loadConfig — fileOverrides merge", () => {
  test("overrides ignoreGlobs from fileOverrides", () => {
    const cfg = loadConfig(NO_ENV, { ignoreGlobs: ["**/*.lock", "dist/**"] });
    expect(cfg.ignoreGlobs).toEqual(["**/*.lock", "dist/**"]);
    // unrelated keys remain default
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
  });

  test("overrides thresholds from fileOverrides (whole sub-object, shallow merge)", () => {
    const cfg = loadConfig(NO_ENV, {
      thresholds: { postConfidence: 0.5, blockSeverity: "high", blockConfidence: 0.7 },
    });
    expect(cfg.thresholds).toEqual({
      postConfidence: 0.5,
      blockSeverity: "high",
      blockConfidence: 0.7,
    });
  });

  test("overrides maxFiles and model together", () => {
    const cfg = loadConfig(NO_ENV, { maxFiles: 5, model: "gpt-4o" });
    expect(cfg.maxFiles).toBe(5);
    expect(cfg.model).toBe("gpt-4o");
  });

  test("ignores unknown top-level keys", () => {
    const cfg = loadConfig(NO_ENV, { totallyUnknownKey: "xyz", maxFiles: 7 });
    expect(cfg.maxFiles).toBe(7);
    expect(cfg).not.toHaveProperty("totallyUnknownKey");
  });

  test("ignores non-plain-object fileOverrides (array)", () => {
    expect(loadConfig(NO_ENV, ["not", "an", "object"])).toEqual(DEFAULT_CONFIG);
  });

  test("ignores non-plain-object fileOverrides (null)", () => {
    expect(loadConfig(NO_ENV, null)).toEqual(DEFAULT_CONFIG);
  });

  test("ignores non-plain-object fileOverrides (string)", () => {
    expect(loadConfig(NO_ENV, "not-an-object")).toEqual(DEFAULT_CONFIG);
  });

  test("ignores non-plain-object fileOverrides (number)", () => {
    expect(loadConfig(NO_ENV, 42)).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig — precedence: env beats fileOverrides beats defaults", () => {
  test("env model wins over fileOverrides model", () => {
    const cfg = loadConfig({ OPENAI_MODEL: "from-env" }, { model: "from-file" });
    expect(cfg.model).toBe("from-env");
  });

  test("env maxFiles wins over fileOverrides maxFiles", () => {
    const cfg = loadConfig({ AI_REVIEW_MAX_FILES: "3" }, { maxFiles: 99 });
    expect(cfg.maxFiles).toBe(3);
  });

  test("fileOverrides value used when env is absent", () => {
    const cfg = loadConfig(NO_ENV, { commentLanguage: "zh" });
    expect(cfg.commentLanguage).toBe("zh");
  });

  test("fileOverrides + env combine across different keys", () => {
    const cfg = loadConfig({ OPENAI_MODEL: "from-env" }, { ignoreGlobs: ["*.gen.ts"] });
    expect(cfg.model).toBe("from-env");
    expect(cfg.ignoreGlobs).toEqual(["*.gen.ts"]);
  });
});

describe("loadConfig — validation failures", () => {
  test("throws on invalid commentLanguage from fileOverrides", () => {
    expect(() => loadConfig(NO_ENV, { commentLanguage: "fr" })).toThrow();
  });

  test("throws on invalid commentLanguage from env", () => {
    expect(() => loadConfig({ AI_REVIEW_COMMENT_LANGUAGE: "fr" })).toThrow();
  });

  test("throws on maxFiles of 0 (must be positive) from fileOverrides", () => {
    expect(() => loadConfig(NO_ENV, { maxFiles: 0 })).toThrow();
  });

  test("throws on maxFiles of '0' from env (parses to 0, fails positive check)", () => {
    expect(() => loadConfig({ AI_REVIEW_MAX_FILES: "0" })).toThrow();
  });

  test("error message includes the underlying zod message", () => {
    expect(() => loadConfig(NO_ENV, { commentLanguage: "fr" })).toThrow(/invalid config/);
  });

  test("throws on negative maxFiles", () => {
    expect(() => loadConfig(NO_ENV, { maxFiles: -1 })).toThrow();
  });

  test("throws on wrong-shaped thresholds (missing field)", () => {
    expect(() => loadConfig(NO_ENV, { thresholds: { postConfidence: 0.5 } as unknown })).toThrow();
  });
});
