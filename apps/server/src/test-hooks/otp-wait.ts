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

/** Per address key: how many times its row changed since this DO started, and who waits. */
const state = new Map<string, { version: number; waiters: Set<() => void> }>();
const of = (ek: string) => {
  let s = state.get(ek);
  if (!s) {
    s = { version: 0, waiters: new Set() };
    state.set(ek, s);
  }
  return s;
};

/** The row for `ek` changed: every waiter wakes. */
export function otpChanged(ek: string): void {
  const s = of(ek);
  s.version++;
  for (const w of [...s.waiters]) w();
}

/** The change count a reader took before reading the row. */
export function otpVersion(ek: string): number {
  return of(ek).version;
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
  const s = of(ek);
  if (s.version !== since) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      s.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, OTP_WAIT_CAP_MS));
    s.waiters.add(done);
  });
}
