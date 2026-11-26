// T19 polls on a product signal, never on a fixed budget (#1251): read until
// the answer stops being pending, bounded only by the test's own timeout. A
// read that throws (a hook refusal, a bad status) fails at once.
//
// There is no interval and no sleep: a read that is still pending is held by
// the host (the otp/latest hook's `waitMs` holds the call until the send
// lands, up to a bound), so a loop turn is one request, not a spin. A caller
// whose read returns at once while pending must not use this.

export async function untilSettled<T>(
  read: () => Promise<T>,
  pending: (value: T) => boolean,
): Promise<T> {
  for (;;) {
    const v = await read();
    if (!pending(v)) return v;
  }
}
