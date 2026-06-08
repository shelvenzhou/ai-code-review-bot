import { describe, expect, test } from "bun:test";
import { extractPrNumber, resolvePrRefFromActionEnv } from "../../../src/entrypoints/action.ts";
import { parsePrRef } from "../../../src/entrypoints/cli.ts";

describe("parsePrRef (CLI)", () => {
  test("parses owner/repo#number", () => {
    expect(parsePrRef("octo/demo#7")).toEqual({ owner: "octo", repo: "demo", number: 7 });
  });

  test("trims surrounding whitespace", () => {
    expect(parsePrRef("  a/b#123  ")).toEqual({ owner: "a", repo: "b", number: 123 });
  });

  test.each([
    "",
    "octo/demo",
    "octo#7",
    "octo/demo#",
    "octo/demo#x",
  ])("rejects invalid ref %p", (spec) => {
    expect(() => parsePrRef(spec)).toThrow();
  });
});

describe("resolvePrRefFromActionEnv (Action)", () => {
  test("resolves from GITHUB_REPOSITORY + event payload", () => {
    const ref = resolvePrRefFromActionEnv(
      { GITHUB_REPOSITORY: "octo/demo" },
      { pull_request: { number: 42 } },
    );
    expect(ref).toEqual({ owner: "octo", repo: "demo", number: 42 });
  });

  test("throws on missing/invalid GITHUB_REPOSITORY", () => {
    expect(() => resolvePrRefFromActionEnv({}, { pull_request: { number: 1 } })).toThrow();
    expect(() =>
      resolvePrRefFromActionEnv({ GITHUB_REPOSITORY: "noslash" }, { pull_request: { number: 1 } }),
    ).toThrow();
  });

  test("throws when pull_request.number is absent", () => {
    expect(() => resolvePrRefFromActionEnv({ GITHUB_REPOSITORY: "o/r" }, {})).toThrow();
  });

  test("extractPrNumber handles missing/odd shapes", () => {
    expect(extractPrNumber({ pull_request: { number: 5 } })).toBe(5);
    expect(extractPrNumber({})).toBeUndefined();
    expect(extractPrNumber(null)).toBeUndefined();
    expect(extractPrNumber({ pull_request: { number: "5" } })).toBeUndefined();
  });
});
