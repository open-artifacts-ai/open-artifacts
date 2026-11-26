// T19 polls on a product signal, never on a fixed budget (#1251): read until
// the answer stops being pending, bounded only by the test's own timeout. A
// read that throws (a hook refusal, a bad status) fails at once.
import { expect } from "@playwright/test";

export async function untilSettled<T>(
  read: () => Promise<T>,
  pending: (value: T) => boolean,
  o: { intervalMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const interval = o.intervalMs ?? 1000;
  if (o.wait) {
    for (;;) {
      const v = await read();
      if (!pending(v)) return v;
      await o.wait(interval);
    }
  }
  const PENDING = Symbol("pending");
  let settled: { ok: true; value: T } | { ok: false; err: unknown } | undefined;
  await expect(async () => {
    try {
      const v = await read();
      if (pending(v)) throw PENDING;
      settled = { ok: true, value: v };
    } catch (err) {
      if (err === PENDING) throw err;
      settled = { ok: false, err };
    }
  }).toPass({ intervals: [interval], timeout: 0 });
  if (!settled?.ok) throw settled?.err;
  return settled.value;
}
