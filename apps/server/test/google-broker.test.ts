import { env } from "cloudflare:workers";
import {
  brokerNonce,
  flowHash,
  keyId,
  publicFromPkcs8,
  signRedeem,
} from "@oa/auth-core";
import { AUTH, SIGN_IN_PAGE } from "@oa/shared";
import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import broker, { type Env as BrokerEnv } from "../../auth-broker/src/index.js";
import { clearRegistryCache } from "../../auth-broker/src/registry.js";
import { createApp } from "../src/app.js";
import { googleProvider } from "../src/auth/providers/google.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { CID, direct, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";

// P2 Task 11, install side: Google through the hosted broker. The real broker
// module runs behind the BROKER service binding; the install verifies Google's
// raw ID token itself, so a lying broker can't sign anyone in.
const app = createApp();
const APP = "http://app.localhost";
const BROKER = "https://auth.hosted.test";
const SESSION = sessionCookieName(env);
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** A permissive RL stub for the broker's own rate-limit bindings. */
const brokerRl = () => ({
  limit: async () => ({ success: true }),
});
const brokerEnv = {
  BROKER_REGISTRY: env.OAUTH_KV,
  GOOGLE_CLIENT_ID: CID,
  GOOGLE_CLIENT_SECRET: "broker-secret",
  BROKER_ORIGIN: BROKER,
  BROKER_STATE_KEY: "s".repeat(40),
  RL_BROKER_IP: brokerRl(),
  RL_BROKER_INSTALL: brokerRl(),
} as unknown as BrokerEnv;

/** The install's env, with BROKER bound to `handler` (the real broker by default). */
const installEnv = (
  handler?: (req: Request) => Promise<Response>,
  over: Partial<Env> = {},
) =>
  direct({
    AUTH_BROKER_URL: BROKER,
    BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    BROKER: {
      fetch: (req: Request) =>
        handler ? handler(req) : broker.fetch(req as never, brokerEnv),
    } as unknown as Fetcher,
    ...over,
  });

let g: FakeGoogle;
beforeEach(async () => {
  g = await fakeGoogle();
  clearRegistryCache();
  const x = await publicFromPkcs8(TEST_BROKER_KEY);
  const key = { kid: await keyId(x), x };
  await env.OAUTH_KV.put(
    "install:inst-a",
    JSON.stringify({
      installId: "inst-a",
      origin: "https://app.localhost",
      keys: [key],
      domains: ["a.com"],
    }),
  );
  await env.OAUTH_KV.put(
    "install:inst-b",
    JSON.stringify({
      installId: "inst-b",
      origin: "https://app.localhost",
      keys: [key],
      domains: ["b.com"],
    }),
  );
});
afterEach(() => vi.restoreAllMocks());

const get = (e: Env, path: string, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const loc = (r: Response) => r.headers.get("location") ?? "";

/** Install login → broker authorize; returns the Google authorize params and the state cookie. */
async function begin(e: Env, extra = "") {
  const start = await get(e, `${AUTH.loginGoogle}?next=/a/x${extra}`);
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  const toBroker = new URL(loc(start));
  const toGoogle = await broker.fetch(
    new Request(toBroker) as never,
    brokerEnv,
  );
  const gq = new URL(toGoogle.headers.get("location") ?? "").searchParams;
  return {
    cookie,
    installState: toBroker.searchParams.get("state") as string,
    /** The install's own nonce (kept in its state cookie). */
    clientNonce: toBroker.searchParams.get("nonce") as string,
    bstate: gq.get("state") as string,
    /** The install-derived nonce Google sees. */
    nonce: gq.get("nonce") as string,
    challenge: gq.get("code_challenge") as string,
    toBroker,
    google: gq,
  };
}

const challengeFor = async (verifier: string) =>
  b64urlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );

describe("Google through the broker", () => {
  it("round trip: install → broker → Google → broker → install, session p=google t=a.com", async () => {
    const e = installEnv();
    const b = await begin(e);
    const email = uniq("bob");
    const code = g.issueCode(
      { nonce: b.nonce, email, sub: `b-${email}` },
      b.challenge,
    );
    const back = await broker.fetch(
      new Request(
        `${BROKER}/google/callback?code=${code}&state=${encodeURIComponent(b.bstate)}`,
      ) as never,
      brokerEnv,
    );
    const u = new URL(loc(back));
    expect(`${u.origin}${u.pathname}`).toBe(
      `https://app.localhost${AUTH.callbackGoogle}`,
    );
    expect(u.searchParams.get("state")).toBe(b.installState);
    const r = await get(e, `${AUTH.callbackGoogle}${u.search}`, b.cookie);
    expect(loc(r)).toBe("/a/x");
    const sess = r.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`))
      ?.split(";")[0]
      ?.split("=")[1];
    expect(await readSession(e, sess)).toMatchObject({
      p: "google",
      t: "a.com",
    });
    // Google saw the broker's secret, never the install's.
    expect(g.tokenCalls.at(-1)?.get("client_secret")).toBe("broker-secret");
  });

  it("break-glass reauth (P3 T18) through the broker: max_age=0 at Google; a recent auth_time marks the session", async () => {
    const e = installEnv();
    const plain = await begin(e);
    expect(plain.toBroker.searchParams.get("reauth")).toBeNull();
    expect(plain.google.get("max_age")).toBeNull();
    const b = await begin(e, "&reauth=1");
    expect(b.toBroker.searchParams.get("reauth")).toBe("1");
    expect(b.google.get("max_age")).toBe("0");
    const email = uniq("bg");
    const authTime = Math.floor(Date.now() / 1000) - 30;
    const code = g.issueCode(
      { nonce: b.nonce, email, sub: `bg-${email}`, auth_time: authTime },
      b.challenge,
    );
    const back = await broker.fetch(
      new Request(
        `${BROKER}/google/callback?code=${code}&state=${encodeURIComponent(b.bstate)}`,
      ) as never,
      brokerEnv,
    );
    const r = await get(
      e,
      `${AUTH.callbackGoogle}${new URL(loc(back)).search}`,
      b.cookie,
    );
    const sess = r.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`))
      ?.split(";")[0]
      ?.split("=")[1];
    expect(await readSession(e, sess)).toMatchObject({
      p: "google",
      a: authTime * 1000,
    });
  });

  /** The broker answers with `idToken`, whatever it was asked: a compromised broker. */
  const lyingBroker = (idToken: () => Promise<string>) =>
    installEnv(async () => Response.json({ id_token: await idToken() }));
  const callbackWith = async (e: Env, b: Awaited<ReturnType<typeof begin>>) =>
    loc(
      await get(
        e,
        `${AUTH.callbackGoogle}?code=any&state=${b.installState}`,
        b.cookie,
      ),
    );

  it("tenant B's token is refused at A even when the broker returns it", async () => {
    let nonce = "";
    const e = lyingBroker(() =>
      g.mint({ nonce, hd: "b.com", email: "eve@b.com" }),
    );
    const b = await begin(e);
    nonce = b.nonce;
    expect(await callbackWith(e, b)).toBe(
      `${SIGN_IN_PAGE}?error=tenant&next=%2Fa%2Fx`,
    );
  });

  it("a token minted through install A with B's client nonce is refused at B (accepted at A)", async () => {
    const eB = installEnv(undefined, { INSTALL_ID: "inst-b" });
    const bB = await begin(eB);

    // The attacker controls install A and starts a flow at the broker with
    // B's client nonce. Google now sees H(A || nonceB), not nonceB itself.
    const verifier = "attacker-verifier";
    const challenge = await challengeFor(verifier);
    const auth = await broker.fetch(
      new Request(
        `${BROKER}/google/authorize?install=inst-a&state=x&nonce=${bB.clientNonce}&code_challenge=${challenge}`,
      ) as never,
      brokerEnv,
    );
    const gq = new URL(loc(auth)).searchParams;
    expect(gq.get("nonce")).toBe(await brokerNonce("inst-a", bB.clientNonce));
    const code = g.issueCode(
      { nonce: gq.get("nonce"), email: uniq("eve"), sub: uniq("eve-sub") },
      challenge,
    );
    const body = JSON.stringify({
      install: "inst-a",
      code,
      verifier,
      ts: Date.now(),
      bstate: gq.get("state"),
      h: await flowHash(bB.clientNonce, challenge),
    });
    const kid = await keyId(await publicFromPkcs8(TEST_BROKER_KEY));
    const redeemed = await broker.fetch(
      new Request(`${BROKER}/google/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oa-kid": kid,
          "x-oa-sig": await signRedeem(TEST_BROKER_KEY, kid, body),
        },
        body,
      }) as never,
      brokerEnv,
    );
    expect(redeemed.status).toBe(200);
    const token = ((await redeemed.json()) as { id_token: string }).id_token;

    // Accepted at A: its transport expects H(A || nonceB).
    const eA = installEnv(async () => Response.json({ id_token: token }), {
      INSTALL_ID: "inst-a",
    });
    await expect(
      googleProvider.redeem(eA, {
        code: "any",
        verifier: "any",
        nonce: bB.clientNonce,
      }),
    ).resolves.toMatchObject({ provider: "google" });

    // Refused at B: B expects H(B || nonceB), so the token can't be replayed.
    const eBLie = installEnv(async () => Response.json({ id_token: token }), {
      INSTALL_ID: "inst-b",
    });
    expect(
      loc(
        await get(
          eBLie,
          `${AUTH.callbackGoogle}?code=any&state=${bB.installState}`,
          bB.cookie,
        ),
      ),
    ).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
  });

  it("a valid token minted for another flow's nonce is refused", async () => {
    const e = lyingBroker(() => g.mint({ nonce: "another-flow" }));
    expect(await callbackWith(e, await begin(e))).toBe(
      `${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`,
    );
  });

  it("an expired token is refused", async () => {
    let nonce = "";
    const e = lyingBroker(() =>
      g.mint({ nonce, exp: Math.floor(Date.now() / 1000) - 300 }),
    );
    const b = await begin(e);
    nonce = b.nonce;
    expect(await callbackWith(e, b)).toBe(
      `${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`,
    );
  });

  it("a token forged with an attacker's key is refused", async () => {
    let nonce = "";
    const evil = (await generateKeyPair("RS256")).privateKey;
    const e = lyingBroker(() => g.mint({ nonce }, { key: evil }));
    const b = await begin(e);
    nonce = b.nonce;
    expect(await callbackWith(e, b)).toBe(
      `${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`,
    );
  });

  it("a replayed ID token fails at a second callback (single-use state, fresh nonce)", async () => {
    let captured = "";
    let nonce = "";
    const e = lyingBroker(async () => {
      captured ||= await g.mint({
        nonce,
        email: uniq("rp"),
        sub: `rp-${nonce}`,
      });
      return captured;
    });
    const first = await begin(e);
    nonce = first.nonce;
    expect(await callbackWith(e, first)).toBe("/a/x");
    // Same token, a new flow (new state cookie and nonce).
    const second = await begin(e);
    expect(await callbackWith(e, second)).toBe(
      `${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`,
    );
    // And the first state cookie can't be used again.
    const again = await get(
      e,
      `${AUTH.callbackGoogle}?code=any&state=${first.installState}`,
    );
    expect(
      again.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=`)),
    ).toBe(false);
  });

  it("a broker refusal (401) is a failed sign-in", async () => {
    const e = installEnv(async () =>
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    expect(await callbackWith(e, await begin(e))).toBe(
      `${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`,
    );
  });

  it("the install signs its redeem with its own key id, derived from the key", async () => {
    const seen: Request[] = [];
    const e = installEnv(async (req) => {
      seen.push(req.clone() as Request);
      return broker.fetch(req as never, brokerEnv);
    });
    const b = await begin(e);
    await get(
      e,
      `${AUTH.callbackGoogle}?code=x&state=${b.installState}`,
      b.cookie,
    );
    expect(seen[0]?.headers.get("x-oa-kid")).toBe(
      await keyId(await publicFromPkcs8(TEST_BROKER_KEY)),
    );
    expect(seen[0]?.headers.get("x-oa-sig")).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it("the redeem carries the relayed broker state and H(client nonce || challenge)", async () => {
    const seen: Record<string, unknown>[] = [];
    const e = installEnv(async (req) => {
      seen.push(await req.clone().json());
      return broker.fetch(req as never, brokerEnv);
    });
    const b = await begin(e);
    await get(
      e,
      `${AUTH.callbackGoogle}?code=x&state=${b.installState}&bstate=${encodeURIComponent(b.bstate)}`,
      b.cookie,
    );
    expect(seen[0]).toMatchObject({
      bstate: b.bstate,
      h: await flowHash(b.clientNonce, b.challenge),
    });
  });

  it("a broker state from another flow (hash mismatch) is a failed sign-in", async () => {
    const e = installEnv();
    const victim = await begin(e);
    const other = await begin(e);
    const code = g.issueCode(
      { nonce: victim.nonce, email: uniq("mx"), sub: uniq("mx-sub") },
      victim.challenge,
    );
    const calls = g.tokenCalls.length;
    expect(
      loc(
        await get(
          e,
          `${AUTH.callbackGoogle}?code=${code}&state=${victim.installState}&bstate=${encodeURIComponent(other.bstate)}`,
          victim.cookie,
        ),
      ),
    ).toBe(`${SIGN_IN_PAGE}?error=failed&next=%2Fa%2Fx`);
    expect(g.tokenCalls.length).toBe(calls);
  });
});
