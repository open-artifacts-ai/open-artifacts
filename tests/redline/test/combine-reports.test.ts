import { describe, expect, it } from "vitest";
import {
  ID_TOKEN_CASES,
  ID_TOKEN_DESCRIBE,
  ID_TOKEN_FILE,
  NEEDS_CAPTURE,
} from "../src/capture.ts";
import { combineReports } from "../src/combine-reports.ts";
import { buildReport, type CaseResult, type Report } from "../src/report.ts";

// The laptop full run standing in for verdicts.json: only CI's two
// "needs capture" cases are filled in, and only from a matching run.

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const BINDING = {
  installs: { a: "ijzbmraouh5r", b: "i42fdk7ahvs2" },
  versions: { a: "0.74.1", b: "0.74.1" },
  suiteSha: "5469cf7811e17857091d49dc18e0daa327bdbf89",
};
const ID = Object.values(ID_TOKEN_CASES).map((n) => ({
  file: ID_TOKEN_FILE,
  name: `${ID_TOKEN_DESCRIBE} > ${n}`,
}));
const OTHER = [
  { file: "live/edge.test.ts", name: "mapping > HOSTS maps each host once" },
  { file: "live/guard.test.ts", name: "guard > prod is clean" },
  { file: "live/x.test.ts", name: "x > A's PAT at B: refused" },
];

function report(
  level: (c: { file: string; name: string }) => Partial<CaseResult>,
  o: { finishedAt?: number; binding?: typeof BINDING; mode?: string } = {},
): Report {
  const cases = [...OTHER, ...ID].map(
    (c) => ({ ...c, level: "pass", ...level(c) }) as CaseResult,
  );
  const r = buildReport(cases, o.mode ?? "staging");
  return {
    ...r,
    finishedAt: new Date(o.finishedAt ?? NOW - 3_600_000).toISOString(),
    binding: o.binding ?? BINDING,
  };
}
const isId = (c: { file: string }) => c.file === ID_TOKEN_FILE;
const ciReport = (o = {}) =>
  report(
    (c) => (isId(c) ? { level: "unproven-live", reason: NEEDS_CAPTURE } : {}),
    o,
  );
const localReport = (o = {}) =>
  report(
    (c) =>
      isId(c)
        ? { level: "pass", label: "redeemed by capture run XUvaQD" }
        : c.file === "live/edge.test.ts"
          ? { level: "unproven-live", reason: "CI-only (not-local)" }
          : c.file === "live/guard.test.ts"
            ? { level: "not-applicable", reason: "prod probe not configured" }
            : {},
    o,
  );

describe("combineReports", () => {
  it("fills exactly CI's two needs-capture cases from the local run; everything else is CI's", () => {
    const r = combineReports(ciReport(), localReport(), NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(r.report.gate.passed).toBe(true);
    expect(r.captureRun).toBe("XUvaQD");
    expect(r.sources.filter((s) => s.source === "local")).toEqual(
      ID.map((c) => ({ ...c, source: "local" })),
    );
    expect(r.sources.filter((s) => s.source === "ci")).toHaveLength(
      OTHER.length,
    );
    expect(r.report.binding).toEqual(BINDING);
  });

  it("never fills any other case from the local run: a CI non-pass stays a non-pass", () => {
    const ci = report((c) =>
      isId(c)
        ? { level: "unproven-live", reason: NEEDS_CAPTURE }
        : c.file === "live/guard.test.ts"
          ? { level: "not-applicable", reason: "prod probe not configured" }
          : {},
    );
    const local = report((c) =>
      isId(c) ? { level: "pass", label: "redeemed by capture run XUvaQD" } : {},
    );
    const r = combineReports(ci, local, NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(r.report.gate.passed).toBe(false);
    expect(r.report.nonPass.map((c) => c.name)).toEqual([
      "guard > prod is clean",
    ]);
  });

  it("refuses another suite commit, another install, a version drift", () => {
    const other = {
      ...BINDING,
      suiteSha: "456b3d387d8c231f478a0597f3359b647a6054e0",
    };
    expect(
      combineReports(ciReport({ binding: other }), localReport(), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^suite commit differs/),
    });
    const inst = {
      ...BINDING,
      installs: { a: "ijzbmraouh5r", b: "izzz999yyy88" },
    };
    expect(
      combineReports(ciReport({ binding: inst }), localReport(), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^install b differs/),
    });
    const ver = { ...BINDING, versions: { a: "0.74.1", b: "0.74.2" } };
    expect(
      combineReports(ciReport({ binding: ver }), localReport(), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^install b's version differs/),
    });
  });

  it("refuses runs more than 24 h apart, a future run, and a non-staging report", () => {
    expect(
      combineReports(
        ciReport({ finishedAt: NOW - 1 }),
        localReport({ finishedAt: NOW - 25 * 3_600_000 }),
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/apart \(at most 24 h\)/),
    });
    expect(
      combineReports(
        ciReport({ finishedAt: NOW + 3_600_000 }),
        localReport(),
        NOW,
      ),
    ).toMatchObject({ ok: false, reason: "a report finishes in the future" });
    expect(
      combineReports(ciReport(), localReport({ mode: "local" }), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/staging runs/),
    });
  });

  it("refuses a local ID-token case that isn't a capture pass, and a CI one that isn't needs-capture", () => {
    const noCapture = report((c) => (isId(c) ? { level: "pass" } : {}));
    expect(combineReports(ciReport(), noCapture, NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a pass redeemed by a capture run/),
    });
    const ciFail = report((c) =>
      isId(c) ? { level: "fail", reason: "B accepted it" } : {},
    );
    expect(combineReports(ciFail, localReport(), NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is fail .* not "unproven: needs capture"/),
    });
  });

  it("refuses two reports that don't list the same cases", () => {
    const local = localReport();
    local.cases = local.cases.slice(1);
    expect(combineReports(ciReport(), local, NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/same cases/),
    });
  });
});
