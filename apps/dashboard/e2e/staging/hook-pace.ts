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

/** When each test began (markTestStart, from an auto fixture in rl-a/fixtures.ts). */
const started = new WeakMap<TestInfo, number>();

/** Records the running test's start: its hook calls' deadline counts from it. */
export function markTestStart(info: TestInfo, now = Date.now()): void {
  started.set(info, now);
}

/** The running test or hook's TestInfo; none outside one (a worker fixture). */
function currentInfo(): TestInfo | undefined {
  try {
    return test.info();
  } catch {
    return undefined;
  }
}

/**
 * When the running test (or hook) must have made its hook call: its own
 * timeout less a margin, counted from the test's start (markTestStart). A
 * beforeAll/afterAll hook has no test-scoped fixture, so it counts from its
 * first hook call: T19's hooks make that call first (a session). None
 * outside a test or hook, or with no timeout.
 */
export function hookDeadline(
  now: number = Date.now(),
  info: TestInfo | undefined = currentInfo(),
): number | undefined {
  if (!info?.timeout) return undefined;
  const start = started.get(info) ?? now;
  started.set(info, start);
  return start + info.timeout - DEADLINE_MARGIN_MS;
}

type T19PaceOpts = Pick<PaceOpts, "root" | "now" | "sleep"> & {
  /** The running test (default test.info()). */
  info?: TestInfo;
};

const deadlineOf = (o: T19PaceOpts) =>
  hookDeadline((o.now ?? Date.now)(), "info" in o ? o.info : currentInfo());

/** Waits for a slot for a hook call to `app`; HookBudgetError past the deadline. */
export function paceT19Hook(app: string, o: T19PaceOpts = {}): Promise<number> {
  const { info: _, ...rest } = o;
  return claimHookSlot(app, { ...rest, spread: true, deadline: deadlineOf(o) });
}

/** Before any rl-a case: wait until the suite's calls have left the window. */
export function clearT19HookWindow(
  app: string,
  o: T19PaceOpts = {},
): Promise<void> {
  const { info: _, ...rest } = o;
  return waitHookWindowClear(app, { ...rest, deadline: deadlineOf(o) });
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
