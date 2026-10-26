import { env } from "cloudflare:workers";
import { AUTH, SIGN_IN_PAGE } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { direct, uniq } from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";

// P5 R6 (plan Task 6), the ID-token cases on P2's fake-Google fixture: two
// installs (different Google clients, verified domains, secrets and install
// ids) behind the real routes. Live installs can't be handed a validly
// signed Google token with a chosen hd/aud, so the live suite reports these
// unproven-live; this is where they run. Every refusal sits next to its two
// successes: B's own token signs in at B, A's signs in at A.
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const SESSION = sessionCookieName(env);

const CID_A = "cid-a.apps.googleusercontent.com";
const CID_B = "cid-b.apps.googleusercontent.com";
const install = (id: string, cid: string, domain: string, secret: string) =>
  direct({
    INSTALL_ID: id,
    GOOGLE_CLIENT_ID: cid,
    AUTH_DOMAINS: domain,
    SESSION_SECRET: secret,
  });
const A = {
  env: install("xt-ga", CID_A, "a.com", "a".repeat(40)),
  cid: CID_A,
  domain: "a.com",
};
const B = {
  env: install("xt-gb", CID_B, "b.com", "b".repeat(40)),
  cid: CID_B,
  domain: "b.com",
};
type Side = typeof A;

let g: FakeGoogle;
beforeEach(async () => {
  g = await fakeGoogle();
});
afterEach(() => vi.restoreAllMocks());

const get = (e: Env, path: string, cookie?: string) =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      redirect: "manual",
      ...(cookie ? { headers: { cookie } } : {}),
    }),
    e,
    ctx,
  );

/** A real sign-in start at `s`: its state, nonce, challenge and state cookie. */
async function begin(s: Side) {
  const r = await get(s.env, `${AUTH.loginGoogle}?next=%2F`);
  expect(r.status).toBe(302);
  const q = new URL(r.headers.get("location") ?? "").searchParams;
  const cookie =
    r.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return {
    state: q.get("state") as string,
    nonce: q.get("nonce") as string,
    challenge: q.get("code_challenge") as string,
    cookie,
  };
}
type Flow = Awaited<ReturnType<typeof begin>>;

const callback = (s: Side, f: Pick<Flow, "state" | "cookie">, code: string) =>
  get(
    s.env,
    `${AUTH.callbackGoogle}?state=${encodeURIComponent(f.state)}&code=${encodeURIComponent(code)}`,
    f.cookie,
  );

const setsSession = (r: Response) =>
  r.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${SESSION}=`) && !c.startsWith(`${SESSION}=;`));

/** A Google identity of side `s`: valid claims for its own client and domain. */
const own = (s: Side) => {
  const email = uniq("xt", s.domain);
  return { aud: s.cid, azp: s.cid, hd: s.domain, email, sub: `sub-${email}` };
};

async function signsIn(s: Side, claims: Record<string, unknown>) {
  const f = await begin(s);
  const r = await callback(
    s,
    f,
    g.issueCode({ nonce: f.nonce, ...claims }, f.challenge),
  );
  expect(r.status).toBe(302);
  expect(setsSession(r)).toBe(true);
}

async function refused(r: Response, error: "tenant" | "failed") {
  expect(r.status).toBe(302);
  expect(setsSession(r)).toBe(false);
  const loc = new URL(r.headers.get("location") ?? "", "http://app.localhost");
  expect(loc.pathname).toBe(SIGN_IN_PAGE);
  expect(loc.searchParams.get("error")).toBe(error);
}

/** B's own token signs in at B, A's at A; then `claims` (A-flavoured) at B's callback are refused. */
async function cross(
  claims: Record<string, unknown>,
  error: "tenant" | "failed",
) {
  await signsIn(B, own(B));
  await signsIn(A, own(A));
  const f = await begin(B);
  await refused(
    await callback(
      B,
      f,
      g.issueCode({ nonce: f.nonce, ...claims }, f.challenge),
    ),
    error,
  );
}

describe("sign-in ID-token cases across installs (fake Google)", () => {
  it("an ID token with hd of A at B's callback: no session", async () => {
    // A's own identity, for B's client: only the tenant differs.
    await cross({ ...own(A), aud: CID_B, azp: CID_B }, "tenant");
  });

  it("an ID token with a B email domain but hd of A: no session", async () => {
    const email = uniq("eve", B.domain);
    await cross(
      { aud: CID_B, azp: CID_B, hd: A.domain, email, sub: `sub-${email}` },
      "tenant",
    );
  });

  it("an ID token with no hd and a B email: no session", async () => {
    const email = uniq("eve", B.domain);
    await cross(
      { aud: CID_B, azp: CID_B, hd: undefined, email, sub: `sub-${email}` },
      "tenant",
    );
  });

  it("an ID token minted for A's client (aud) replayed at B: no session", async () => {
    // B's own tenant and email: only aud/azp say "A's client".
    await cross({ ...own(B), aud: CID_A, azp: CID_A }, "failed");
  });

  it("A's OIDC nonce in a token at B's flow: no session", async () => {
    await signsIn(B, own(B));
    await signsIn(A, own(A));
    const fa = await begin(A);
    const fb = await begin(B);
    // A token for B's client and tenant, but bound to A's flow nonce.
    const code = g.issueCode({ nonce: fa.nonce, ...own(B) }, fb.challenge);
    await refused(await callback(B, fb, code), "failed");
  });

  it("A's OIDC state and state cookie replayed at B: no session, never redeemed", async () => {
    const fa = await begin(A);
    const before = g.tokenCalls.length;
    const code = g.issueCode({ nonce: fa.nonce, ...own(B) }, fa.challenge);
    const r = await callback(B, fa, code);
    expect(setsSession(r)).toBe(false);
    // A state failure: back to B's own login (retry), and no code exchange.
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location") ?? "", "http://x").pathname).toBe(
      AUTH.loginGoogle,
    );
    expect(g.tokenCalls.length).toBe(before);
    // The same state, cookie and code still sign in at A (they were valid).
    const ok = await callback(
      A,
      fa,
      g.issueCode({ nonce: fa.nonce, ...own(A) }, fa.challenge),
    );
    expect(setsSession(ok)).toBe(true);
  });
});
