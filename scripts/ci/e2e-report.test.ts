import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Quarantined } from "../../apps/dashboard/e2e/quarantine.ts";
import { flaky, GRADUATE_RUNS, render, rows, verdicts } from "./e2e-report.ts";
import { sandbox, script } from "./stubs.ts";

// The shape Playwright's JSON reporter writes (merge-reports --reporter=json).
const test = (status: string, results: string[], projectName = "chromium") => ({
  projectName,
  status,
  results: results.map((s, retry) => ({ status: s, retry })),
});
const report = {
  suites: [
    {
      title: "consent.spec.ts",
      file: "consent.spec.ts",
      specs: [
        {
          title: "deny redirects",
          file: "consent.spec.ts",
          line: 74,
          tests: [
            test("flaky", ["failed", "passed"]),
            test("expected", ["passed"], "webkit"),
          ],
        },
      ],
      suites: [
        {
          title: "embed mode",
          specs: [
            {
              title: "opens, a tab",
              file: "consent.spec.ts",
              line: 104,
              tests: [test("unexpected", ["failed", "failed"])],
            },
          ],
        },
      ],
    },
  ],
};
const q = (o: Partial<Quarantined> = {}): Quarantined => ({
  file: "real/consent.spec.ts",
  title: "embed mode › opens, a tab",
  owner: "Platform",
  since: "2026-10-27",
  reason: "r",
  ...o,
});

describe("e2e-report", () => {
  it("rows: the real/ prefix, describe titles in the title path, one row per project", () => {
    const r = rows(report, "real");
    expect(r.map((x) => [x.file, x.title, x.project, x.status])).toEqual([
      ["real/consent.spec.ts", "deny redirects", "chromium", "flaky"],
      ["real/consent.spec.ts", "deny redirects", "webkit", "expected"],
      [
        "real/consent.spec.ts",
        "embed mode › opens, a tab",
        "chromium",
        "unexpected",
      ],
    ]);
    expect(rows(report, "mock")[0]?.file).toBe("consent.spec.ts");
  });
  it("flaky: only tests that passed on their retry (not a plain failure)", () => {
    expect(flaky(rows(report, "real")).map((r) => r.title)).toEqual([
      "deny redirects",
    ]);
  });
  it("verdicts: graduates only after every one of 10 or more runs passed", () => {
    const run = (statuses: string[]) =>
      rows(
        {
          suites: [
            {
              title: "consent.spec.ts",
              suites: [
                {
                  title: "embed mode",
                  specs: [
                    {
                      title: "opens, a tab",
                      file: "consent.spec.ts",
                      line: 1,
                      tests: statuses.map((s) =>
                        test(s === "passed" ? "expected" : "unexpected", [s]),
                      ),
                    },
                  ],
                },
              ],
            },
          ],
        },
        "real",
      );
    const ten = Array(GRADUATE_RUNS).fill("passed");
    expect(verdicts([q()], run(ten))[0]).toMatchObject({
      runs: 10,
      passed: 10,
      graduate: true,
    });
    expect(verdicts([q()], run([...ten.slice(1), "failed"]))[0]?.graduate).toBe(
      false,
    );
    expect(verdicts([q()], run(["passed"]))[0]).toMatchObject({
      runs: 1,
      graduate: false,
    });
    expect(verdicts([q()], [])[0]).toMatchObject({ runs: 0, graduate: false });
    // another suite's same-named file is not this test
    expect(verdicts([q({ file: "consent.spec.ts" })], run(ten))[0]?.runs).toBe(
      0,
    );
  });
  it("render: escaped annotations, a summary table, and the graduation call-out", () => {
    const flakes = flaky(rows(report, "real"));
    const v = [{ q: q(), runs: 10, passed: 10, graduate: true }];
    const { annotations, summary } = render(flakes, v);
    expect(annotations[0]).toBe(
      "::warning file=apps/dashboard/e2e/real/consent.spec.ts,line=74,title=Flaky e2e test::deny redirects [chromium] failed, then passed on retry",
    );
    expect(annotations[1]).toMatch(
      /^::warning title=Quarantine%3A ready to come out::/,
    );
    expect(summary).toContain("**1 flaky**");
    expect(summary).toContain(
      "| real | deny redirects [chromium] | `real/consent.spec.ts:74` |",
    );
    expect(summary).toContain("**ready to come out**");
    const none = render([], []);
    expect(none.annotations).toEqual([]);
    expect(none.summary).toContain("No flaky tests");
    expect(none.summary).toContain("Quarantine: empty.");
    // workflow-command data can't break out of its line
    const evil = render(
      [{ ...flakes[0], title: "a\n::error::x%" } as never],
      [],
    );
    expect(evil.annotations[0]).not.toContain("\n");
    expect(evil.annotations[0]).toContain("a%0A::error::x%25");
  });
  it("summary: reads the merged and quarantine reports, writes the step summary, exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-report-"));
    writeFileSync(join(dir, "real.json"), JSON.stringify(report));
    const out = join(dir, "summary.md");
    writeFileSync(out, "");
    const sb = sandbox({});
    const r = sb.run(
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        script("e2e-report.ts"),
        "summary",
        dir,
        join(dir, "none"),
      ],
      { env: { GITHUB_STEP_SUMMARY: out } },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "::warning file=apps/dashboard/e2e/real/consent.spec.ts,line=74",
    );
    expect(readFileSync(out, "utf8")).toContain("**1 flaky**");
    const bad = sb.run([
      "node",
      "--experimental-strip-types",
      "--no-warnings",
      script("e2e-report.ts"),
      "nope",
    ]);
    expect(bad.code).toBe(2);
  });
});
