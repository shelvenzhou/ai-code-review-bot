import { describe, expect, test } from "bun:test";
import type {
  Finding,
  RenderInput,
  ReviewResult,
  ReviewStats,
} from "../../../src/core/contracts.ts";
import { render } from "../../../src/render/index.ts";

/* ───────────────────────── fixtures ───────────────────────── */

const emptyStats: ReviewStats = {
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  byCategory: { correctness: 0, security: 0, maintainability: 0, performance: 0 },
  filesReviewed: 0,
  filesSkipped: 0,
};

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/foo.ts",
    line: 10,
    severity: "high",
    category: "correctness",
    title: "Possible null dereference",
    description: "`user` may be undefined here.",
    confidence: 0.8,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    pr: "octo/repo#42",
    commitSha: "abc123",
    findings: [],
    summary: "Looks mostly fine.",
    stats: emptyStats,
    status: "pass",
    ...overrides,
  };
}

function statsFor(findings: readonly Finding[]): ReviewStats {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory = { correctness: 0, security: 0, maintainability: 0, performance: 0 };
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byCategory[f.category] += 1;
  }
  return { bySeverity, byCategory, filesReviewed: 3, filesSkipped: 1 };
}

/* ───────────────────────── inlineComments ───────────────────────── */

describe("render — inlineComments", () => {
  test("produces one comment per inline finding with correct path/line", () => {
    const a = makeFinding({ file: "src/a.ts", line: 5, title: "Bug A" });
    const b = makeFinding({ file: "src/b.ts", line: 99, title: "Bug B", severity: "low" });
    const result = makeResult({ findings: [a, b], stats: statsFor([a, b]) });

    const out = render({ result, inlineFindings: [a, b] });

    expect(out.inlineComments).toHaveLength(2);
    expect(out.inlineComments[0]).toMatchObject({ path: "src/a.ts", line: 5 });
    expect(out.inlineComments[1]).toMatchObject({ path: "src/b.ts", line: 99 });
  });

  test("body contains severity, category, title and description", () => {
    const finding = makeFinding({
      severity: "critical",
      category: "security",
      title: "SQL injection",
      description: "User input is concatenated directly into the query.",
    });
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const [comment] = render({ result, inlineFindings: [finding] }).inlineComments;

    expect(comment).toBeDefined();
    expect(comment?.body).toContain("CRITICAL");
    expect(comment?.body).toContain("security");
    expect(comment?.body).toContain("SQL injection");
    expect(comment?.body).toContain("User input is concatenated directly into the query.");
  });

  test("body appends a Suggestion section, fenced as code when it looks like code", () => {
    const finding = makeFinding({
      title: "Off-by-one",
      suggestion: "for (let i = 0; i < arr.length; i++) {\n  use(arr[i]);\n}",
    });
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const [comment] = render({ result, inlineFindings: [finding] }).inlineComments;

    expect(comment?.body).toContain("Suggestion:");
    expect(comment?.body).toContain("```");
    expect(comment?.body).toContain("for (let i = 0; i < arr.length; i++)");
  });

  test("body appends a plain-text Suggestion section when it does not look like code", () => {
    const finding = makeFinding({
      title: "Unclear naming",
      suggestion: "Rename this variable to something more descriptive.",
    });
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const [comment] = render({ result, inlineFindings: [finding] }).inlineComments;

    expect(comment?.body).toContain("Suggestion:");
    expect(comment?.body).toContain("Rename this variable to something more descriptive.");
    expect(comment?.body).not.toContain("```");
  });

  test("body has no Suggestion section when suggestion is absent", () => {
    const finding = makeFinding({ title: "No suggestion here" });
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const [comment] = render({ result, inlineFindings: [finding] }).inlineComments;

    expect(comment?.body).not.toContain("Suggestion:");
  });

  test("empty inlineFindings → empty inlineComments array", () => {
    const result = makeResult();
    const out = render({ result, inlineFindings: [] });

    expect(out.inlineComments).toEqual([]);
  });
});

/* ───────────────────────── markdownSummary ───────────────────────── */

describe("render — markdownSummary", () => {
  test("contains the summary text and a stats section with counts", () => {
    const a = makeFinding({ severity: "critical", category: "security" });
    const b = makeFinding({ severity: "low", category: "performance" });
    const result = makeResult({
      summary: "Two issues found, one is critical.",
      findings: [a, b],
      stats: statsFor([a, b]),
    });

    const md = render({ result, inlineFindings: [a, b] }).markdownSummary;

    expect(md).toContain("Two issues found, one is critical.");
    expect(md).toContain("Stats:");
    expect(md).toContain("critical: 1");
    expect(md).toContain("low: 1");
    expect(md).toContain("security: 1");
    expect(md).toContain("performance: 1");
    expect(md).toContain("Files reviewed: 3");
    expect(md).toContain("Files skipped: 1");
  });

  test("lists findings that are NOT in inlineFindings under 'Findings not shown inline'", () => {
    const inline = makeFinding({ file: "src/a.ts", line: 1, title: "Inline one" });
    const unanchored = makeFinding({
      file: "src/b.ts",
      line: 200,
      title: "Unanchored one",
      severity: "medium",
      category: "maintainability",
    });
    const result = makeResult({
      findings: [inline, unanchored],
      stats: statsFor([inline, unanchored]),
    });

    const md = render({ result, inlineFindings: [inline] }).markdownSummary;

    expect(md).toContain("Findings not shown inline:");
    expect(md).toContain("src/b.ts:200");
    expect(md).toContain("[medium/maintainability]");
    expect(md).toContain("Unanchored one");
    // The inline one's text shouldn't appear in the unanchored list line
    expect(md).not.toContain("src/a.ts:1 [");
  });

  test("findings not in inlineFindings by reference are listed even if structurally equal", () => {
    const original = makeFinding({ file: "src/dup.ts", line: 7, title: "Duplicate-looking" });
    // structurally identical but a distinct object — must be treated as NOT inline
    const lookalike: Finding = { ...original };
    const result = makeResult({ findings: [original], stats: statsFor([original]) });

    const md = render({ result, inlineFindings: [lookalike] }).markdownSummary;

    expect(md).toContain("Findings not shown inline:");
    expect(md).toContain("src/dup.ts:7");
  });

  test("when every finding is inline, the unanchored list says so explicitly (non-empty, non-crashing)", () => {
    const finding = makeFinding();
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const md = render({ result, inlineFindings: [finding] }).markdownSummary;

    expect(md).toContain("Findings not shown inline:");
    expect(md).toContain("none");
  });
});

/* ───────────────────────── text ───────────────────────── */

describe("render — text", () => {
  test("groups all findings by severity (critical → high → medium → low) and includes status", () => {
    const critical = makeFinding({
      severity: "critical",
      title: "Crit issue",
      file: "src/c.ts",
      line: 1,
    });
    const high = makeFinding({ severity: "high", title: "High issue", file: "src/h.ts", line: 2 });
    const medium = makeFinding({
      severity: "medium",
      title: "Medium issue",
      file: "src/m.ts",
      line: 3,
    });
    const low = makeFinding({ severity: "low", title: "Low issue", file: "src/l.ts", line: 4 });
    const result = makeResult({
      findings: [low, medium, high, critical],
      stats: statsFor([low, medium, high, critical]),
      status: "fail",
    });

    const { text } = render({ result, inlineFindings: [] });

    const criticalIdx = text.indexOf("CRITICAL");
    const highIdx = text.indexOf("HIGH");
    const mediumIdx = text.indexOf("MEDIUM");
    const lowIdx = text.indexOf("LOW");

    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(criticalIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(mediumIdx);
    expect(mediumIdx).toBeLessThan(lowIdx);

    expect(text).toContain("src/c.ts:1");
    expect(text).toContain("Crit issue");
    expect(text).toContain("src/h.ts:2");
    expect(text).toContain("src/m.ts:3");
    expect(text).toContain("src/l.ts:4");
    expect(text).toContain("Status: FAIL");
  });

  test("each finding line includes path:line, category, title and description", () => {
    const finding = makeFinding({
      file: "src/x.ts",
      line: 17,
      category: "performance",
      title: "Quadratic loop",
      description: "Nested loops over the same collection.",
    });
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const { text } = render({ result, inlineFindings: [] });

    expect(text).toContain(
      "src/x.ts:17 [performance] Quadratic loop — Nested loops over the same collection.",
    );
  });

  test("includes a stats footer", () => {
    const finding = makeFinding();
    const result = makeResult({ findings: [finding], stats: statsFor([finding]) });

    const { text } = render({ result, inlineFindings: [] });

    expect(text).toContain("Stats:");
    expect(text).toContain("Files reviewed: 3");
    expect(text).toContain("Files skipped: 1");
  });

  test("reflects a passing status", () => {
    const result = makeResult({ status: "pass" });
    const { text } = render({ result, inlineFindings: [] });

    expect(text).toContain("Status: PASS");
  });
});

/* ───────────────────────── empty findings ───────────────────────── */

describe("render — empty findings", () => {
  test("produces sensible, non-crashing output for a clean PR", () => {
    const result = makeResult({
      summary: "No issues found.",
      findings: [],
      stats: emptyStats,
      status: "pass",
    });

    const out = render({ result, inlineFindings: [] });

    expect(out.inlineComments).toEqual([]);
    expect(out.text).toContain("Status: PASS");
    expect(out.text).toContain("CRITICAL (0)");
    expect(out.text).toContain("(none)");
    expect(out.markdownSummary).toContain("No issues found.");
    expect(out.markdownSummary).toContain("Findings not shown inline:");
    expect(out.markdownSummary).toContain("none");
  });
});

/* ───────────────────────── RenderInput type sanity ───────────────────────── */

describe("render — RenderInput shape", () => {
  test("accepts a RenderInput-typed value directly (satisfies contract)", () => {
    const finding = makeFinding();
    const input: RenderInput = {
      result: makeResult({ findings: [finding], stats: statsFor([finding]) }),
      inlineFindings: [finding],
    };

    const out = render(input);

    expect(out.inlineComments).toHaveLength(1);
    expect(out.text).toBeTruthy();
    expect(out.markdownSummary).toBeTruthy();
  });
});
