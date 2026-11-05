// Runs the live red-line suite and applies the gate.
//   node --experimental-strip-types scripts/redline.ts [--gate]
// (or REDLINE_GATE=1). Needs REDLINE_TARGETS. Exits non-zero on any failed
// case, and with the gate unless EVERY case is "pass".
//
// The files run in the lanes of src/lanes.ts: phases one after another, the
// lanes of a phase at the same time, each lane one vitest run whose files run
// one at a time. Each lane writes a part; this script builds the one report.
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type LaneResult, laneName, mergeLanes, PLAN } from "../src/lanes.ts";
import { exitCode, formatReport, gateOn, type Report } from "../src/report.ts";
import { finalReport, type LanePart, writeReport } from "../src/reporter.ts";

const pkg = join(import.meta.dirname, "..");
const gate = gateOn(process.argv.slice(2), process.env);
const reportFile =
  process.env.REDLINE_REPORT ||
  join(mkdtempSync(join(tmpdir(), "oa-redline-report-")), "report.json");
const partsDir = `${reportFile.replace(/\.json$/, "")}.lanes`;

// A stale report, part or retry slot must never stand in for this run's.
rmSync(reportFile, { force: true });
rmSync(reportFile.replace(/\.json$/, ".txt"), { force: true });
rmSync(partsDir, { recursive: true, force: true });
const dir = dirname(reportFile);
if (existsSync(dir))
  for (const f of readdirSync(dir))
    if (f.startsWith(`${basename(reportFile)}.retries`))
      rmSync(join(dir, f), { force: true });
mkdirSync(partsDir, { recursive: true, mode: 0o700 });

const vitest = join(pkg, "node_modules", ".bin", "vitest");
const live = new Set<ChildProcess>();
const forward = (sig: NodeJS.Signals) => () => {
  for (const c of live) c.kill(sig);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGHUP", forward("SIGHUP"));

/** Copies `from` to `to` a whole line at a time, each line prefixed. */
function prefixed(
  from: NodeJS.ReadableStream,
  to: NodeJS.WriteStream,
  p: string,
) {
  let rest = "";
  from.setEncoding("utf8");
  from.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) to.write(`${p}${l}\n`);
  });
  from.on("end", () => {
    if (rest) to.write(`${p}${rest}\n`);
  });
}

function runLane(
  lane: readonly string[],
  prefix: boolean,
): Promise<LaneResult> {
  const name = laneName(lane);
  const part = join(partsDir, `${name}.json`);
  const child = spawn(vitest, ["run", "-c", "vitest.live.config.ts", ...lane], {
    cwd: pkg,
    stdio: prefix ? ["ignore", "pipe", "pipe"] : "inherit",
    // The reporter writes this lane's part and leaves the exit to us; the
    // retry budget (src/retry.ts) still counts beside REDLINE_REPORT.
    env: {
      ...process.env,
      REDLINE_REPORT: reportFile,
      REDLINE_REPORT_PART: part,
      REDLINE_GATE: "0",
    },
  });
  live.add(child);
  if (prefix && child.stdout && child.stderr) {
    prefixed(child.stdout, process.stdout, `[${name}] `);
    prefixed(child.stderr, process.stderr, `[${name}] `);
  }
  return new Promise((res) =>
    child.on("close", (code, sig) => {
      live.delete(child);
      let p: LanePart | null = null;
      try {
        const v = JSON.parse(readFileSync(part, "utf8")) as LanePart;
        if (v?.v === 1 && Array.isArray(v.cases)) p = v;
      } catch {
        p = null;
      }
      res({ lane, exit: code ?? (sig ? 1 : 0), part: p });
    }),
  );
}

const results: LaneResult[] = [];
for (const [i, phase] of PLAN.entries()) {
  console.log(
    `redline: phase ${i + 1} of ${PLAN.length}: ${phase.map((l) => l.join(", ")).join(" | ")}`,
  );
  results.push(
    ...(await Promise.all(phase.map((l) => runLane(l, phase.length > 1)))),
  );
}

const merged = mergeLanes(results);
let report: Report | null = null;
try {
  report = await finalReport(merged.cases, merged.fileNotes);
  process.stdout.write(`\n${writeReport(report, reportFile)}`);
} catch (e) {
  console.error(`redline: no report was written (${(e as Error).message})`);
  report = null;
}
if (report && gate)
  console.log(`\n[gate] ${formatReport(report).trimEnd().split("\n").pop()}`);
console.log(`redline: report at ${reportFile}`);
process.exit(exitCode(report, gate, merged.runExit));
