import {
  ID_TOKEN_CASES,
  ID_TOKEN_DESCRIBE,
  ID_TOKEN_FILE,
  NEEDS_CAPTURE,
} from "./capture.ts";
import { COMBINE_MAX_AGE_MS } from "./combine.ts";
import {
  buildReport,
  type CaseResult,
  type Report,
  type RunBinding,
} from "./report.ts";

// The gate binding (R7) for a capture whose verdicts.json is gone: the
// laptop's own full --gate run (its report.json) stands in for the verdicts.
// The CI report is the base. Only the two ID-token cases that CI reports as
// "unproven: needs capture" are taken from the laptop report, and only when
// the laptop report passed them through a capture run, against the same
// installs, versions and suite commit, within 24 h of the CI run. Every
// other case is CI's, as CI reported it; nothing else is ever filled in.

export type CaseSource = "ci" | "local";

export type ReportsCombined =
  | {
      ok: true;
      report: Report;
      /** Where each case's level came from, in CI's case order. */
      sources: { name: string; file: string; source: CaseSource }[];
      binding: RunBinding;
      captureRun: string;
    }
  | { ok: false; reason: string };

const CAPTURE_LABEL = /^redeemed by capture run ([A-Za-z0-9_-]{1,64})$/;
const key = (c: { file?: string; name: string }) =>
  `${c.file ?? ""}\u0000${c.name}`;
const idTokenNames = new Set(
  Object.values(ID_TOKEN_CASES).map((n) =>
    key({ file: ID_TOKEN_FILE, name: `${ID_TOKEN_DESCRIBE} > ${n}` }),
  ),
);
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;

function sameBinding(a?: RunBinding, b?: RunBinding): string | null {
  if (!a || !b)
    return "a report has no binding (installs, versions, suite SHA)";
  for (const k of ["a", "b"] as const) {
    if (a.installs[k] !== b.installs[k])
      return `install ${k} differs: CI ${a.installs[k]}, local ${b.installs[k]}`;
    if (a.versions[k] !== b.versions[k])
      return `install ${k}'s version differs: CI ${a.versions[k]}, local ${b.versions[k]}`;
  }
  if (a.suiteSha !== b.suiteSha)
    return `suite commit differs: CI ${a.suiteSha}, local ${b.suiteSha}`;
  return null;
}

export function combineReports(
  ci: Report,
  local: Report,
  now = Date.now(),
): ReportsCombined {
  const no = (reason: string): ReportsCombined => ({ ok: false, reason });
  if (ci?.mode !== "staging" || local?.mode !== "staging")
    return no(
      `both reports must be staging runs (CI ${String(ci?.mode)}, local ${String(local?.mode)})`,
    );
  const bad = sameBinding(ci.binding, local.binding);
  if (bad) return no(bad);
  const tCi = Date.parse(ci.finishedAt);
  const tLocal = Date.parse(local.finishedAt);
  if (!Number.isFinite(tCi) || !Number.isFinite(tLocal))
    return no("a report has no valid finishedAt");
  if (tCi > now + 60_000 || tLocal > now + 60_000)
    return no("a report finishes in the future");
  if (Math.abs(tCi - tLocal) > COMBINE_MAX_AGE_MS)
    return no(
      `the runs are ${hours(Math.abs(tCi - tLocal))} apart (at most 24 h)`,
    );
  const ciKeys = ci.cases.map(key);
  const localByKey = new Map(local.cases.map((c) => [key(c), c]));
  if (
    new Set(ciKeys).size !== ciKeys.length ||
    localByKey.size !== local.cases.length
  )
    return no("a report lists the same case twice");
  if (
    ciKeys.length !== localByKey.size ||
    ciKeys.some((k) => !localByKey.has(k))
  )
    return no("the two reports don't list the same cases (another suite?)");
  let captureRun: string | null = null;
  const sources: { name: string; file: string; source: CaseSource }[] = [];
  const cases: CaseResult[] = [];
  for (const c of ci.cases) {
    const k = key(c);
    if (!idTokenNames.has(k)) {
      cases.push(c);
      sources.push({ name: c.name, file: c.file ?? "", source: "ci" });
      continue;
    }
    if (c.level !== "unproven-live" || c.reason !== NEEDS_CAPTURE)
      return no(
        `CI's "${c.name}" is ${c.level}${c.reason ? ` (${c.reason})` : ""}, not "${NEEDS_CAPTURE}"`,
      );
    const l = localByKey.get(k) as CaseResult;
    const m = l.level === "pass" ? CAPTURE_LABEL.exec(l.label ?? "") : null;
    if (!m)
      return no(
        `the local "${c.name}" is ${l.level}${l.label ? ` [${l.label}]` : ""}, not a pass redeemed by a capture run`,
      );
    if (captureRun !== null && m[1] !== captureRun)
      return no("the two ID-token cases come from different capture runs");
    captureRun = m[1] as string;
    cases.push({ name: c.name, file: c.file, level: "pass", label: l.label });
    sources.push({ name: c.name, file: c.file ?? "", source: "local" });
  }
  if (captureRun === null) return no("CI has no ID-token cases");
  const report = buildReport(cases, ci.mode);
  return {
    ok: true,
    report: { ...report, binding: ci.binding },
    sources,
    binding: ci.binding as RunBinding,
    captureRun,
  };
}
