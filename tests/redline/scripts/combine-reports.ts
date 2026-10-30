// The gate for a capture whose verdicts.json is gone (src/combine-reports.ts):
//   node --experimental-strip-types scripts/combine-reports.ts <ci report.json> <local report.json> [--ci-log <gh run view --log>] [--out <file>]
// Prints both bindings, each case's source (ci or local) and the gate.
// Exits 0 only when the combined report passes the gate.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  type CiEnv,
  combineReports,
  PROD_RULE_LABEL,
  parseCiLog,
} from "../src/combine-reports.ts";
import { formatReport, type Report } from "../src/report.ts";

const args = process.argv.slice(2);
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? { i, v: args[i + 1] } : undefined;
};
const outF = flag("--out");
const logF = flag("--ci-log");
const out = outF?.v;
const taken = new Set([outF, logF].flatMap((f) => (f ? [f.i, f.i + 1] : [])));
const files = args.filter((_, i) => !taken.has(i));
if (files.length !== 2) {
  console.error(
    "usage: combine-reports.ts <ci report.json> <local report.json> [--ci-log <file>] [--out <file>]",
  );
  process.exit(2);
}
const read = (f: string) => {
  const raw = readFileSync(f);
  return {
    report: JSON.parse(raw.toString("utf8")) as Report,
    sha: createHash("sha256").update(raw).digest("hex"),
  };
};
const ci = read(files[0] as string);
const local = read(files[1] as string);
const b = (r: Report) =>
  r.binding
    ? `installs a=${r.binding.installs.a} b=${r.binding.installs.b}; versions a=${r.binding.versions.a} b=${r.binding.versions.b}; suite ${r.binding.suiteSha}`
    : "(no binding)";
console.log(`CI    ${files[0]} sha256 ${ci.sha}`);
console.log(`      finished ${ci.report.finishedAt}; ${b(ci.report)}`);
console.log(`local ${files[1]} sha256 ${local.sha}`);
console.log(`      finished ${local.report.finishedAt}; ${b(local.report)}`);
let ciEnv: CiEnv | undefined;
if (logF?.v) {
  const raw = readFileSync(logF.v);
  ciEnv = parseCiLog(raw.toString("utf8"));
  const p = ciEnv.prodSecrets;
  const set = (b: boolean) => (b ? "set" : "MISSING");
  console.log(
    `CI log ${logF.v} sha256 ${createHash("sha256").update(raw).digest("hex")}`,
  );
  console.log(
    `      checkout ${ciEnv.checkoutShas.join(", ") || "(none)"}; prod secrets R2 ${set(p.r2)}, scripts ${set(p.scripts)}, inventory key ${set(p.inventoryKey)}; inventory URL ${ciEnv.prodInventoryUrl || "MISSING"}; account id ${ciEnv.prodAccountId ? "set" : "MISSING"}`,
  );
}
const r = combineReports(ci.report, local.report, Date.now(), ciEnv);
if (!r.ok) {
  console.log(`\nREFUSED: ${r.reason}`);
  process.exit(1);
}
const fromLocal = r.sources.filter((s) => s.source === "local");
console.log(
  `\nSources: ${r.sources.filter((s) => s.source === "ci").length} cases from CI, ${r.sources.length - r.sources.filter((s) => s.source === "ci").length - fromLocal.length} by the prod rule; ${fromLocal.length} from the local run (capture run ${r.captureRun}):`,
);
for (const s of fromLocal) console.log(`  local  ${s.file} > ${s.name}`);
if (r.prodRule?.applied)
  console.log(
    `  ci     live/guard.test.ts > prod is clean: pass (${PROD_RULE_LABEL})`,
  );
else if (r.prodRule)
  console.log(
    `  ci     live/guard.test.ts > prod is clean: stays not-applicable (${r.prodRule.reason})`,
  );
console.log(`\n${formatReport(r.report)}`);
if (out) {
  writeFileSync(
    out,
    `${JSON.stringify({ ...r.report, combinedFrom: { ci: ci.sha, local: local.sha, captureRun: r.captureRun, ciEnv, prodRule: r.prodRule }, sources: r.sources }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`combined report: ${out}`);
}
process.exit(r.report.gate.passed ? 0 : 1);
