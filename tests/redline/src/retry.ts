// One more try for a live case that failed only on a named infrastructure
// error (#1137). This can hide a failure, so it says no by default:
// - a deny leg, a refusal check or anything unnamed never retries;
// - `internal` never retries: it can be a bug of ours. Only a server's explicit
//   `storage_unavailable` and a request with no response at all count;
// - once, and a second failure fails;
// - at most MAX_RETRIED_CASES in a run, so an outage can't retry its way to
//   green. Past that, cases fail, as they should.
// Callers are read-only cases: a write isn't safe to run twice.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { note } from "./notes.ts";
import { NotRefused } from "./refused.ts";

export const MAX_RETRIED_CASES = 5;
export const RETRIED_PREFIX = "case retried";

/** Allow legs only. A deny leg, or an error naming no leg, never retries. */
const ALLOW_LEGS: readonly (string | undefined)[] = [
  "B's own credential at B",
  "A's credential at A",
];

/** The named error `e` is, or undefined: then it never retries. */
export function retryableError(e: unknown): string | undefined {
  if (e instanceof NotRefused || !(e instanceof Error)) return undefined;
  const leg = (e as { redline?: { leg?: string } }).redline?.leg;
  if (!ALLOW_LEGS.includes(leg)) return undefined;
  if (/, code storage_unavailable\b/.test(e.message))
    return "storage_unavailable";
  const cut = /^infra: .*got no response \(([A-Z_]+)\)/.exec(e.message);
  return cut?.[1];
}

export interface Budget {
  /** Takes one retry, or false when the run has spent them. */
  take(): boolean;
}

/**
 * Counted in a file beside the report: each live test file gets fresh module
 * state, and the cap is per run. Files run one at a time, so no lock is needed.
 */
export function runBudget(
  file = `${process.env.REDLINE_REPORT ?? ".report/report.json"}.retries`,
): Budget {
  return {
    take() {
      const n = existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
      if (n >= MAX_RETRIED_CASES) return false;
      writeFileSync(file, String(n + 1));
      return true;
    },
  };
}

/** Runs a read-only case, once more if `retryableError` names its failure. */
export async function retryCase<T>(
  run: () => Promise<T>,
  budget: Budget = runBudget(),
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const code = retryableError(e);
    if (!code) throw e;
    if (!budget.take()) {
      note(`case not retried (${code}): the run's cap is spent`);
      throw e;
    }
    note(`${RETRIED_PREFIX} once (${code})`);
    return await run();
  }
}
