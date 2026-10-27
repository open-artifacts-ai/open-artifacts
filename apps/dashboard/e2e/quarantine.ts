// The e2e quarantine (quarantine.json): flaky tests taken out of the gating
// suites while their owner fixes them. CI still runs them, in shard 1, without
// failing the build (scripts/ci/e2e.sh quarantine); the nightly run repeats
// them 10 times, and one that passes all 10 is reported as ready to come out.
//
// A fix that takes a test out follows the flaky-test rules:
// 1. Wait for a signal, not for time: expect.poll, vi.waitFor or a hook that
//    resolves, never a fixed sleep, an iteration count or a tight wall-clock
//    budget. A remaining deadline is generous (10 s or more).
// 2. Derive windows from upstream bounds (the producer's own timeout, imported,
//    plus slack) and pin clocks (midday UTC) for anything that reads "today".
// 3. Isolate live and shared resources: retry only idempotent requests on
//    transient errors, prove a local server is our own process, and build
//    shared outputs once, never under concurrency.
import { readFileSync } from "node:fs";

export type Suite = "mock" | "real";

export interface Quarantined {
  /** Spec path under e2e/: "nav.spec.ts" (mock suite) or "real/consent.spec.ts". */
  file: string;
  /** The title path as reporters print it: describe titles, then the test, joined by " › ". */
  title: string;
  /** Who fixes it (a team or lead, not a person's address). */
  owner: string;
  /** YYYY-MM-DD it went in. */
  since: string;
  reason: string;
}

const FILE = new URL("./quarantine.json", import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and checks quarantine.json; throws on a malformed or duplicate entry. */
export function parseQuarantine(text: string): Quarantined[] {
  const tests = (JSON.parse(text) as { tests?: unknown }).tests;
  if (!Array.isArray(tests))
    throw new Error("quarantine: tests must be an array");
  const seen = new Set<string>();
  return tests.map((t, i) => {
    const e = t as Partial<Quarantined>;
    for (const k of ["file", "title", "owner", "since", "reason"] as const)
      if (typeof e[k] !== "string" || !e[k]?.trim())
        throw new Error(`quarantine[${i}]: ${k} is required`);
    const q = e as Quarantined;
    if (!/^(real\/)?[\w.-]+\.spec\.ts$/.test(q.file))
      throw new Error(`quarantine[${i}]: file must be a spec under e2e/`);
    if (!DATE.test(q.since))
      throw new Error(`quarantine[${i}]: since must be YYYY-MM-DD`);
    const key = `${q.file} ${q.title}`;
    if (seen.has(key)) throw new Error(`quarantine[${i}]: duplicate ${key}`);
    seen.add(key);
    return q;
  });
}

export const loadQuarantine = (): Quarantined[] =>
  parseQuarantine(readFileSync(FILE, "utf8"));

export const suiteOf = (q: Quarantined): Suite =>
  q.file.startsWith("real/") ? "real" : "mock";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The suite's quarantined tests as a Playwright grep, or undefined when it has
 * none. Playwright matches grep against "<project> <file under testDir>
 * <describe titles> <test title> <tags>", space-separated.
 */
export function quarantineGrep(
  entries: Quarantined[],
  suite: Suite,
): RegExp | undefined {
  const mine = entries.filter((q) => suiteOf(q) === suite);
  if (mine.length === 0) return undefined;
  const one = (q: Quarantined) =>
    `${esc(q.file.replace(/^real\//, ""))} ${esc(q.title.split(" › ").join(" "))}`;
  // Only tags (each "@...") may follow the title: a longer title must not match.
  return new RegExp(`(^| )(${mine.map(one).join("|")})(?= @|$)`);
}

/**
 * The grep options for a suite's config. The gating runs skip quarantined
 * tests; OA_E2E_QUARANTINE=only runs just them (e2e.sh quarantine).
 */
export function quarantineOptions(
  suite: Suite,
  env: Record<string, string | undefined> = process.env,
): { grep?: RegExp; grepInvert?: RegExp } {
  const re = quarantineGrep(loadQuarantine(), suite);
  if (env.OA_E2E_QUARANTINE === "only") return { grep: re ?? /$^/ };
  return re ? { grepInvert: re } : {};
}
