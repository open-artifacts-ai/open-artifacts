import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";
import { suiteSha } from "./capture.ts";
import {
  applyManifest,
  buildReport,
  type CaseResult,
  failReason,
  formatReport,
  infraOf,
  labelOf,
  legOf,
  levelOf,
  type Manifest,
  notesOf,
  parseManifest,
  type RunBinding,
  redactReason,
  runKindOf,
  setupHookCase,
  setupHookName,
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
    // A setup hook's refusal (seeding, the admin session): one infra result
    // per file and hook refusal, not one per case it kept from running.
    const hooked = new Map<string, { infras: string[]; names: string[] }>();
    for (const t of m.children.allTests()) {
      const result = t.result();
      const state = result.state;
      // A test skipped because its module or suite setup failed is a failure
      // (infra when every setup error is infra; never a pass either way).
      const setupFailed = state === "skipped" && (broken || ancestorFailed(t));
      const setup = setupFailed ? setupErrors(t, m) : [];
      const infra = setupFailed ? infraOf(setup) : undefined;
      const hookName = setupHookName(infra);
      if (infra && hookName) {
        const h = hooked.get(hookName) ?? { infras: [], names: [] };
        // infraOf names only the first; keep every infra message.
        for (const e of setup) h.infras.push(String(e?.message ?? ""));
        h.names.push(t.fullName);
        hooked.set(hookName, h);
        continue;
      }
      const errors = result.state === "failed" ? result.errors : [];
      // Every non-pass carries a reason: a setup error (beforeAll, module)
      // or the test's own, redacted, plus its leg where crossCheck knew it.
      const { level, reason } = setupFailed
        ? infra
          ? { level: "infra" as const, reason: redactReason(infra) }
          : {
              level: "fail" as const,
              reason: `setup failed: ${failReason(setup)}`,
            }
        : levelOf(state, t.meta(), errors);
      const label = labelOf(t.meta());
      const notes = notesOf(t.meta());
      cases.push({
        name: t.fullName,
        file,
        level,
        ...(reason ? { reason } : {}),
        ...(label ? { label } : {}),
        ...(notes.length ? { notes } : {}),
        ...(level === "pass" ? {} : legOf(setupFailed ? setup : errors)),
      });
    }
    for (const [name, h] of hooked)
      cases.push(setupHookCase(name, h.infras, file, h.names));
    // The module's own error, unless it is the setup hook refusal just reported.
    if (
      m.errors().length > 0 &&
      !hooked.has(setupHookName(infraOf(m.errors())) ?? "")
    ) {
      const infra = infraOf(m.errors());
      cases.push({
        name: `${file}: module error`,
        file,
        level: infra ? "infra" : "fail",
        reason: infra
          ? redactReason(infra)
          : `error outside a test: ${failReason(m.errors())}`,
      });
    }
  }
  if (unhandled.length > 0)
    cases.push({
      name: "unhandled errors",
      level: "fail",
      reason: `${unhandled.length} unhandled: ${failReason(
        unhandled.map((e) => ({
          message: (e as { message?: unknown } | null)?.message ?? String(e),
        })),
      )}`,
    });
  return cases;
}

/** The notes a file recorded outside any test (live/setup.ts afterAll). */
export function collectFileNotes(
  modules: ReadonlyArray<Pick<TestModule, "moduleId" | "meta">>,
  root: string,
): { file: string; note: string }[] {
  return modules.flatMap((m) =>
    notesOf(m.meta()).map((note) => ({
      file: relative(root, m.moduleId),
      note,
    })),
  );
}

/**
 * The run's binding: REDLINE_TARGETS' install ids, their /healthz versions
 * now, and the suite's commit: the checkout's HEAD, which in CI is the tag
 * (GITHUB_SHA is the workflow's commit on main, so only a fallback). Undefined
 * without targets.
 */
export async function bindingOf(
  env: Record<string, string | undefined> = process.env,
): Promise<RunBinding | undefined> {
  let raw: { a?: { installId?: unknown; app?: unknown }; b?: typeof raw.a };
  try {
    raw = JSON.parse(env.REDLINE_TARGETS ?? "");
  } catch {
    return undefined;
  }
  const side = async (t: typeof raw.a) => {
    const id = typeof t?.installId === "string" ? t.installId : "";
    let version = "unknown";
    try {
      const r = await fetch(`${String(t?.app)}/healthz`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const v = ((await r.json()) as { version?: unknown }).version;
      if (typeof v === "string") version = v;
    } catch {}
    return { id, version };
  };
  const [a, b] = await Promise.all([side(raw.a), side(raw.b)]);
  if (!a.id || !b.id) return undefined;
  const head = suiteSha();
  return {
    installs: { a: a.id, b: b.id },
    versions: { a: a.version, b: b.version },
    suiteSha: head === "unknown" ? env.GITHUB_SHA || head : head,
  };
}

/**
 * One lane's results (scripts/redline.ts runs lanes as separate vitest runs):
 * its cases before the manifest, which only the whole run can apply.
 */
export interface LanePart {
  v: 1;
  cases: CaseResult[];
  fileNotes: { file: string; note: string }[];
}

/**
 * The report for the run's cases: the manifest applied, then the gate, for
 * this process's run (the reporter's, or scripts/redline.ts's for lanes).
 */
export async function finalReport(
  cases: readonly CaseResult[],
  fileNotes: readonly { file: string; note: string }[],
) {
  const binding = await bindingOf();
  return {
    ...buildReport(
      applyManifest(cases, loadManifest()),
      modeOf(),
      runKindOf(process.env),
    ),
    ...(binding ? { binding } : {}),
    ...(fileNotes.length ? { fileNotes: [...fileNotes] } : {}),
  };
}

/** Writes the report as JSON and text at `out` (0600) and returns the text. */
export function writeReport(
  report: Awaited<ReturnType<typeof finalReport>>,
  out: string,
): string {
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const text = formatReport(report);
  writeFileSync(out.replace(/\.json$/, "") + ".txt", text, { mode: 0o600 });
  return text;
}

export default class RedlineReporter implements Reporter {
  async onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandled: ReadonlyArray<unknown>,
  ): Promise<void> {
    const root = join(import.meta.dirname, "..");
    const cases = collect(modules, unhandled, root);
    const fileNotes = collectFileNotes(modules, root);
    // A lane: its part only; scripts/redline.ts builds the report and decides
    // the exit code once every lane is in.
    const part = process.env.REDLINE_REPORT_PART;
    if (part) {
      const p: LanePart = { v: 1, cases, fileNotes };
      mkdirSync(dirname(part), { recursive: true, mode: 0o700 });
      writeFileSync(part, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
      return;
    }
    const report = await finalReport(cases, fileNotes);
    const text = writeReport(report, reportPath());
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
