// Proof levels and the gate rule (the Manager's): every case reports exactly
// one level, and the gate passes only when EVERY case is "pass". staging-only,
// not-applicable, unproven-live and infra never count as a pass, and neither
// do a skipped test, an empty run or an error outside a test. "infra" is a
// case (or its setup) that failed only on "infra: " errors (a setup publish or
// a settle wait that ran out of time): no red-line verdict, never green.

export const LEVELS = [
  "pass",
  "fail",
  "staging-only",
  "not-applicable",
  "unproven-live",
  "infra",
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
  /** What happened on the way, level unchanged, e.g. a retried setup GET (src/notes.ts). */
  notes?: string[];
  /** Where crossCheck/crossWrite failed, when they know (src/refused.ts LegInfo). */
  leg?: string;
  host?: string;
  expected?: string;
  actual?: string;
  /**
   * A setup hook's infra result (setupHookCase): the file and the cases its
   * refusal kept from running, which the manifest then counts as run.
   */
  blocked?: { file: string; cases: string[] };
}

/**
 * Why an inventory case is unproven. In a laptop capture run
 * (REDLINE_CAPTURE_RUN=1, scripts/signin-capture.ts) the inventory bearer is
 * a GitHub OIDC JWT the redline job mints, so the case is CI-only; never a pass either way.
 */
export function noInventoryReason(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.REDLINE_CAPTURE_RUN === "1"
    ? "CI-only (not-local): the inventory bearer is a GitHub OIDC JWT only the redline job mints, so a laptop capture run can't prove this case"
    : "no inventory configured (REDLINE_STG_INVENTORY_URL and its OIDC JWT)";
}

/** Longest reason kept in the report (redacted first, then cut). */
export const MAX_REASON = 600;

/**
 * An error message made safe for the report: OAuth codes, states, nonces,
 * cookies, bearer and ID tokens, emails and any long opaque value are
 * replaced; what's left names the leg, the install, statuses and paths.
 */
/** Secret-bearing parameter names, after `=` (and, for the OAuth ones, `:`). */
const EQ_KEYS =
  "code|state|bstate|nonce|login_hint|code_challenge|code_verifier|id_token|access_token|refresh_token|client_secret|token|key|sig|as";
const COLON_KEYS =
  "code|state|bstate|nonce|login_hint|code_challenge|code_verifier|id_token|access_token|refresh_token|client_secret";
const VALUE = `[^&\\s)"',;}\\]]+`;

export function redactReason(s: string, max = MAX_REASON): string {
  let out = s
    // Percent-encoded separators first, so encoded values match below.
    .replace(/%40/gi, "@")
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")
    .replace(/%3D/gi, "=")
    .replace(/%22/gi, '"')
    .replace(/%2B/gi, "+")
    // Every Cookie / Set-Cookie value (names kept).
    .replace(
      /\b(set-cookie|cookie)(\s*:\s*)([^\n|]*)/gi,
      (_m, h, sep, v) =>
        `${h}${sep}${String(v).replace(/([^=;\s,]+)=([^;,]*)/g, "$1=[redacted]")}`,
    )
    .replace(
      /\b((?:__Host-|__Secure-)[A-Za-z0-9_.-]*|oa_[A-Za-z0-9_]*)=[^;\s,)"']*/g,
      "$1=[redacted]",
    )
    .replace(
      new RegExp(
        `((?:^|[?&;\\s(",{'\\[])"?(?:${EQ_KEYS})"?\\s*=\\s*"?)${VALUE}`,
        "gi",
      ),
      "$1[redacted]",
    )
    .replace(
      new RegExp(
        `((?:^|[?&;\\s(",{'\\[])"?(?:${COLON_KEYS})"?\\s*:\\s*"?)${VALUE}`,
        "gi",
      ),
      "$1[redacted]",
    )
    // "nonce 9fK2_aB3cD": a key, a space, then a token-like value (has a digit).
    .replace(
      /\b(nonce|state|bstate|code|login_hint)\s+(?=[A-Za-z0-9_./-]*\d)[A-Za-z0-9_./-]{8,}/gi,
      "$1 [redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;)"']+/gi, "$1 [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g,
      "[token]",
    )
    // Google access and refresh tokens, at any length.
    .replace(/\bya29\.[A-Za-z0-9_.-]*/g, "[token]")
    .replace(/(^|[^A-Za-z0-9/])1\/\/[A-Za-z0-9_.-]*/g, "$1[token]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b4\/[A-Za-z0-9_-]{4,}/g, "[code]")
    .replace(/\br1\.[A-Za-z0-9_.-]+/g, "r1.[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}

/** What a failure records: its first error, redacted (plus how many more). */
export function failReason(errors: readonly { message?: unknown }[]): string {
  const msgs = errors
    .map((e) => String(e?.message ?? "").trim())
    .filter((m) => m !== "");
  if (msgs.length === 0) return "failed (no error message)";
  const more = msgs.length > 1 ? ` (+${msgs.length - 1} more errors)` : "";
  return `${redactReason(msgs[0] as string)}${more}`;
}

/** The leg fields src/refused.ts attaches to an error, redacted, if any. */
export function legOf(errors: readonly unknown[]): Partial<CaseResult> {
  const r = (errors[0] as { redline?: Record<string, unknown> } | undefined)
    ?.redline;
  if (!r || typeof r !== "object") return {};
  const out: Partial<CaseResult> = {};
  for (const k of ["leg", "host", "expected", "actual"] as const)
    if (typeof r[k] === "string" && r[k] !== "")
      out[k] = redactReason(r[k] as string, 300);
  return out;
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
  /** What this run ran against (the reporter): what combine() matches verdicts to. */
  binding?: RunBinding;
  /** Set by combine(): the capture run whose verdicts replaced the ID-token cases. */
  combined?: { runNonce: string; verdictsFinishedAt: number };
  /** Notes recorded outside any test (beforeAll), by file. */
  fileNotes?: { file: string; note: string }[];
}

export interface RunBinding {
  installs: { a: string; b: string };
  versions: { a: string; b: string };
  suiteSha: string;
}

/** What a live case attaches to its task meta to report a non-pass level. */
export interface ProofMeta {
  level: Exclude<Level, "pass" | "fail" | "infra">;
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

/** The notes src/notes.ts put on a task's (or a file's) meta, redacted. */
export function notesOf(meta: object | undefined): string[] {
  const n = (meta as { redlineNotes?: unknown } | undefined)?.redlineNotes;
  return Array.isArray(n)
    ? n
        .filter((x): x is string => typeof x === "string" && x !== "")
        .map((x) => redactReason(x, 300))
    : [];
}

/** The label `label()` set on a task's meta, if any. */
export function labelOf(meta: object | undefined): string | undefined {
  const l = (meta as { redlineLabel?: unknown } | undefined)?.redlineLabel;
  return typeof l === "string" && l !== "" ? l : undefined;
}

/** The prefix of an error that is infra, not a red-line verdict (InfraError). */
export const INFRA_PREFIX = "infra: ";

/**
 * The start of a setup hook's InfraError (src/http.ts SetupHookError):
 * "infra: setup <hook> <reason>", the reason a fixed enum word.
 */
export const SETUP_HOOK_RE =
  /^infra: setup (\/__test\/[\w/-]+) ([a-z_]+)(?=\s|$)/;

/** "infra: setup <hook> <reason>" when `infra` is a setup hook's error, else undefined. */
export function setupHookName(infra: string | undefined): string | undefined {
  const m = infra ? SETUP_HOOK_RE.exec(infra) : null;
  return m ? `infra: setup ${m[1]} ${m[2]}` : undefined;
}

/**
 * The one infra result for every case of `file` a setup hook's refusal kept
 * from running (instead of one result per case).
 */
export function setupHookCase(
  name: string,
  infras: readonly string[],
  file: string,
  cases: string[],
): CaseResult {
  // Every distinct infra message behind it, the hook's first.
  const all = [...new Set(infras)].join("; ");
  return {
    name,
    level: "infra",
    reason: `${redactReason(all)}; ${cases.length} case(s) in ${file} did not run`,
    blocked: { file, cases: [...cases] },
  };
}

/**
 * The first message when there is at least one error and every one is infra
 * (it names a phase, a duration and an install, never a secret).
 */
export function infraOf(
  errors: readonly { message?: unknown }[],
): string | undefined {
  const msgs = errors.map((e) => String(e?.message ?? ""));
  return msgs.length > 0 && msgs.every((m) => m.startsWith(INFRA_PREFIX))
    ? msgs[0]
    : undefined;
}

/**
 * Maps a vitest outcome to a level. A failure always wins over a proof mark;
 * a failure whose errors are all infra is "infra" (still never a pass).
 */
export function levelOf(
  state: "passed" | "failed" | "skipped" | "pending",
  meta: object | undefined,
  errors: readonly { message?: unknown }[] = [],
): { level: Level; reason?: string } {
  if (state === "failed") {
    const infra = infraOf(errors);
    return infra
      ? { level: "infra", reason: redactReason(infra) }
      : { level: "fail", reason: failReason(errors) };
  }
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
  // A setup hook's infra result stands for the cases it kept from running.
  for (const c of cases)
    if (c.level === "infra" && c.blocked)
      for (const n of c.blocked.cases) seen.add(caseKey(c.blocked.file, n));
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
          : `${nonPass.length} of ${cases.length} cases are not "pass"${counts.infra ? ` (${counts.infra} infra)` : ""}`,
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
    for (const c of r.nonPass) {
      lines.push(`  [${c.level}] ${c.name}${c.reason ? ` (${c.reason})` : ""}`);
      if (c.leg || c.host || c.expected)
        lines.push(
          `      leg: ${c.leg ?? "?"} at ${c.host ?? "?"}; expected ${c.expected ?? "?"}${c.actual ? `; got ${c.actual}` : ""}`,
        );
    }
  }
  const labeled = r.cases.filter((c) => c.label);
  if (labeled.length) {
    lines.push("Labeled:");
    for (const c of labeled) lines.push(`  [${c.label}] ${c.name}`);
  }
  const noted = r.cases.filter((c) => c.notes?.length);
  if (noted.length || r.fileNotes?.length) {
    lines.push("Notes:");
    for (const n of r.fileNotes ?? []) lines.push(`  [${n.file}] ${n.note}`);
    for (const c of noted)
      for (const n of c.notes ?? []) lines.push(`  ${c.name}: ${n}`);
  }
  lines.push(`Gate: ${r.gate.passed ? "PASS" : "FAIL"} (${r.gate.reason})`);
  return `${lines.join("\n")}\n`;
}

/**
 * Exit code: a failed run is 1 whatever the mode, and so is an infra case
 * (it failed its test); with the gate, any non-pass is 1.
 */
export function exitCode(r: Report | null, gate: boolean, runExit = 0): number {
  if (!r) return 1;
  if (runExit !== 0 || r.counts.fail > 0 || r.counts.infra > 0)
    return runExit || 1;
  return gate && !r.gate.passed ? 1 : 0;
}

export const gateOn = (
  argv: readonly string[],
  env: Record<string, string | undefined>,
) => argv.includes("--gate") || env.REDLINE_GATE === "1";
