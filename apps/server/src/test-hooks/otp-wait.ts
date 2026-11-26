// The otp/latest hook's wait (`wait` ms): the signal that a send's outcome
// changed, kept in the one DirectorySync DO per install, so the hook that is
// holding a request hears the write the delivery made in another request. The
// D1 row stays the source of truth; this only says "read it again".
//
// Only directory/sync.ts (testOtp*) and the hook reach this, each through a
// build-flag gate: release builds drop it with the rest of test-hooks/.

/**
 * The longest the hook holds one request: under a live runner's 10 s request
 * bound, so the client asks again for more (each ask is a hold, not a poll).
 */
export const OTP_WAIT_CAP_MS = 8_000;

/**
 * Change numbers come from one counter for the whole DO, so they only grow.
 * A key is held here only while someone waits on it; every other key reads as
 * `floor`, the newest change number nobody holds, and a change to a key with
 * no waiter just moves `floor` on. So reads and unwatched changes keep
 * nothing, and a reader that took a number before a change always finds a
 * different one after it (a spurious wake costs one read; a missed one would
 * cost the whole hold).
 */
const state = new Map<string, { version: number; waiters: Set<() => void> }>();
let counter = 0;
let floor = 0;

/** The row for `ek` changed: every waiter wakes. */
export function otpChanged(ek: string): void {
  const s = state.get(ek);
  counter++;
  if (!s) {
    floor = counter;
    return;
  }
  s.version = counter;
  for (const w of [...s.waiters]) w();
}

/** The change number a reader took before reading the row. Keeps nothing. */
export function otpVersion(ek: string): number {
  return state.get(ek)?.version ?? floor;
}

/** Keys held right now: only those with a waiter (for tests). */
export function otpKeys(): number {
  return state.size;
}

/**
 * Resolves when the row changed after `since` (any other version counts, so a
 * restarted DO never strands a waiter), or at `ms`: the bound, not a poll.
 */
export function otpWaitAfter(
  ek: string,
  since: number,
  ms: number,
): Promise<void> {
  if (otpVersion(ek) !== since) return Promise.resolve();
  let s = state.get(ek);
  if (!s) {
    // Nothing changed since `since`: hold the key only while it is waited on.
    s = { version: since, waiters: new Set() };
    state.set(ek, s);
  }
  const held = s;
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      held.waiters.delete(done);
      if (held.waiters.size === 0) {
        // Nobody waits: let the key go, its number becomes the floor.
        floor = Math.max(floor, held.version);
        state.delete(ek);
      }
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, OTP_WAIT_CAP_MS));
    held.waiters.add(done);
  });
}
