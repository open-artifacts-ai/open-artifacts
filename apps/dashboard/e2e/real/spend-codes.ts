// Spending device codes left outstanding (bus-confirm.ts spendDeviceCodes):
// a redeem answers whatever the code's state, so a refusal's leftover code
// frees its slot (an IP holds five). Each spend is bounded and its errors are
// ignored: teardown never fails a test and never waits past the bound.
import { withDeadline } from "../staging/with-deadline";

/** How long one spend may take. */
export const SPEND_BOUND_MS = 3_000;

export async function spendCodes(
  base: string,
  codes: string[],
  f: typeof fetch = fetch,
  deadline: typeof withDeadline = withDeadline,
): Promise<void> {
  await Promise.all(
    codes.map((device_code) => {
      // The bound abandons the call, so it is cancelled with it, and nothing
      // is left running after the teardown returns.
      const call = new AbortController();
      return deadline(
        f(`${base}/bus/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code }),
          signal: call.signal,
        }).then((r) => r.body?.cancel()),
        SPEND_BOUND_MS,
        "spending a device code",
      )
        .catch(() => undefined)
        .finally(() => call.abort());
    }),
  );
}
