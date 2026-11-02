import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;

// Semver with an optional prerelease and build suffix: 0.3.0, 0.3.0-dev+abc1234.
const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

describe.skipIf(!base)("staging smoke", () => {
  it("GET /healthz", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    // Staging runs PLAN=paid (wrangler.staging.jsonc); /healthz reports it.
    // Hosted installs also report an opaque installId; self-host omits it.
    // oauthStore (#826): the OAuth store's mode and markers, never null here
    // (null means D1 couldn't be read).
    const body = (await r.json()) as {
      ok: boolean;
      plan: string;
      version: string;
      installId?: string;
      oauthStore?: unknown;
    };
    const { installId, oauthStore, ...rest } = body;
    expect(rest).toEqual({
      ok: true,
      plan: "paid",
      version: expect.stringMatching(SEMVER),
    });
    if (installId !== undefined) expect(installId).toMatch(/^\S+$/);
    expect(oauthStore).toEqual({
      mode: expect.stringMatching(/^(kv|dual|d1)$/),
      backfilled: expect.any(Boolean),
      kvWritesOffSince: expect.toSatisfy(
        (v: unknown) =>
          v === null || (Number.isInteger(v) && (v as number) > 0),
      ),
    });
  });
});
