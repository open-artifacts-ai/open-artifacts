// The gate for a capture whose verdicts.json is gone (src/combine-reports.ts):
//   node --experimental-strip-types scripts/combine-reports.ts <ci report.json> <local report.json> [--out <file>]
// Prints both bindings, each case's source (ci or local) and the gate.
// Exits 0 only when the combined report passes the gate.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { combineReports } from "../src/combine-reports.ts";
import { formatReport, type Report } from "../src/report.ts";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const files = args.filter((_, i) => i !== outAt && i !== outAt + 1);
if (files.length !== 2) {
  console.error(
    "usage: combine-reports.ts <ci report.json> <local report.json> [--out <file>]",
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
const r = combineReports(ci.report, local.report);
if (!r.ok) {
  console.log(`\nREFUSED: ${r.reason}`);
  process.exit(1);
}
const fromLocal = r.sources.filter((s) => s.source === "local");
console.log(
  `\nSources: ${r.sources.length - fromLocal.length} cases from CI; ${fromLocal.length} from the local run (capture run ${r.captureRun}):`,
);
for (const s of fromLocal) console.log(`  local  ${s.file} > ${s.name}`);
console.log(`\n${formatReport(r.report)}`);
if (out) {
  writeFileSync(
    out,
    `${JSON.stringify({ ...r.report, combinedFrom: { ci: ci.sha, local: local.sha, captureRun: r.captureRun }, sources: r.sources }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`combined report: ${out}`);
}
process.exit(r.report.gate.passed ? 0 : 1);
