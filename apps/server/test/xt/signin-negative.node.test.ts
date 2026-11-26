import { describe, expect, it } from "vitest";
import { type Install, settledOtp } from "./signin-negative.js";

// The catalog's own settledOtp, with a fake install: its fetch is the only seam.
function install(fetch: Install["fetch"]): Install {
  return {
    origin: "https://stg-a.example.com",
    contentOrigin: "https://stg-a-content.example.com",
    hookKey: "k",
    sessionCookie: "s",
    codeCookie: "c",
    fetch,
  } as Install;
}

/** A body whose read takes `ms` on the fake clock: the clock moves when it is pulled. */
const slowBody = (json: unknown, onPull: () => void) =>
  new ReadableStream<Uint8Array>(
    {
      pull(c) {
        onPull();
        c.enqueue(new TextEncoder().encode(JSON.stringify(json)));
        c.close();
      },
    },
    { highWaterMark: 0 }, // pulled only when something reads it
  );

describe("signin-negative settledOtp", () => {
  it("headers on time, body after the bound: refused", async () => {
    let t = 1_000;
    const to = install(
      async () =>
        // The headers are here at once; reading the body takes 14 s.
        new Response(
          slowBody({ error: { details: { outcome: "sent" } } }, () => {
            t += 14_000;
          }),
          { status: 404 },
        ),
    );
    await expect(
      settledOtp(to, "a@b.test", {
        now: () => t,
        signalFor: () => new AbortController().signal,
      }),
    ).rejects.toThrow(/answered after the .* ms bound/);
  });

  it("an answer on time, body read in full, is returned", async () => {
    const to = install(
      async () =>
        new Response(JSON.stringify({ code: "123456" }), { status: 200 }),
    );
    const r = await settledOtp(to, "a@b.test");
    expect(((await r.json()) as { code: string }).code).toBe("123456");
  });
});
