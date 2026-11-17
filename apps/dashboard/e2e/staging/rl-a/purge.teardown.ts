import { TEST_HOOKS, type TestPeoplePurgeResult } from "@oa/shared";
import { expect, test } from "@playwright/test";
import { hook, RUN } from "./fixtures";

// #2680: every T19 run signs in new people (t19-<run>-<tag>@TEST_DOMAIN).
// Kept, they pile up on rl-a (thousands by v0.199.2) and slow every
// Settings > Members case. After the run, erase this run's people, then any
// older run's left behind (a crashed run, or the backlog), oldest first.
// People from the last two hours stay: another gate run may be using them.

/** Time this teardown may spend erasing (T19_PURGE_BUDGET_MS for a one-off drain). */
// T19's cases take about 4 min of the 15 min globalTimeout.
const BUDGET_MS = Number(process.env.T19_PURGE_BUDGET_MS ?? 7 * 60_000);
const OTHER_RUNS_AGE_MS = 2 * 60 * 60_000;
// Small enough that one call stays well inside FETCH_MS (30 s).
const PER_CALL = 10;

/** Erases matching people until none are left, a call erases nobody, or time is up. */
async function drain(prefix: string, before: number, stop: number) {
  const total = { erased: 0, failed: 0, left: 0 };
  while (Date.now() < stop) {
    const r = await hook<TestPeoplePurgeResult>(TEST_HOOKS.peoplePurge, {
      prefix,
      before,
      limit: PER_CALL,
    });
    total.erased += r.erased;
    total.failed += r.failed;
    total.left = r.left;
    if (r.left === 0 || r.erased === 0) break;
  }
  console.log(`T19 purge ${prefix}: ${JSON.stringify(total)}`);
  return total;
}

test("erase this run's people, and older runs' left behind", async () => {
  test.setTimeout(BUDGET_MS + 60_000);
  const now = Date.now();
  const stop = now + BUDGET_MS;
  const mine = await drain(`t19-${RUN}-`, now, stop);
  // This run's people must go; a leftover here means the purge is broken.
  expect(mine.failed).toBe(0);
  // Older runs' people are best effort: a slow call never fails the gate,
  // and the next run carries on where this one stopped.
  await drain("t19-", now - OTHER_RUNS_AGE_MS, stop).catch((e) =>
    console.log(`T19 purge of older runs stopped: ${String(e)}`),
  );
});
