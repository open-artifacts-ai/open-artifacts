// T19 polls on a product signal, never on a fixed budget (#1251): read until
// the answer stops being pending, bounded only by the test's own timeout. A
// read that throws (a hook refusal, a bad status) fails at once.
//
// There is no interval between reads: each read is a request that takes its
// own time, and the reads that matter here are hook calls, which the hook
// pacer already spaces (hook-pace.ts). A caller whose reads are not paced by
// their own request must not use this.

export async function untilSettled<T>(
  read: () => Promise<T>,
  pending: (value: T) => boolean,
): Promise<T> {
  for (;;) {
    const v = await read();
    if (!pending(v)) return v;
  }
}
