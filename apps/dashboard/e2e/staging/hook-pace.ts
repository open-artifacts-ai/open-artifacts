import { type TestInfo, test } from "@playwright/test";
import {
  claimHookSlot,
  HOOK_LIMIT,
  hook404IsTheKeys,
  hookWindowCount,
  type PaceOpts,
  waitHookWindowClear,
} from "../../../../tests/redline/src/hook-ledger";

// #1254: T19's side of the runner's hook budget. Every rl-a /__test/* call
// takes a slot in the same ledger the red-line live suite uses (keyed by
// rl-a's app origin), spread to one call per HOOK_GAP_MS, so T19 never
// bursts past RL_ANON and shares the budget with the suite on one runner.

/** Kept back from the running test's timeout, for the call itself. */
export const DEADLINE_MARGIN_MS = 5_000;

const firstSeen = new WeakMap<TestInfo, number>();

/**
 * When the running test (or hook) must have made its hook call: its own
 * timeout, counted from its first hook call (tests make that call first),
 * less a margin. None outside a test, or with no timeout.
 */
export function hookDeadline(now = Date.now()): number | undefined {
  let info: TestInfo;
  try {
    info = test.info();
  } catch {
    return undefined;
  }
  if (!info.timeout) return undefined;
  const start = firstSeen.get(info) ?? now;
  firstSeen.set(info, start);
  return start + info.timeout - DEADLINE_MARGIN_MS;
}

/** Waits for a slot for a hook call to `app`; HookBudgetError past the deadline. */
export const paceT19Hook = (
  app: string,
  o: Pick<PaceOpts, "root" | "now" | "sleep" | "deadline"> = {},
): Promise<number> =>
  claimHookSlot(app, { spread: true, deadline: hookDeadline(), ...o });

/** Before any rl-a case: wait until the suite's calls have left the window. */
export const clearT19HookWindow = (app: string): Promise<void> =>
  waitHookWindowClear(app, { deadline: hookDeadline() });

/**
 * The error for a failed hook call. A bare 404 is read as the hooks' own
 * (off, or the key) only while the ledger is under budget.
 */
export function hookFailure(
  app: string,
  what: string,
  status: number,
  o: Pick<PaceOpts, "root" | "now"> = {},
): Error {
  if (status === 404) {
    const n = hookWindowCount(app, o);
    if (!hook404IsTheKeys(n))
      return new Error(
        `${what}: 404 with the hook budget full (${n} of ${HOOK_LIMIT} in the window): may be the rate limit, not the key`,
      );
  }
  return new Error(`${what}: ${status}`);
}
