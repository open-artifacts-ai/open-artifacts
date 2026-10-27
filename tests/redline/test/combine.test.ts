import { describe, expect, it } from "vitest";
import {
  CAPTURE_LEGS,
  ID_TOKEN_CASES,
  type LegVerdict,
  NEEDS_CAPTURE,
  type Verdicts,
} from "../src/capture.ts";
import { COMBINE_MAX_AGE_MS, combine } from "../src/combine.ts";
import { buildReport, type CaseResult, type Report } from "../src/report.ts";
import type { FlowName } from "../src/signin.ts";

const NOW = Date.UTC(2026, 9, 27, 12);
const FILE = "live/signin.test.ts";
const HD = `sign-in: ID tokens > ${ID_TOKEN_CASES.hd}`;
const AUD = `sign-in: ID tokens > ${ID_TOKEN_CASES.aud}`;
const binding = {
  installs: { a: "rl-a-id", b: "rl-b-id" },
  versions: { a: "0.64.0", b: "0.64.0" },
  suiteSha: "a".repeat(40),
};

function ciReport(over: Partial<Record<string, CaseResult>> = {}): Report {
  const cases: CaseResult[] = [
    { name: "other > a case", file: "live/edge.test.ts", level: "pass" },
    { name: HD, file: FILE, level: "unproven-live", reason: NEEDS_CAPTURE },
    { name: AUD, file: FILE, level: "unproven-live", reason: NEEDS_CAPTURE },
  ].map((c) => over[c.name] ?? c) as CaseResult[];
  return { ...buildReport(cases, "staging"), binding };
}

function verdicts(edit: (v: Verdicts) => void = () => {}): Verdicts {
  const legs: LegVerdict[] = [];
  for (const [flow, ls] of Object.entries(CAPTURE_LEGS))
    for (const l of ls)
      legs.push({
        case: l.case,
        flow: flow as FlowName,
        leg: l.leg,
        host: l.host === "a" ? "rl-a" : "rl-b",
        expected: "signed in",
        verdict: "pass",
        startedAt: NOW - 3_600_000,
        redeemedAt: NOW - 3_590_000,
      });
  const v: Verdicts = {
    v: 1,
    runNonce: "n".repeat(43),
    installs: { ...binding.installs },
    versions: { ...binding.versions },
    suiteSha: binding.suiteSha,
    startedAt: NOW - 3_600_000,
    finishedAt: NOW - 3_500_000,
    legs,
  };
  edit(v);
  return v;
}

describe("combine (the gate binding)", () => {
  it("replaces exactly the two ID-token cases, recomputes the gate and carries the runNonce", () => {
    const r = combine(ciReport(), verdicts(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.cases).toEqual([
      { name: "other > a case", file: "live/edge.test.ts", level: "pass" },
      { name: HD, file: FILE, level: "pass" },
      { name: AUD, file: FILE, level: "pass" },
    ]);
    expect(r.report.gate.passed).toBe(true);
    expect(r.report.binding).toEqual(binding);
    expect(r.report.combined).toEqual({
      runNonce: "n".repeat(43),
      verdictsFinishedAt: NOW - 3_500_000,
    });
  });

  it("a failed leg makes the case fail with its reason and leg; a flow not captured is unproven", () => {
    const v = verdicts((x) => {
      const l = x.legs.find((y) => y.flow === "b-alice") as LegVerdict;
      l.verdict = "fail";
      l.reason = "A's credential at B (rl-b; expected refused): not refused";
      x.legs = x.legs.filter((y) => y.flow !== "b-dave-2");
    });
    const r = combine(ciReport(), v, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.cases[1]).toMatchObject({
      level: "fail",
      reason:
        "[b-alice] A's credential at B (rl-b; expected refused): not refused",
      leg: "A's credential at B",
      host: "rl-b",
    });
    expect(r.report.cases[2]).toEqual({
      name: AUD,
      file: FILE,
      level: "unproven-live",
      reason: "unproven: not captured (b-dave-2)",
    });
    expect(r.report.gate.passed).toBe(false);
  });

  const refusals: [string, () => [Report, Verdicts, number?], RegExp][] = [
    [
      "no binding in the CI report",
      () => [{ ...ciReport(), binding: undefined }, verdicts()],
      /no binding/,
    ],
    [
      "a verdicts file of another shape",
      () => [ciReport(), { v: 2 } as unknown as Verdicts],
      /unknown shape/,
    ],
    [
      "no valid runNonce",
      () => [ciReport(), verdicts((v) => (v.runNonce = "short"))],
      /runNonce/,
    ],
    [
      "install a differs",
      () => [ciReport(), verdicts((v) => (v.installs.a = "rl-x"))],
      /install a differs: CI ran rl-a-id, the capture rl-x/,
    ],
    [
      "install b differs",
      () => [ciReport(), verdicts((v) => (v.installs.b = "rl-x"))],
      /install b differs/,
    ],
    [
      "a version differs",
      () => [ciReport(), verdicts((v) => (v.versions.b = "0.63.0"))],
      /install b's version differs: CI ran 0\.64\.0, the capture 0\.63\.0/,
    ],
    [
      "the suite commit differs",
      () => [ciReport(), verdicts((v) => (v.suiteSha = "b".repeat(40)))],
      /suite commit differs/,
    ],
    [
      "verdicts older than 24 h",
      () => [
        ciReport(),
        verdicts((v) => (v.finishedAt = NOW - COMBINE_MAX_AGE_MS - 1)),
      ],
      /24\.0 h old \(at most 24 h\)/,
    ],
    [
      "verdicts from the future",
      () => [ciReport(), verdicts((v) => (v.finishedAt = NOW + 3_600_000))],
      /future/,
    ],
    [
      "a CI report missing an ID-token case",
      () => {
        const r = ciReport();
        return [
          { ...r, cases: r.cases.filter((c) => c.name !== AUD) },
          verdicts(),
        ];
      },
      /has 0 ".*A's code and broker state/,
    ],
    [
      "a CI report with the case twice",
      () => {
        const r = ciReport();
        return [
          { ...r, cases: [...r.cases, r.cases[1] as CaseResult] },
          verdicts(),
        ];
      },
      /has 2 /,
    ],
    [
      "a CI case that isn't 'needs capture' (already decided)",
      () => [
        ciReport({ [HD]: { name: HD, file: FILE, level: "pass" } }),
        verdicts(),
      ],
      /is pass, not "unproven: needs capture"/,
    ],
    [
      "a CI case unproven for another reason",
      () => [
        ciReport({
          [AUD]: {
            name: AUD,
            file: FILE,
            level: "unproven-live",
            reason: "unproven: capture too old (b-dave-2, 9m 1s)",
          },
        }),
        verdicts(),
      ],
      /is unproven-live \(unproven: capture too old/,
    ],
  ];
  for (const [what, make, why] of refusals)
    it(`refuses: ${what}`, () => {
      const [ci, v, now] = make();
      const r = combine(ci, v, now ?? NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    });
});
