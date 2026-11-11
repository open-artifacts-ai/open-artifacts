import { env } from "cloudflare:workers";
import {
  flowHash,
  GOOGLE_TOKEN_URL,
  keyId,
  publicFromPkcs8,
  signBrokerTicket,
  signRedeem,
  signSilentTicket,
  verifyBrokerTicket,
} from "@oa/auth-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import broker, { type Env } from "../src/index.js";
import { clearRegistryCache } from "../src/registry.js";

// Silent sign-in (#2026): a ticket signed by the sign-up host selects
// prompt=none + login_hint; anything else is the account picker. The broker
// state carries the expected sub, and redeem relays no other Google token.

const BROKER = "https://auth.hosted.test";
const ORIGIN = "https://a.hosted.test";
const VERIFIER = "v";
const pk = (fill: number) =>
  Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, fill),
  ]).toString("base64url");
const INST_KEY = pk(1);
const SIGNUP_KEY = pk(21);
const OTHER_KEY = pk(22);
const SUB = "1234567890";
const challengeOf = async (v: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
  ).toString("base64url");
const idToken = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;

const E = () =>
  ({
    ...env,
    RL_BROKER_IP: { limit: async () => ({ success: true }) },
    RL_BROKER_INSTALL: { limit: async () => ({ success: true }) },
  }) as Env;
const call = (path: string, init?: RequestInit) =>
  broker.fetch(new Request(`${BROKER}${path}`, init) as never, E());

async function put(id: string, origin: string, key: string) {
  const x = await publicFromPkcs8(key);
  await env.BROKER_REGISTRY.put(
    `install:${id}`,
    JSON.stringify({
      installId: id,
      origin,
      keys: [{ kid: await keyId(x), x }],
      domains: ["a.com"],
    }),
  );
}

let tokenCalls = 0;
let googleSub = SUB;
beforeEach(async () => {
  clearRegistryCache();
  tokenCalls = 0;
  googleSub = SUB;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === GOOGLE_TOKEN_URL) {
      tokenCalls++;
      return Response.json({ id_token: idToken(googleSub) });
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
  await put("inst-a", ORIGIN, INST_KEY);
  await put("inst-b", "https://b.hosted.test", pk(2));
  await put("i00000signup", "https://signup.hosted.test", SIGNUP_KEY);
});
afterEach(() => vi.restoreAllMocks());

const ticket = (
  o: {
    key?: string;
    install?: string;
    aud?: string;
    sub?: string;
    exp?: number;
  } = {},
) =>
  signSilentTicket(o.key ?? SIGNUP_KEY, {
    install: o.install ?? "inst-a",
    aud: o.aud ?? ORIGIN,
    sub: o.sub ?? SUB,
    exp: o.exp ?? Date.now() + 30_000,
    nonce: "abcdefgh12345678",
  });

async function authorize(q: Record<string, string>) {
  return call(
    `/google/authorize?${new URLSearchParams({
      install: "inst-a",
      state: "s",
      nonce: "n",
      code_challenge: await challengeOf(VERIFIER),
      ...q,
    })}`,
  );
}
const loc = (r: Response) => new URL(r.headers.get("location") ?? "");

async function redeem(bstate: string) {
  const text = JSON.stringify({
    install: "inst-a",
    code: "c",
    verifier: VERIFIER,
    ts: Date.now(),
    bstate,
    h: await flowHash("n", await challengeOf(VERIFIER)),
  });
  const kid = await keyId(await publicFromPkcs8(INST_KEY));
  return call("/google/redeem", {
    method: "POST",
    headers: {
      "x-oa-kid": kid,
      "x-oa-sig": await signRedeem(INST_KEY, kid, text),
      "content-type": "application/json",
    },
    body: text,
  });
}

describe("silent ticket at authorize", () => {
  it("a valid ticket asks Google for prompt=none with login_hint=sub", async () => {
    const r = await authorize({ silent: await ticket() });
    expect(r.status).toBe(302);
    expect(loc(r).searchParams.get("prompt")).toBe("none");
    expect(loc(r).searchParams.get("login_hint")).toBe(SUB);
  });

  it("no ticket: today's select_account, no hint", async () => {
    const u = loc(await authorize({}));
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.has("login_hint")).toBe(false);
  });

  it("forged, expired, wrong-purpose, cross-install and wrong-origin tickets get select_account", async () => {
    const x = await publicFromPkcs8(SIGNUP_KEY);
    const kid = await keyId(x);
    const bad: Record<string, string> = {
      junk: "junk",
      forged: await ticket({ key: OTHER_KEY }),
      expired: await ticket({ exp: Date.now() - 1 }),
      tooFar: await ticket({ exp: Date.now() + 10 * 60_000 }),
      // Signed for another install: its install differs from the authorize's.
      crossInstall: await ticket({ install: "inst-b" }),
      wrongOrigin: await ticket({ aud: "https://evil.example" }),
      // The install's own key (not the sign-up host) signing a silent ticket.
      installSigned: await ticket({ key: INST_KEY }),
      // A broker ticket and a redeem signature are not silent tickets.
      brokerTicket: await signBrokerTicket(SIGNUP_KEY, {
        install: "inst-a",
        state: "s",
        challenge: await challengeOf(VERIFIER),
        exp: Date.now() + 30_000,
      }),
      redeemSig: `${Date.now() + 30_000}.abcdefgh12345678.${SUB}.${kid}.${await signRedeem(SIGNUP_KEY, kid, "x")}`,
    };
    for (const [name, silent] of Object.entries(bad)) {
      const u = loc(await authorize({ silent }));
      expect(u.searchParams.get("prompt"), name).toBe("select_account");
      expect(u.searchParams.has("login_hint"), name).toBe(false);
    }
  });

  it("a silent ticket never verifies as a broker ticket for i00000signup, nor redeems", async () => {
    const t = await ticket({ install: "i00000signup" });
    expect(
      (await authorize({ install: "i00000signup", ticket: t })).status,
    ).toBe(404);
    const x = await publicFromPkcs8(SIGNUP_KEY);
    expect(
      await verifyBrokerTicket(
        [{ kid: await keyId(x), x }],
        t,
        { install: "i00000signup", state: "s", challenge: "c" },
        Date.now(),
      ),
    ).toBe(false);
  });

  it("reauth=1 disables silent", async () => {
    const u = loc(await authorize({ silent: await ticket(), reauth: "1" }));
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.has("login_hint")).toBe(false);
    expect(u.searchParams.get("max_age")).toBe("0");
  });

  it("missing state, nonce or PKCE is refused even with a valid ticket", async () => {
    const silent = await ticket();
    for (const drop of ["state", "nonce", "code_challenge"]) {
      const q = new URLSearchParams({
        install: "inst-a",
        state: "s",
        nonce: "n",
        code_challenge: await challengeOf(VERIFIER),
        silent,
      });
      q.delete(drop);
      expect((await call(`/google/authorize?${q}`)).status, drop).toBe(404);
    }
    expect((await authorize({ code_challenge: "short", silent })).status).toBe(
      404,
    );
  });

  it("replaying a ticket only starts another Google attempt; it never authenticates without Google", async () => {
    const silent = await ticket();
    for (let i = 0; i < 3; i++) {
      const r = await authorize({ silent });
      expect(loc(r).origin).toBe("https://accounts.google.com");
    }
    expect(tokenCalls).toBe(0);
    // No state, a junk state: nothing is redeemed.
    expect((await redeem("junk")).status).toBe(401);
    expect(tokenCalls).toBe(0);
  });
});

describe("silent flow at redeem", () => {
  const bstateOf = async (silent: string) =>
    loc(await authorize({ silent })).searchParams.get("state") ?? "";

  it("relays the token whose sub is the ticket's expected sub", async () => {
    const r = await redeem(await bstateOf(await ticket()));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id_token: idToken(SUB) });
  });

  it("a valid ticket where Google returns a different sub relays NO token", async () => {
    const bstate = await bstateOf(await ticket());
    googleSub = "999";
    const r = await redeem(bstate);
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toContain("id_token");
  });

  it("a non-silent flow is unfiltered (today's behavior)", async () => {
    googleSub = "anyone";
    const r = await redeem(await bstateOf("junk"));
    expect(r.status).toBe(200);
  });
});
