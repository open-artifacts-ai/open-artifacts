/**
 * A fail-fast bound on an operation that may never finish: rejects with an
 * Error naming `label` once `ms` pass, so a hung step fails by name and not by
 * the whole test's timeout. Nothing waits it out in a passing run: the timer is
 * cleared the moment `op` settles.
 *
 * The timer is a plain `setTimeout` armed here, outside any Promise executor,
 * so a fake clock drives it (`vi.useFakeTimers`, then advance past `ms`).
 */
export function withDeadline<T>(
  op: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let fail: (e: Error) => void = () => {};
  const late = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const timer = setTimeout(
    () => fail(new Error(`${label}: no answer after ${ms} ms`)),
    ms,
  );
  return Promise.race([op, late]).finally(() => clearTimeout(timer));
}
