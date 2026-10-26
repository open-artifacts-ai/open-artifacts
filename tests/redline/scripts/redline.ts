// Runs the live red-line suite and applies the gate.
//   node --experimental-strip-types scripts/redline.ts [--gate]
// (or REDLINE_GATE=1). Needs REDLINE_TARGETS. Exits non-zero on any failed
// case, and with the gate unless EVERY case is "pass".
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCode, formatReport, gateOn, type Report } from "../src/report.ts";

const pkg = join(import.meta.dirname, "..");
const gate = gateOn(process.argv.slice(2), process.env);
const reportFile =
  process.env.REDLINE_REPORT ||
  join(mkdtempSync(join(tmpdir(), "oa-redline-report-")), "report.json");

const vitest = join(pkg, "node_modules", ".bin", "vitest");
const child = spawn(vitest, ["run", "-c", "vitest.live.config.ts"], {
  cwd: pkg,
  stdio: "inherit",
  // The reporter must not set the exit code itself here: the wrapper decides.
  env: { ...process.env, REDLINE_REPORT: reportFile, REDLINE_GATE: "0" },
});
const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));

const runExit: number = await new Promise((res) =>
  child.on("exit", (code, sig) => res(code ?? (sig ? 1 : 0))),
);
let report: Report | null = null;
if (existsSync(reportFile)) {
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8")) as Report;
  } catch {
    report = null;
  }
}
if (!report) console.error("redline: no report was written");
else if (gate)
  console.log(`\n[gate] ${formatReport(report).trimEnd().split("\n").pop()}`);
console.log(`redline: report at ${reportFile}`);
process.exit(exitCode(report, gate, runExit));
