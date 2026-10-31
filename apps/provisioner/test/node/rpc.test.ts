// ProvisionerRpc's module functions (design v7 2.6): the release catalog of
// RELEASES, siteverify with the env widget's secret (or Turnstile's test
// secret for a staging test user only), and the token's status. No answer
// carries a token or secret.
import { ReleaseSchema, TokenStatusSchema } from "@oa/shared/provisioning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import {
  listReleases,
  provisionTokenStatus,
  verifyTurnstileToken,
} from "../../src/rpc.js";
import { NOW, TS, V1, V2, type World, world } from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

const TEST_SECRET = "1x0000000000000000000000000000000AA";

let w: World;
beforeEach(async () => {
  w = await world();
});

/** fake-cf, with siteverify answered by `answer` (it sees the form). */
function withSiteverify(answer: (f: FormData) => unknown) {
  const forms: FormData[] = [];
  const io = {
    ...w.ctx.io,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.hostname === "challenges.cloudflare.com") {
        const f = init?.body as FormData;
        forms.push(f);
        return Response.json(answer(f));
      }
      return w.fake.fetch(input, init);
    }) as typeof fetch,
  };
  return { io, forms };
}

const input = (
  o: Partial<Parameters<typeof verifyTurnstileToken>[1]> = {},
) => ({
  token: "tok",
  remoteIp: "192.0.2.1",
  action: "signup" as const,
  hostname: "signup.open-artifacts-staging.app",
  testUser: false,
  ...o,
});

describe("releases()", () => {
  it("the catalog of RELEASES: verified variants, installable, one latest", async () => {
    const r = await listReleases(w.env);
    expect(r.map((x) => ReleaseSchema.parse(x))).toEqual([
      {
        version: V2,
        publishedAt: 0,
        variants: ["release", "redline"],
        installable: true,
        latest: true,
      },
      {
        version: V1,
        publishedAt: 0,
        variants: ["release", "redline"],
        installable: true,
        latest: false,
      },
    ]);
  });
});

describe("verifyTurnstile()", () => {
  it("checks the token with the env widget's secret, its action and hostname", async () => {
    const { io, forms } = withSiteverify(() => ({
      success: true,
      action: "signup",
      hostname: "signup.open-artifacts-staging.app",
    }));
    expect(await verifyTurnstileToken(w.env, input(), io)).toEqual({
      ok: true,
    });
    expect(forms[0]?.get("secret")).toBe(TS.secret);
    expect(forms[0]?.get("response")).toBe("tok");
    expect(forms[0]?.get("remoteip")).toBe("192.0.2.1");
    // Another hostname or action in the answer is a refusal.
    const other = withSiteverify(() => ({
      success: true,
      action: "signup",
      hostname: "evil.example",
    }));
    expect(await verifyTurnstileToken(w.env, input(), other.io)).toEqual({
      ok: false,
    });
    const no = withSiteverify(() => ({ success: false }));
    expect(await verifyTurnstileToken(w.env, input(), no.io)).toEqual({
      ok: false,
    });
  });

  it("testUser on staging uses the always-pass test secret; on prod it is ignored", async () => {
    const { io, forms } = withSiteverify(() => ({
      success: true,
      hostname: "example.com",
    }));
    expect(
      await verifyTurnstileToken(w.env, input({ testUser: true }), io),
    ).toEqual({ ok: true });
    expect(forms[0]?.get("secret")).toBe(TEST_SECRET);
    const prod = { ...w.env, OA_ENV: "prod" };
    const p = withSiteverify(() => ({
      success: true,
      hostname: "example.com",
    }));
    // prod has no widget on this fake account: refused before any siteverify.
    await expect(
      verifyTurnstileToken(prod, input({ testUser: true }), p.io),
    ).rejects.toThrow();
    expect(p.forms).toHaveLength(0);
  });

  it("a malformed input is refused with no call", async () => {
    const { io, forms } = withSiteverify(() => ({ success: true }));
    for (const bad of [
      input({ token: "" }),
      input({ token: "x".repeat(2049) }),
      input({ action: "login" as never }),
      input({ hostname: "not a host" }),
      input({ remoteIp: "a b" }),
    ])
      expect(await verifyTurnstileToken(w.env, bad, io)).toEqual({ ok: false });
    expect(forms).toHaveLength(0);
  });
});

describe("tokenStatus()", () => {
  const DAY = 86_400_000;
  it("active, expiring within 30 days, or invalid; never a token field", async () => {
    w.fake.tokenInfo = {
      ...w.fake.tokenInfo,
      expires_on: new Date(NOW + 200 * DAY).toISOString(),
    };
    const a = await provisionTokenStatus(w.env, w.ctx.io);
    expect(TokenStatusSchema.parse(a)).toEqual({
      status: "active",
      expiresAt: NOW + 200 * DAY,
      daysLeft: 200,
    });
    w.fake.tokenInfo = {
      ...w.fake.tokenInfo,
      expires_on: new Date(NOW + 30 * DAY).toISOString(),
    };
    expect((await provisionTokenStatus(w.env, w.ctx.io)).status).toBe(
      "expiring",
    );
    w.fake.tokenInfo = { ...w.fake.tokenInfo, status: "disabled" };
    expect(await provisionTokenStatus(w.env, w.ctx.io)).toEqual({
      status: "invalid",
      expiresAt: null,
      daysLeft: null,
    });
    w.fake.tokenInfo = {
      ...w.fake.tokenInfo,
      status: "active",
      expires_on: undefined,
    };
    expect((await provisionTokenStatus(w.env, w.ctx.io)).status).toBe(
      "invalid",
    );
    expect(JSON.stringify(a)).not.toContain(w.fake.token);
  });

  it("a refused token is invalid; a 5xx throws (the API keeps its cached answer)", async () => {
    w.fake.inject((_m, p) => p.endsWith("/user/tokens/verify"), {
      status: 401,
    });
    expect((await provisionTokenStatus(w.env, w.ctx.io)).status).toBe(
      "invalid",
    );
    w.fake.inject((_m, p) => p.endsWith("/user/tokens/verify"), {
      status: 503,
      times: 10,
    });
    await expect(provisionTokenStatus(w.env, w.ctx.io)).rejects.toThrow(
      "internal",
    );
  });
});
