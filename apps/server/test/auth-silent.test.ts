import { env } from "cloudflare:workers";
import { AUTH, SIGN_IN_PAGE } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { googleProvider } from "../src/auth/providers/google.js";
import { sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { direct, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

// Silent Google sign-in (#2026), instance side: the ticket is passed to the
// broker and scrubbed, one picker fallback, no loop, no session replaced.
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
const T = "1700000000000.abcdefgh12345678.123.kid.sig";
const brokerEnv = () =>
  direct({
    AUTH_BROKER_URL: "https://auth.h.test",
    BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  });
const get = (path: string, e: Env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const loc = (r: Response) => r.headers.get("location") ?? "";
const stateCookie = (r: Response) =>
  (r.headers.getSetCookie().find((c) => /oa_oidc_/.test(c)) ?? "").split(
    ";",
  )[0];
const hasSession = (r: Response) =>
  r.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${SESSION}=`) && !/Max-Age=0/i.test(c));
afterEach(() => vi.restoreAllMocks());

describe("silent login pass-through", () => {
  it("passes the ticket to the broker, with no-store and no-referrer", async () => {
    const r = await get(`${AUTH.loginGoogle}?silent=${T}`, brokerEnv());
    expect(new URL(loc(r)).searchParams.get("silent")).toBe(T);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("reauth=1, a malformed ticket and the direct transport do not pass it", async () => {
    expect(
      new URL(
        loc(await get(`${AUTH.loginGoogle}?silent=${T}&reauth=1`, brokerEnv())),
      ).searchParams.has("silent"),
    ).toBe(false);
    expect(
      new URL(
        loc(await get(`${AUTH.loginGoogle}?silent=a%20b%22`, brokerEnv())),
      ).searchParams.has("silent"),
    ).toBe(false);
    expect(
      new URL(
        loc(await get(`${AUTH.loginGoogle}?silent=${T}`, direct())),
      ).searchParams.has("silent"),
    ).toBe(false);
  });

  it("an existing session (any user) turns silent off", async () => {
    const { cookie } = await login(uniq("have"));
    const r = await get(`${AUTH.loginGoogle}?silent=${T}`, brokerEnv(), cookie);
    expect(new URL(loc(r)).searchParams.has("silent")).toBe(false);
  });
});

describe("silent fallback", () => {
  it.each([
    "login_required",
    "interaction_required",
    "consent_required",
    "account_selection_required",
  ])(
    "%s: one retry with the picker, fresh state and PKCE, then no loop",
    async (err) => {
      const e = brokerEnv();
      const first = await get(
        `${AUTH.loginGoogle}?silent=${T}&next=%2Fa%2Fx`,
        e,
      );
      const u1 = new URL(loc(first));
      const back = await get(
        `${AUTH.callbackGoogle}?error=${err}&state=${u1.searchParams.get("state")}`,
        e,
        stateCookie(first),
      );
      // The attempt is cleared and the retry carries no ticket.
      expect(
        back.headers.getSetCookie().some((c) => /oa_oidc_.*Max-Age=0/i.test(c)),
      ).toBe(true);
      expect(loc(back)).toBe(`${AUTH.loginGoogle}?next=%2Fa%2Fx`);
      expect(hasSession(back)).toBe(false);
      const second = await get(loc(back), e);
      const u2 = new URL(loc(second));
      expect(u2.searchParams.has("silent")).toBe(false);
      expect(u2.searchParams.get("state")).not.toBe(
        u1.searchParams.get("state"),
      );
      expect(u2.searchParams.get("code_challenge")).not.toBe(
        u1.searchParams.get("code_challenge"),
      );
      // The picker attempt asking for interaction again is a plain failure.
      const again = await get(
        `${AUTH.callbackGoogle}?error=${err}&state=${u2.searchParams.get("state")}`,
        e,
        stateCookie(second),
      );
      expect(loc(again)).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
    },
  );

  it("a forged or missing state does not fall back", async () => {
    const e = brokerEnv();
    const first = await get(`${AUTH.loginGoogle}?silent=${T}`, e);
    const r = await get(
      `${AUTH.callbackGoogle}?error=login_required&state=bad`,
      e,
      stateCookie(first),
    );
    expect(loc(r)).not.toBe(`${AUTH.loginGoogle}?next=%2F`);
    expect(loc(r)).toContain("retry=1");
  });
});

describe("silent result handling", () => {
  it("a broker that refuses the token (sub mismatch) creates no session", async () => {
    const e = brokerEnv();
    const first = await get(`${AUTH.loginGoogle}?silent=${T}&next=%2Fa%2Fx`, e);
    const state = new URL(loc(first)).searchParams.get("state");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "sub_mismatch" }, { status: 403 }),
    );
    const r = await get(
      `${AUTH.callbackGoogle}?state=${state}&code=c&bstate=b`,
      e,
      stateCookie(first),
    );
    expect(loc(r)).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
    expect(hasSession(r)).toBe(false);
  });

  it("a silent result never replaces another user's session", async () => {
    const e = brokerEnv();
    const first = await get(`${AUTH.loginGoogle}?silent=${T}`, e);
    const state = new URL(loc(first)).searchParams.get("state");
    const owner = await login(uniq("newowner", "a.com"));
    const other = await login(uniq("someone"));
    vi.spyOn(googleProvider, "redeem").mockResolvedValue({
      provider: "google",
      subject: "s-owner",
      email:
        (
          await env.DB.prepare("select email from users where id = ?")
            .bind(owner.userId)
            .first<{ email: string }>()
        )?.email ?? "",
      name: null,
      tenant: "a.com",
    });
    const r = await get(
      `${AUTH.callbackGoogle}?state=${state}&code=c`,
      e,
      `${stateCookie(first)}; ${other.cookie}`,
    );
    expect(hasSession(r)).toBe(false);
  });
});
