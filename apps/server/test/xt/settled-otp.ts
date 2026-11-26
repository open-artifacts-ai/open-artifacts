// The cross-tenant sign-in catalog's wait for an OTP send to be final
// (signin-negative.ts), as a function of its seams so a unit test can drive it
// on a fake clock and a fake ask: nothing is accepted past the deadline.

/** The most one ask may take: the time left, as an abort signal. */
const defaultSignalFor = (ms: number): AbortSignal => AbortSignal.timeout(ms);

export type SettleOtp<R extends { status: number }> = {
  /** One ask of the hook: it holds up to `wait` ms, and is cut off when `signal` aborts. */
  ask: (wait: number, signal: AbortSignal) => Promise<R>;
  /** A 404's recognized outcome, or null when it names none. */
  outcome: (r: R) => Promise<string | null>;
  /** The whole bound on the wait, from the first ask. */
  deadlineMs: number;
  /** The most one ask holds for. */
  holdMs: number;
  /** Quick "pending" answers in a row before the hook is judged not to hold requests. */
  quickMax: number;
  /** Makes the error to throw. */
  fail: (message: string) => Error;
  /** Where the hook is, for messages. */
  where: string;
  now?: () => number;
  signalFor?: (ms: number) => AbortSignal;
};

/**
 * Asks until the send's outcome is final, within `deadlineMs` in all. Each ask
 * holds for the time left at most (capped at `holdMs`) and is itself cut off
 * at the deadline, so a held ask never runs past it; an answer that arrives
 * after the deadline is refused, whatever it says.
 */
export async function settleOtp<R extends { status: number }>(
  o: SettleOtp<R>,
): Promise<R> {
  const now = o.now ?? Date.now;
  const signalFor = o.signalFor ?? defaultSignalFor;
  const end = now() + o.deadlineMs;
  const pending = () =>
    o.fail(`otp hook on ${o.where}: still pending after ${o.deadlineMs} ms`);
  let quick = 0;
  for (;;) {
    const left = end - now();
    if (left <= 0) throw pending();
    const hold = Math.min(left, o.holdMs);
    const asked = now();
    const signal = signalFor(left);
    const cut = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(pending()), { once: true }),
    );
    const r = await Promise.race([o.ask(hold, signal), cut]);
    if (now() > end)
      throw o.fail(
        `otp hook on ${o.where}: answered after the ${o.deadlineMs} ms bound`,
      );
    if (r.status !== 404) return r;
    const outcome = await o.outcome(r);
    if (outcome === null)
      throw o.fail(`otp hook on ${o.where}: 404 with no recognized outcome`);
    if (outcome !== "pending") return r;
    quick = now() - asked < hold / 2 ? quick + 1 : 0;
    if (quick > o.quickMax)
      throw o.fail(
        `otp hook on ${o.where}: answers "pending" without holding the request`,
      );
  }
}

/**
 * A response with its body read in full, inside the ask: the headers having
 * come on time is not enough, so the body is read here (and cut off with the
 * ask's signal) before the ask counts as answered. What is returned has the
 * body in memory, so a later read of it takes no time.
 */
export async function buffered(
  r: Response,
  signal: AbortSignal,
): Promise<Response> {
  const cut = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    }),
  );
  const body = await Promise.race([r.arrayBuffer(), cut]);
  return new Response(body, {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
  });
}
