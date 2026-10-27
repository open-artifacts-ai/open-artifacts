import {
  ID_TOKEN_CASES,
  ID_TOKEN_DESCRIBE,
  ID_TOKEN_FILE,
  type IdTokenCase,
  NEEDS_CAPTURE,
  RUN_NONCE_RE,
  type Verdicts,
  verdictsOutcome,
} from "./capture.ts";
import { buildReport, type CaseResult, legOf, type Report } from "./report.ts";

// The gate binding (R7): CI runs the whole suite, where the two ID-token
// cases report "unproven: needs capture"; a laptop capture run produces
// verdicts.json. combine() folds the verdicts into the CI report, and only
// when they were taken against the same installs, the same versions and the
// same suite commit, at most 24 h before. It replaces exactly those two
// cases; anything else is refused with a reason.

/** Verdicts older than this can't be combined. */
export const COMBINE_MAX_AGE_MS = 24 * 60 * 60_000;

export type Combined =
  | { ok: true; report: Report }
  | { ok: false; reason: string };

const caseName = (k: IdTokenCase) =>
  `${ID_TOKEN_DESCRIBE} > ${ID_TOKEN_CASES[k]}`;

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;

export function combine(ci: Report, v: Verdicts, now = Date.now()): Combined {
  const no = (reason: string): Combined => ({ ok: false, reason });
  const b = ci?.binding;
  if (!b)
    return no("the CI report has no binding (installs, versions, suite SHA)");
  if (
    v?.v !== 1 ||
    !Array.isArray(v.legs) ||
    typeof v.finishedAt !== "number" ||
    typeof v.suiteSha !== "string" ||
    !v.installs ||
    !v.versions
  )
    return no("the verdicts file has an unknown shape");
  if (v.mode !== "staging" || ci.mode !== "staging")
    return no(
      `only staging verdicts combine into a staging report (verdicts ${String(v.mode)}, CI ${ci.mode})`,
    );
  if (typeof v.runNonce !== "string" || !RUN_NONCE_RE.test(v.runNonce))
    return no("the verdicts have no valid runNonce");
  for (const k of ["a", "b"] as const) {
    if (v.installs[k] !== b.installs[k])
      return no(
        `install ${k} differs: CI ran ${b.installs[k]}, the capture ${String(v.installs[k])}`,
      );
    if (v.versions[k] !== b.versions[k])
      return no(
        `install ${k}'s version differs: CI ran ${b.versions[k]}, the capture ${String(v.versions[k])}`,
      );
  }
  if (v.suiteSha !== b.suiteSha)
    return no(
      `suite commit differs: CI ran ${b.suiteSha}, the capture ${v.suiteSha}`,
    );
  if (v.finishedAt > now + 60_000)
    return no("the verdicts finish in the future");
  if (now - v.finishedAt > COMBINE_MAX_AGE_MS)
    return no(
      `the verdicts are ${hours(now - v.finishedAt)} old (at most 24 h)`,
    );
  const keys = Object.keys(ID_TOKEN_CASES) as IdTokenCase[];
  for (const k of keys) {
    const matches = ci.cases.filter(
      (c) => c.file === ID_TOKEN_FILE && c.name === caseName(k),
    );
    if (matches.length !== 1)
      return no(`the CI report has ${matches.length} "${caseName(k)}" cases`);
    const c = matches[0] as CaseResult;
    if (c.level !== "unproven-live" || c.reason !== NEEDS_CAPTURE)
      return no(
        `CI's "${caseName(k)}" is ${c.level}${c.reason ? ` (${c.reason})` : ""}, not "${NEEDS_CAPTURE}"`,
      );
  }
  const cases = ci.cases.map((c): CaseResult => {
    const k = keys.find(
      (x) => c.file === ID_TOKEN_FILE && c.name === caseName(x),
    );
    if (!k) return c;
    const out = verdictsOutcome(v, b.installs, k, now, COMBINE_MAX_AGE_MS);
    const base = { name: c.name, file: c.file };
    if (out.kind === "pass")
      return { ...base, level: "pass", label: out.label };
    if (out.kind === "fail")
      return {
        ...base,
        level: "fail",
        reason: out.error.message,
        ...legOf([out.error]),
      };
    return {
      ...base,
      level: "unproven-live",
      reason:
        out.kind === "unproven" ? `unproven: ${out.reason}` : NEEDS_CAPTURE,
    };
  });
  const report = buildReport(cases, ci.mode);
  return {
    ok: true,
    report: {
      ...report,
      binding: b,
      combined: { runNonce: v.runNonce, verdictsFinishedAt: v.finishedAt },
    },
  };
}
