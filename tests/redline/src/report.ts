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
