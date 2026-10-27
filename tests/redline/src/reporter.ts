import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";
import {
  applyManifest,
  buildReport,
  type CaseResult,
  formatReport,
  infraOf,
  labelOf,
  levelOf,
  type Manifest,
  parseManifest,
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

export const manifestPath = (env = process.env) =>
  env.REDLINE_MANIFEST ||
  join(import.meta.dirname, "..", "live", "manifest.json");

/** The manifest, or null when missing or invalid (that is a FAIL case). */
export function loadManifest(path = manifestPath()): Manifest | null {
  try {
    return existsSync(path) ? parseManifest(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

/** True when any ancestor suite of `t` failed (its beforeAll, say). */
function ancestorFailed(t: TestCase): boolean {
  for (let p = t.parent; p.type === "suite"; p = p.parent)
    if (p.state() === "failed") return true;
  return false;
}

/** The setup errors behind a skipped test: its failed suites' and module's. */
function setupErrors(t: TestCase, m: TestModule): { message?: unknown }[] {
  const out: { message?: unknown }[] = [...m.errors()];
  for (let p = t.parent; p.type === "suite"; p = p.parent)
    if (p.state() === "failed") out.push(...p.errors());
  return out;
}

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
      const result = t.result();
      const state = result.state;
      // A test skipped because its module or suite setup failed is a failure
      // (infra when every setup error is infra; never a pass either way).
      const setupFailed = state === "skipped" && (broken || ancestorFailed(t));
      const infra = setupFailed ? infraOf(setupErrors(t, m)) : undefined;
      const { level, reason } = setupFailed
        ? infra
          ? { level: "infra" as const, reason: infra }
          : { level: "fail" as const, reason: "setup failed" }
        : levelOf(
            state,
            t.meta(),
            result.state === "failed" ? result.errors : [],
          );
      const label = labelOf(t.meta());
      cases.push({
        name: t.fullName,
        file,
        level,
        ...(reason ? { reason } : {}),
        ...(label ? { label } : {}),
      });
    }
    if (m.errors().length > 0) {
      const infra = infraOf(m.errors());
      cases.push({
        name: `${file}: module error`,
        file,
        level: infra ? "infra" : "fail",
        reason: infra ?? "error outside a test",
      });
    }
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
    const root = join(import.meta.dirname, "..");
    const report = buildReport(
      applyManifest(collect(modules, unhandled, root), loadManifest()),
      modeOf(),
    );
    const out = reportPath();
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const text = formatReport(report);
    writeFileSync(out.replace(/\.json$/, "") + ".txt", text, { mode: 0o600 });
    process.stdout.write(`\n${text}`);
    // A FAIL or infra always fails the run; with the gate, so does any non-pass.
    if (
      report.counts.fail > 0 ||
      report.counts.infra > 0 ||
      (process.env.REDLINE_GATE === "1" && !report.gate.passed)
    )
      process.exitCode = 1;
  }
}
