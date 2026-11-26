import {
  claimHookSlot,
  HOOK_LIMIT,
  hook404IsTheKeys,
  hookWindowCount,
  type PaceOpts,
} from "./hook-ledger";

// #1254: T19's side of the runner's hook budget. Every rl-a /__test/* call
// takes a slot in the same ledger the red-line live suite uses (keyed by
// rl-a's app origin), so the two share one count against RL_HOOKS. The count
// never makes a call wait: past the budget a call fails at once, named.

/** Records a hook call to `app`; HookBudgetError when the budget is spent. */
export function paceT19Hook(
  app: string,
  o: Pick<PaceOpts, "root" | "now"> = {},
): Promise<number> {
  return claimHookSlot(app, o);
}

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
