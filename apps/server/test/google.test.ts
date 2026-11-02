import { env } from "cloudflare:workers";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeRedirect,
  handleCallback,
  stateCookieName,
} from "../src/auth/oidc.js";
import { googleProvider } from "../src/auth/providers/google.js";
import type { Env } from "../src/env.js";
import { CID, direct } from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";

// P2 Task 4: Sign in with Google (direct transport), verified by the install.
let g: FakeGoogle;
beforeEach(async () => {
  g = await fakeGoogle();
});
afterEach(() => vi.restoreAllMocks());

/** Starts a Google sign-in; returns what the callback needs. */
async function begin(e: Env = direct(), next = "/a/x") {
  const r = await buildAuthorizeRedirect(e, googleProvider, next);
  const loc = new URL(r.location);
  const state = loc.searchParams.get("state") as string;
  const value = r.stateCookie.split(";")[0]?.split("=").slice(1).join("=");
  return {
    loc,
    state,
    nonce: loc.searchParams.get("nonce") as string,
    challenge: loc.searchParams.get("code_challenge") as string,
    cookie: `${await stateCookieName(e, state)}=${value}`,
  };
}
const callback = (b: { state: string; cookie: string }, code: string) =>
  new Request(
    `http://app.localhost${AUTH.callbackGoogle}?state=${b.state}&code=${code}`,
    { headers: { cookie: b.cookie } },
  );
const logs = () => {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "warn").mockImplementation((s: unknown) => {
    lines.push(JSON.parse(String(s)));
  });
  return lines;
};

describe("google provider (direct)", () => {
  it("authorize URL: client, redirect, scope, PKCE S256, select_account, hd hint", async () => {
    const { loc } = await begin();
    expect(`${loc.origin}${loc.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({
      client_id: CID,
      redirect_uri: `http://app.localhost${AUTH.callbackGoogle}`,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      hd: "a.com",
      code_challenge_method: "S256",
    });
  });

  it("round trip: PKCE verifier sent, identity with hd as tenant, next kept", async () => {
    const e = direct();
    const b = await begin(e);
    const code = g.issueCode({ nonce: b.nonce, name: "Bob" }, b.challenge);
    const r = await handleCallback(e, googleProvider, callback(b, code));
    expect(r).toEqual({
      provider: "google",
      subject: "google-sub-1",
      email: "bob@a.com",
      name: "Bob",
      tenant: "a.com",
      authTime: null,
      next: "/a/x",
      reauth: false,
    });
    const sent = g.tokenCalls[0];
    expect(sent?.get("client_secret")).toBe("s");
    expect(sent?.get("redirect_uri")).toBe(
      `http://app.localhost${AUTH.callbackGoogle}`,
    );
  });

  it.each([
    [{ hd: "b.com" }, "tenant"],
    [{ hd: "" }, "tenant"],
    [{ email_verified: false }, "email_unverified"],
    [{ hd: undefined, email_verified: false }, "email_unverified"],
    [{ aud: "other" }, "jwt_verify"],
    [{ azp: "other" }, "azp"],
  ])("refuses %o (stage %s), logging only the stage", async (claims, stage) => {
    const e = direct();
    const lines = logs();
    const b = await begin(e);
    const code = g.issueCode({ nonce: b.nonce, ...claims }, b.challenge);
    await expect(
      handleCallback(e, googleProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(lines).toEqual([{ evt: "oidc_fail", stage }]);
  });

  it("tenant B's token at install A is refused", async () => {
    const e = direct({ AUTH_DOMAINS: "a.com" });
    const b = await begin(e);
    const code = g.issueCode(
      { nonce: b.nonce, hd: "b.com", email: "eve@b.com" },
      b.challenge,
    );
    await expect(
      handleCallback(e, googleProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("a token for another flow's nonce is refused", async () => {
    const e = direct();
    const b = await begin(e);
    const code = g.issueCode({ nonce: "another-flow" }, b.challenge);
    await expect(
      handleCallback(e, googleProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("a token signed by an unknown key is refused", async () => {
    const e = direct();
    const b = await begin(e);
    const other = (await generateKeyPair("RS256")).privateKey;
    const code = g.issueCode({ nonce: b.nonce }, b.challenge, other);
    await expect(
      handleCallback(e, googleProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("a wrong PKCE verifier fails at Google; no identity", async () => {
    const e = direct();
    const b = await begin(e);
    const code = g.issueCode({ nonce: b.nonce }, "wrong-challenge");
    await expect(
      handleCallback(e, googleProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("a replayed code fails (single use at Google)", async () => {
    const e = direct();
    const b = await begin(e);
    const code = g.issueCode({ nonce: b.nonce }, b.challenge);
    await handleCallback(e, googleProvider, callback(b, code));
    await expect(
      handleCallback(e, googleProvider, callback(b, code)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("an upstream error never leaks detail", async () => {
    const e = direct();
    const lines = logs();
    g.setTokenStatus(500);
    const b = await begin(e);
    await expect(
      handleCallback(e, googleProvider, callback(b, "c")),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(lines).toEqual([{ evt: "oidc_fail", stage: "token_http_500" }]);
  });

  it("no hd (a personal account): the identity has tenant null; admission decides", async () => {
    const e = direct();
    const b = await begin(e);
    const code = g.issueCode(
      { nonce: b.nonce, hd: undefined, email: "bob@gmail.com" },
      b.challenge,
    );
    const r = await handleCallback(e, googleProvider, callback(b, code));
    expect(r).toMatchObject({
      provider: "google",
      email: "bob@gmail.com",
      tenant: null,
    });
  });

  it("no AUTH_DOMAINS: Google is offered with no hd hint", async () => {
    const { loc } = await begin(direct({ AUTH_DOMAINS: "" }));
    expect(loc.searchParams.get("client_id")).toBe(CID);
    expect(loc.searchParams.has("hd")).toBe(false);
  });

  it("Google not configured: no authorize URL and no token call", async () => {
    const e = direct({ GOOGLE_CLIENT_ID: "" });
    await expect(
      buildAuthorizeRedirect(e, googleProvider, "/"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(g.tokenCalls).toHaveLength(0);
  });

  it("logs never contain the code, nonce, email or token", async () => {
    const e = direct();
    const raw: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((s: unknown) => {
      raw.push(String(s));
    });
    const b = await begin(e);
    const code = g.issueCode({ nonce: b.nonce, hd: "b.com" }, b.challenge);
    await handleCallback(e, googleProvider, callback(b, code)).catch(() => {});
    const text = raw.join("\n");
    for (const s of [
      code,
      b.nonce,
      b.state,
      "bob@a.com",
      "eyJ",
      env.SESSION_SECRET,
    ])
      expect(text).not.toContain(s);
  });

  it("the token endpoint is Google's", () => {
    expect(GOOGLE_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");
  });
});
