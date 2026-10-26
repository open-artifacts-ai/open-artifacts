import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import {
  buildReport,
  type CaseResult,
  formatReport,
  levelOf,
} from "./report.ts";

// Vitest reporter: one CaseResult per test (its proof level), plus a "fail"
// case for every module or unhandled error, written as JSON and text to
// REDLINE_REPORT (default .report/report.json). Under REDLINE_GATE=1 it sets a
// non-zero exit code unless every case is "pass".

export const reportPath = (env = process.env) =>
  env.REDLINE_REPORT ||
  join(import.meta.dirname, "..", ".report", "report.json");

const modeOf = (env = process.env) => {
  try {
    const m = JSON.parse(env.REDLINE_TARGETS ?? "{}").mode;
    return typeof m === "string" ? m : "staging";
  } catch {
    return "unknown";
  }
};

export function collect(
  modules: ReadonlyArray<TestModule>,
  unhandled: ReadonlyArray<unknown>,
  root: string,
): CaseResult[] {
  const cases: CaseResult[] = [];
  for (const m of modules) {
    const file = relative(root, m.moduleId);
    const broken = m.errors().length > 0;
    for (const t of m.children.allTests()) {
      const state = t.result().state;
      // A test skipped because its module or suite setup failed is a failure.
      const setupFailed =
        state === "skipped" &&
        (broken ||
          (t.parent.type === "suite" && t.parent.state() === "failed"));
      const { level, reason } = setupFailed
        ? { level: "fail" as const, reason: "setup failed" }
        : levelOf(state, t.meta());
      cases.push({
        name: t.fullName,
        file,
        level,
        ...(reason ? { reason } : {}),
      });
    }
    if (m.errors().length > 0)
      cases.push({
        name: `${file}: module error`,
        file,
        level: "fail",
        reason: "error outside a test",
      });
  }
  if (unhandled.length > 0)
    cases.push({
      name: "unhandled errors",
      level: "fail",
      reason: `${unhandled.length} unhandled`,
    });
  return cases;
}

export default class RedlineReporter implements Reporter {
  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandled: ReadonlyArray<unknown>,
  ): void {
    const report = buildReport(
      collect(modules, unhandled, join(import.meta.dirname, "..")),
      modeOf(),
    );
    const out = reportPath();
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const text = formatReport(report);
    writeFileSync(out.replace(/\.json$/, "") + ".txt", text, { mode: 0o600 });
    process.stdout.write(`\n${text}`);
    if (process.env.REDLINE_GATE === "1" && !report.gate.passed)
      process.exitCode = 1;
  }
}
