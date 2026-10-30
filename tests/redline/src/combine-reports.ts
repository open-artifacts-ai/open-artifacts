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

export type CaseSource = "ci" | "local" | "ci-rule";

/** The prod-clean case and the reason the frozen prodClean gives for zero prod installs. */
export const PROD_CLEAN = {
  file: "live/guard.test.ts",
  name: "guard > prod is clean (no test hooks on any prod install)",
  reason: "prod not brought up",
} as const;
/** The user's rule (2026-10-30): zero prod results count as a passing check. */
export const PROD_RULE_LABEL = "zero prod installs, user rule 2026-10-30";

/**
 * What the CI run's job log shows about the prod probe (the frozen
 * redline-staging.yml prints each step's env: secrets as "***", vars in
 * full). Under that workflow, all three secrets plus the inventory URL mean
 * the probe ran with the inventory: the secrets step fails on any empty
 * file, and the suite step adds prod.inventoryUrl, whose key file
 * loadTargets must read.
 */
export interface CiEnv {
  /** The suite commit the log's checkout fetched. */
  checkoutShas: string[];
  prodSecrets: { r2: boolean; scripts: boolean; inventoryKey: boolean };
  prodInventoryUrl: string;
  prodAccountId: string;
}

const envLine = (line: string, step: string, name: string) => {
  const cols = line.split("\t");
  if (cols[0] !== "redline" || cols[1] !== step) return undefined;
  const m = new RegExp(`^\\S*Z {3}${name}:(?: (.*))?$`).exec(cols[2] ?? "");
  return m ? (m[1] ?? "").trim() : undefined;
};

/** Parses `gh run view <id> --log` output for the redline job. */
export function parseCiLog(text: string): CiEnv {
  const SECRETS = "Write the suite's secrets as 0600 files";
  const SUITE = "Run the suite";
  const out: CiEnv = {
    checkoutShas: [],
    prodSecrets: { r2: false, scripts: false, inventoryKey: false },
    prodInventoryUrl: "",
    prodAccountId: "",
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\uFEFF/, "").replace(/\t\uFEFF/, "\t");
    const cols = line.split("\t");
    if (
      cols[0] === "redline" &&
      /^Run actions\/checkout@/.test(cols[1] ?? "")
    ) {
      const m = /^\S*Z ([0-9a-f]{40})$/.exec(cols[2] ?? "");
      if (m) out.checkoutShas.push(m[1] as string);
    }
    const sec = (n: string) => envLine(line, SECRETS, n) === "***";
    if (sec("PROD_R2_TOKEN")) out.prodSecrets.r2 = true;
    if (sec("PROD_SCRIPTS_TOKEN")) out.prodSecrets.scripts = true;
    if (sec("PROD_INVENTORY_KEY")) out.prodSecrets.inventoryKey = true;
    const url = envLine(line, SUITE, "REDLINE_PROD_INVENTORY_URL");
    if (url) out.prodInventoryUrl = url;
    const acct = envLine(line, SUITE, "REDLINE_PROD_ACCOUNT_ID");
    if (acct) out.prodAccountId = acct;
  }
  return out;
}

/** Why the CI env does not prove the prod probe ran with the inventory, or null. */
export function prodProbeGap(env: CiEnv, suiteSha: string): string | null {
  if (!env.checkoutShas.includes(suiteSha))
    return `the CI log's checkout is not ${suiteSha}`;
  const missing = [
    env.prodSecrets.r2 ? "" : "REDLINE_PROD_R2_TOKEN",
    env.prodSecrets.scripts ? "" : "REDLINE_PROD_SCRIPTS_TOKEN",
    env.prodSecrets.inventoryKey ? "" : "REDLINE_PROD_INVENTORY_KEY",
    /^https:\/\/[^\s/]+/.test(env.prodInventoryUrl)
      ? ""
      : "REDLINE_PROD_INVENTORY_URL",
    /^[0-9a-f]{32}$/.test(env.prodAccountId) ? "" : "REDLINE_PROD_ACCOUNT_ID",
  ].filter(Boolean);
  return missing.length ? `not set in the CI run: ${missing.join(", ")}` : null;
}

export type ReportsCombined =
  | {
      ok: true;
      report: Report;
      /** Where each case's level came from, in CI's case order. */
      sources: { name: string; file: string; source: CaseSource }[];
      binding: RunBinding;
      captureRun: string;
      /** The prod-clean mapping: applied, or why not (null: CI's case wasn't the zero-installs one). */
      prodRule: { applied: true } | { applied: false; reason: string } | null;
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
  ciEnv?: CiEnv,
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
  let prodRule: { applied: true } | { applied: false; reason: string } | null =
    null;
  const sources: { name: string; file: string; source: CaseSource }[] = [];
  const cases: CaseResult[] = [];
  for (const c of ci.cases) {
    const k = key(c);
    if (c.file === PROD_CLEAN.file && c.name === PROD_CLEAN.name) {
      if (c.level === "not-applicable" && c.reason === PROD_CLEAN.reason) {
        const gap = ciEnv
          ? prodProbeGap(ciEnv, (ci.binding as RunBinding).suiteSha)
          : "no CI log given (--ci-log)";
        if (gap === null) {
          prodRule = { applied: true };
          cases.push({
            name: c.name,
            file: c.file,
            level: "pass",
            label: PROD_RULE_LABEL,
          });
          sources.push({ name: c.name, file: c.file, source: "ci-rule" });
          continue;
        }
        prodRule = { applied: false, reason: gap };
      }
    }
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
    prodRule,
  };
}
