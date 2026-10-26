// Proof levels and the gate rule (the Manager's): every case reports exactly
// one level, and the gate passes only when EVERY case is "pass". staging-only,
// not-applicable and unproven-live never count as a pass, and neither do a
// skipped test, an empty run or an error outside a test.

export const LEVELS = [
  "pass",
  "fail",
  "staging-only",
  "not-applicable",
  "unproven-live",
] as const;
export type Level = (typeof LEVELS)[number];

export interface CaseResult {
  name: string;
  file?: string;
  level: Level;
  /** Why a case isn't a pass (never a secret or a response body). */
  reason?: string;
  /** What a pass rests on when it isn't the real thing, e.g. "Turnstile test key". */
  label?: string;
}

export interface Report {
  mode: string;
  finishedAt: string;
  total: number;
  counts: Record<Level, number>;
  /** Every case that isn't "pass", by name. */
  nonPass: CaseResult[];
  cases: CaseResult[];
  gate: { passed: boolean; reason: string };
}

/** What a live case attaches to its task meta to report a non-pass level. */
export interface ProofMeta {
  level: Exclude<Level, "pass" | "fail">;
  reason: string;
}

/** The minimum of a vitest test context `proof` needs. */
export interface TaskLike {
  task: { meta: object };
}

/**
 * Marks a running case as staging-only, not-applicable or unproven-live. The
 * case then returns without asserting; vitest counts it passed, the report
 * (and the gate) don't.
 */
export function proof(
  ctx: TaskLike,
  level: ProofMeta["level"],
  reason: string,
): void {
  (ctx.task.meta as { redline?: ProofMeta }).redline = { level, reason };
}

/**
 * Labels a running case (its level is unchanged), so the report says what its
 * result rests on, e.g. "Turnstile test key" for code sign-in on installs
 * running Cloudflare's always-pass test secret.
 */
export function label(ctx: TaskLike, text: string): void {
  (ctx.task.meta as { redlineLabel?: string }).redlineLabel = text;
}

/** The label `label()` set on a task's meta, if any. */
export function labelOf(meta: object | undefined): string | undefined {
  const l = (meta as { redlineLabel?: unknown } | undefined)?.redlineLabel;
  return typeof l === "string" && l !== "" ? l : undefined;
}

/** Maps a vitest outcome to a level. A failure always wins over a proof mark. */
export function levelOf(
  state: "passed" | "failed" | "skipped" | "pending",
  meta: object | undefined,
): { level: Level; reason?: string } {
  if (state === "failed") return { level: "fail" };
  if (state === "skipped")
    return { level: "not-applicable", reason: "skipped" };
  if (state === "pending") return { level: "fail", reason: "did not finish" };
  const m = (
    meta as { redline?: { level?: unknown; reason?: unknown } } | undefined
  )?.redline;
  const marked = ["staging-only", "not-applicable", "unproven-live"] as const;
  const lv = marked.find((l) => l === m?.level);
  if (lv) return { level: lv, reason: String(m?.reason ?? "") };
  return { level: "pass" };
}

/**
 * The required-case manifest (live/manifest.json): every case the suite must
 * run, by file and full name. Adding a case is a manifest edit.
 */
export interface Manifest {
  cases: { file: string; name: string }[];
}

/** Parses a manifest; throws on any other shape. */
export function parseManifest(text: string): Manifest {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("the required-case manifest is not JSON");
  }
  const cases = (v as { cases?: unknown } | null)?.cases;
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    !cases.every(
      (c) =>
        c &&
        typeof c.file === "string" &&
        c.file !== "" &&
        typeof c.name === "string" &&
        c.name !== "",
    )
  )
    throw new Error("the required-case manifest has no valid cases list");
  return { cases: cases as Manifest["cases"] };
}

const caseKey = (file: string, name: string) => `${file}\u0000${name}`;

/**
 * A required case that didn't run (a missing or renamed file or test) is a
 * FAIL, and so is a case the manifest doesn't list. Cases without a file
 * (module or unhandled errors) pass through.
 */
export function applyManifest(
  cases: readonly CaseResult[],
  m: Manifest | null,
): CaseResult[] {
  if (!m)
    return [
      ...cases,
      {
        name: "required-case manifest",
        level: "fail",
        reason: "missing or invalid",
      },
    ];
  const required = new Set(m.cases.map((c) => caseKey(c.file, c.name)));
  const seen = new Set<string>();
  const out: CaseResult[] = cases.map((c) => {
    if (!c.file) return c;
    const k = caseKey(c.file, c.name);
    seen.add(k);
    return required.has(k)
      ? c
      : { ...c, level: "fail", reason: "not in the required-case manifest" };
  });
  for (const r of m.cases)
    if (!seen.has(caseKey(r.file, r.name)))
      out.push({
        name: r.name,
        file: r.file,
        level: "fail",
        reason: "required case did not run",
      });
  return out;
}

export function gatePasses(cases: readonly CaseResult[]): boolean {
  return cases.length > 0 && cases.every((c) => c.level === "pass");
}

export function buildReport(
  cases: readonly CaseResult[],
  mode = "unknown",
): Report {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<
    Level,
    number
  >;
  for (const c of cases) counts[c.level]++;
  const nonPass = cases.filter((c) => c.level !== "pass");
  const passed = gatePasses(cases);
  return {
    mode,
    finishedAt: new Date().toISOString(),
    total: cases.length,
    counts,
    nonPass,
    cases: [...cases],
    gate: {
      passed,
      reason: passed
        ? "every case passed"
        : cases.length === 0
          ? "no cases ran"
          : `${nonPass.length} of ${cases.length} cases are not "pass"`,
    },
  };
}

export function formatReport(r: Report): string {
  const lines = [
    `Red-line report (${r.mode}): ${r.total} cases`,
    `  ${LEVELS.map((l) => `${l} ${r.counts[l]}`).join(", ")}`,
  ];
  if (r.nonPass.length) {
    lines.push("Not pass:");
    for (const c of r.nonPass)
      lines.push(`  [${c.level}] ${c.name}${c.reason ? ` (${c.reason})` : ""}`);
  }
  const labeled = r.cases.filter((c) => c.label);
  if (labeled.length) {
    lines.push("Labeled:");
    for (const c of labeled) lines.push(`  [${c.label}] ${c.name}`);
  }
  lines.push(`Gate: ${r.gate.passed ? "PASS" : "FAIL"} (${r.gate.reason})`);
  return `${lines.join("\n")}\n`;
}

/** Exit code: a failed run is 1 whatever the mode; with the gate, any non-pass is 1. */
export function exitCode(r: Report | null, gate: boolean, runExit = 0): number {
  if (!r) return 1;
  if (runExit !== 0 || r.counts.fail > 0) return runExit || 1;
  return gate && !r.gate.passed ? 1 : 0;
}

export const gateOn = (
  argv: readonly string[],
  env: Record<string, string | undefined>,
) => argv.includes("--gate") || env.REDLINE_GATE === "1";
