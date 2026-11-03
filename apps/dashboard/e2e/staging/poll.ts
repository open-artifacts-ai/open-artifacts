// T19 polls on a product signal, never on a fixed budget (#1251): read until
// the answer stops being pending, bounded only by the test's own timeout. A
// read that throws (a hook refusal, a bad status) fails at once.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function untilSettled<T>(
  read: () => Promise<T>,
  pending: (value: T) => boolean,
  o: { intervalMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const wait = o.wait ?? sleep;
  for (;;) {
    const v = await read();
    if (!pending(v)) return v;
    await wait(o.intervalMs ?? 1000);
  }
}
