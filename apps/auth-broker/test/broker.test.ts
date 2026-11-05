import { env } from "cloudflare:workers";
import {
  brokerNonce,
  flowHash,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  keyId,
  publicFromPkcs8,
  signRedeem,
} from "@oa/auth-core";
import { readState, signState } from "@oa/broker-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import broker, { type Env } from "../src/index.js";
import { clearRegistryCache } from "../src/registry.js";

const BROKER = "https://auth.hosted.test";
/** S256 output shape: 43 base64url chars. */
const CH = "A".repeat(43);
const OTHER_CH = "B".repeat(43);

/** RL stub: `max` per key with no clock; `keys` records every charge. */
const limiter = (max = 10_000) => {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: keys.length <= max };
    },
  };
};
let ipLimit: ReturnType<typeof limiter>;
let installLimit: ReturnType<typeof limiter>;
const E = (over: Partial<Env> = {}) =>
  ({
    ...env,
    RL_BROKER_IP: ipLimit,
    RL_BROKER_INSTALL: installLimit,
    ...over,
  }) as Env;
const pk = (fill: number) =>
  Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, fill),
  ]).toString("base64url");
const KEY_A = pk(1);
const KEY_B = pk(2);
const KEY_A2 = pk(3);

type Entry = {
  installId: string;
  origin: string;
  keys: { kid: string; x: string }[];
  domains?: string[];
  disabled?: boolean;
};
async function entryFor(
  id: string,
  origin: string,
  ...keys: string[]
): Promise<Entry> {
  const out = [];
  for (const k of keys) {
    const x = await publicFromPkcs8(k);
    out.push({ kid: await keyId(x), x });
  }
  return { installId: id, origin, keys: out, domains: ["a.com"] };
}
const put = (e: Entry) =>
  env.BROKER_REGISTRY.put(`install:${e.installId}`, JSON.stringify(e));

const call = (path: string, init?: RequestInit, e: Env = E()) =>
  broker.fetch(new Request(`${BROKER}${path}`, init) as never, e);

/** The redeem flow: client nonce "n", verifier "v". */
const NONCE = "n";
const VERIFIER = "v";
const challengeOf = async (v: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
  ).toString("base64url");
/** A broker state for `install`, as authorize mints it for this flow. */
async function mintBstate(install: string, nonce = NONCE) {
  const r = await call(
    `/google/authorize?install=${install}&state=s&nonce=${nonce}&code_challenge=${await challengeOf(VERIFIER)}`,
  );
  return (
    new URL(r.headers.get("location") ?? "").searchParams.get("state") ?? ""
  );
}
const BS: Record<string, string> = {};

let tokenCalls: URLSearchParams[] = [];
let tokenReply: () => Response = () =>
  Response.json({ id_token: "raw.google.token" });
beforeEach(async () => {
  clearRegistryCache();
  ipLimit = limiter();
  installLimit = limiter();
  tokenCalls = [];
  tokenReply = () => Response.json({ id_token: "raw.google.token" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === GOOGLE_TOKEN_URL) {
      tokenCalls.push(new URLSearchParams(await req.text()));
      return tokenReply();
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
  await put(await entryFor("inst-a", "https://a.hosted.test", KEY_A));
  await put(await entryFor("inst-b", "https://b.hosted.test", KEY_B));
  await put({
    ...(await entryFor("inst-off", "https://off.hosted.test", KEY_A)),
    disabled: true,
  });
  for (const i of ["inst-a", "inst-b"]) BS[i] = await mintBstate(i);
  ipLimit = limiter();
  installLimit = limiter();
});
afterEach(() => vi.restoreAllMocks());

async function redeem(
  key: string,
  body: Record<string, unknown>,
  o: { kid?: string; tamper?: boolean; ip?: string; e?: Env } = {},
) {
  const install = (body.install as string | undefined) ?? "inst-a";
  const text = JSON.stringify({
    install,
    code: "c",
    verifier: VERIFIER,
    ts: Date.now(),
    bstate: BS[install] ?? "",
    h: await flowHash(NONCE, await challengeOf(VERIFIER)),
    ...body,
  });
  const kid = o.kid ?? (await keyId(await publicFromPkcs8(key)));
  const sig = await signRedeem(key, kid, text);
  return call(
    "/google/redeem",
    {
      method: "POST",
      headers: {
        "x-oa-kid": kid,
        "x-oa-sig": sig,
        "content-type": "application/json",
        ...(o.ip ? { "cf-connecting-ip": o.ip } : {}),
      },
      body: o.tamper ? text.replace('"c"', '"d"') : text,
    },
    o.e,
  );
}

describe("authorize", () => {
  it("sends the user to Google with the install-derived nonce, the challenge and a signed broker state", async () => {
    const r = await call(
      `/google/authorize?install=inst-a&state=s1&nonce=n1&code_challenge=${CH}`,
    );
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location") ?? "");
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${BROKER}/google/callback`,
      nonce: await brokerNonce("inst-a", "n1"),
      code_challenge: CH,
      code_challenge_method: "S256",
      prompt: "select_account",
      hd: "a.com",
    });
    expect(u.searchParams.get("nonce")).not.toBe("n1");
    expect(u.searchParams.get("state")).not.toBe("s1");
    expect(u.searchParams.get("max_age")).toBeNull();
  });

  it("reauth=1 (an install's break-glass sign-in) asks Google for max_age=0", async () => {
    const r = await call(
      `/google/authorize?install=inst-a&state=s1&nonce=n1&code_challenge=${CH}&reauth=1`,
    );
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location") ?? "");
    expect(u.searchParams.get("max_age")).toBe("0");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });

  it("redirect_uri comes from BROKER_ORIGIN, never from the request Host", async () => {
    const r = await broker.fetch(
      new Request(
        `https://evil.test/google/authorize?install=inst-a&state=s&nonce=n&code_challenge=${CH}`,
      ) as never,
      E(),
    );
    expect(
      new URL(r.headers.get("location") ?? "").searchParams.get("redirect_uri"),
    ).toBe(`${BROKER}/google/callback`);
  });

  it("the broker state binds H(client nonce || challenge) and lives at most 10 minutes", async () => {
    const r = await call(
      `/google/authorize?install=inst-a&state=s1&nonce=n1&code_challenge=${CH}`,
    );
    const bstate =
      new URL(r.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const payload = JSON.parse(
      Buffer.from(bstate.split(".")[0] as string, "base64url").toString(),
    ) as { h: string; exp: number };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`n1|${CH}`),
    );
    expect(payload.h).toBe(Buffer.from(digest).toString("base64url"));
    const ttl = payload.exp - Date.now();
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    expect(ttl).toBeGreaterThan(9 * 60_000);
  });

  it("unknown or disabled installs, missing params and malformed challenges are 404", async () => {
    for (const q of [
      ["nope", "s", "n", CH],
      ["inst-off", "s", "n", CH],
      ["inst-a", "s", "n", ""],
      ["inst-a", "s", "n", "ch1"],
      ["inst-a", "s", "n", OTHER_CH.slice(0, 42)],
      ["inst-a", "s", "n", `${OTHER_CH}!`],
    ])
      expect(
        (
          await call(
            `/google/authorize?install=${q[0]}&state=${q[1]}&nonce=${q[2]}&code_challenge=${q[3]}`,
          )
        ).status,
      ).toBe(404);
  });
});

describe("callback", () => {
  const bstate = async (install = "inst-a") => {
    const r = await call(
      `/google/authorize?install=${install}&state=s1&nonce=n&code_challenge=${CH}`,
    );
    return (
      new URL(r.headers.get("location") ?? "").searchParams.get("state") ?? ""
    );
  };

  it("relays the code to the registry origin only, with the install's own state", async () => {
    const bs = await bstate();
    const r = await call(
      `/google/callback?code=abc&state=${encodeURIComponent(bs)}`,
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `https://a.hosted.test/auth/callback/google?code=abc&state=s1&bstate=${encodeURIComponent(bs)}`,
    );
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a broker state with the install swapped (or any tampering) is refused", async () => {
    const st = await bstate();
    const [p, sig] = st.split(".");
    const body = JSON.parse(Buffer.from(p as string, "base64url").toString());
    const swapped = Buffer.from(
      JSON.stringify({ ...body, i: "inst-b" }),
    ).toString("base64url");
    for (const s of [`${swapped}.${sig}`, `${p}.${sig}x`, "garbage", ""])
      expect(
        (await call(`/google/callback?code=abc&state=${encodeURIComponent(s)}`))
          .status,
      ).toBe(404);
  });

  it("a late return (expired but authentic state) goes back to the install as expired, never with the code", async () => {
    const late = await signState(env.BROKER_STATE_KEY, {
      i: "inst-a",
      s: "s1",
      h: "h",
      exp: Date.now() - 1,
    });
    const r = await call(
      `/google/callback?code=abc&state=${encodeURIComponent(late)}`,
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      "https://a.hosted.test/auth/callback/google?error=expired&state=s1",
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
    // An expired state is still never redeemable.
    expect(await readState(env.BROKER_STATE_KEY, late, Date.now())).toBeNull();
    // Tampered or foreign-keyed expired states stay a 404.
    const [p, sig] = late.split(".");
    const forged = await signState("another-key-of-32-bytes-or-more!!", {
      i: "inst-a",
      s: "s1",
      h: "h",
      exp: Date.now() - 1,
    });
    for (const s of [`${p}.${sig}x`, forged])
      expect(
        (await call(`/google/callback?code=abc&state=${encodeURIComponent(s)}`))
          .status,
      ).toBe(404);
  });

  it("a Google error goes back to the install as an error, still to the registry origin", async () => {
    const bs = await bstate();
    const r = await call(
      `/google/callback?error=access_denied&state=${encodeURIComponent(bs)}`,
    );
    expect(r.headers.get("location")).toBe(
      `https://a.hosted.test/auth/callback/google?error=access_denied&state=s1&bstate=${encodeURIComponent(bs)}`,
    );
  });
});

describe("redeem", () => {
  it("returns Google's ID token unchanged; the code goes with the broker callback and the verifier", async () => {
    const r = await redeem(KEY_A, {
      code: "the-code",
      verifier: "the-verifier",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id_token: "raw.google.token" });
    expect(Object.fromEntries(tokenCalls[0] ?? [])).toMatchObject({
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: `${BROKER}/google/callback`,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    });
  });

  it("A's key signing a redeem for install B is refused, with no Google call", async () => {
    expect((await redeem(KEY_A, { install: "inst-b" })).status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("unknown kid, bad signature, stale ts, disabled install, garbage: 401 and no Google call", async () => {
    for (const r of [
      await redeem(KEY_A, {}, { kid: "nope" }),
      await redeem(KEY_A, {}, { tamper: true }),
      await redeem(KEY_A, { ts: Date.now() - 61_000 }),
      await redeem(KEY_A, { ts: Date.now() + 61_000 }),
      await redeem(KEY_A, { install: "inst-off" }),
      await call("/google/redeem", { method: "POST", body: "{" }),
    ])
      expect(r.status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("refusal bodies: unauthorized before the signature verifies, stale or bad_flow after (broker-check)", async () => {
    const body = async (r: Response) => ({
      status: r.status,
      ...((await r.json()) as object),
    });
    const unauth = { status: 401, error: "unauthorized" };
    // Before verification: one body for everything, so nothing leaks.
    for (const r of [
      await redeem(KEY_A, {}, { kid: "nope" }),
      await redeem(KEY_A, {}, { tamper: true }),
      await redeem(KEY_A, { install: "inst-off" }),
      await redeem(KEY_A, { install: "inst-b" }),
      await call("/google/redeem", { method: "POST", body: "{" }),
    ])
      expect(await body(r)).toEqual(unauth);
    // After verification: stale, and a flow that doesn't bind.
    expect(
      await body(await redeem(KEY_A, { ts: Date.now() - 61_000 })),
    ).toEqual({ status: 401, error: "stale" });
    expect(await body(await redeem(KEY_A, { bstate: "junk" }))).toEqual({
      status: 401,
      error: "bad_flow",
    });
    expect(await body(await redeem(KEY_A, { h: "junk" }))).toEqual({
      status: 401,
      error: "bad_flow",
    });
    expect(tokenCalls).toHaveLength(0);
  });

  it("a stored kid that doesn't derive from its key (N3) is refused", async () => {
    const e = await entryFor("inst-a", "https://a.hosted.test", KEY_A);
    await put({
      ...e,
      keys: [{ kid: "wrong-kid-000000", x: e.keys[0]?.x as string }],
    });
    clearRegistryCache();
    expect((await redeem(KEY_A, {}, { kid: "wrong-kid-000000" })).status).toBe(
      401,
    );
  });

  it("rotation: both active keys work; a removed key fails", async () => {
    await put(await entryFor("inst-a", "https://a.hosted.test", KEY_A, KEY_A2));
    clearRegistryCache();
    expect((await redeem(KEY_A, {})).status).toBe(200);
    expect((await redeem(KEY_A2, {})).status).toBe(200);
    await put(await entryFor("inst-a", "https://a.hosted.test", KEY_A2));
    clearRegistryCache();
    expect((await redeem(KEY_A, {})).status).toBe(401);
  });

  it("a failed exchange is 400 exchange_failed", async () => {
    tokenReply = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    const r = await redeem(KEY_A, {});
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "exchange_failed" });
  });

  it("the registry holds no secret material", async () => {
    const raw = (await env.BROKER_REGISTRY.get(
      "install:inst-a",
      "json",
    )) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      "domains",
      "installId",
      "keys",
      "origin",
    ]);
    for (const k of raw.keys as Record<string, unknown>[])
      expect(Object.keys(k).sort()).toEqual(["kid", "x"]);
  });

  it("logs never contain the code, verifier, token or keys", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    await redeem(KEY_A, { code: "secret-code", verifier: "secret-verifier" });
    await redeem(KEY_A, { install: "inst-b", code: "secret-code" });
    const all = lines.join("\n");
    for (const s of [
      "secret-code",
      "secret-verifier",
      "raw.google.token",
      KEY_A,
      env.GOOGLE_CLIENT_SECRET,
    ])
      expect(all).not.toContain(s);
  });

  it("redeem charges the IP and install buckets, before any Google call", async () => {
    await redeem(KEY_A, {}, { ip: "203.0.113.9" });
    expect(ipLimit.keys).toEqual(["ip:203.0.113.9"]);
    expect(installLimit.keys).toEqual(["redeem:install:inst-a"]);
  });

  it("a deny in either bucket is 429 and no Google call", async () => {
    const deniedIp = await redeem(
      KEY_A,
      {},
      { e: E({ RL_BROKER_IP: limiter(0) }) },
    );
    const deniedInstall = await redeem(
      KEY_A,
      {},
      { e: E({ RL_BROKER_INSTALL: limiter(0) }) },
    );
    for (const r of [deniedIp, deniedInstall]) {
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ error: "rate_limited" });
    }
    expect(tokenCalls).toHaveLength(0);
  });

  it("unbound rate-limit bindings fail closed (503)", async () => {
    const e = E({ RL_BROKER_IP: undefined, RL_BROKER_INSTALL: undefined });
    const auth = await call(
      `/google/authorize?install=inst-a&state=s&nonce=n&code_challenge=${CH}`,
      {},
      e,
    );
    expect(auth.status).toBe(503);
    const red = await redeem(KEY_A, {}, { e });
    expect(red.status).toBe(503);
    expect(tokenCalls).toHaveLength(0);
  });
});

describe("rate limits", () => {
  const AUTHZ = `/google/authorize?install=inst-a&state=s&nonce=n&code_challenge=${CH}`;
  it("gate traffic (no cf-connecting-ip) is charged per install, never one shared bucket", async () => {
    await call(AUTHZ, { headers: { "x-oa-gate-install": "iabc123def45" } });
    await call(AUTHZ, { headers: { "x-oa-gate-install": "izzz999yyy88" } });
    expect(ipLimit.keys).toEqual(["gate:iabc123def45", "gate:izzz999yyy88"]);
  });

  it("a public caller can't pick its bucket: with cf-connecting-ip the gate header is ignored", async () => {
    await call(AUTHZ, {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "x-oa-gate-install": "iabc123def45",
      },
    });
    expect(ipLimit.keys).toEqual(["ip:203.0.113.9"]);
  });

  it("IPv6 callers are keyed by their /64 (ipKey, design v7 4.7)", async () => {
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:ffff::9"])
      await call(AUTHZ, { headers: { "cf-connecting-ip": ip } });
    expect(ipLimit.keys).toEqual([
      "ip:2001:db8:1:2::/64",
      "ip:2001:db8:1:2::/64",
    ]);
  });

  it("an unparseable cf-connecting-ip keeps its own bucket, not the shared unknown", async () => {
    for (const ip of ["not-an-ip", "also-bad"])
      await call(AUTHZ, { headers: { "cf-connecting-ip": ip } });
    expect(ipLimit.keys).toEqual(["ip:not-an-ip", "ip:also-bad"]);
  });

  it("no cf-connecting-ip and no valid gate header is the shared unknown bucket", async () => {
    await call(AUTHZ, {});
    await call(AUTHZ, { headers: { "x-oa-gate-install": "../evil" } });
    expect(ipLimit.keys).toEqual(["ip:unknown", "ip:unknown"]);
  });

  it("authorize charges the IP and install buckets", async () => {
    const r = await call(
      `/google/authorize?install=inst-a&state=s&nonce=n&code_challenge=${CH}`,
      { headers: { "cf-connecting-ip": "203.0.113.9" } },
    );
    expect(r.status).toBe(302);
    expect(ipLimit.keys).toEqual(["ip:203.0.113.9"]);
    expect(installLimit.keys).toEqual(["authorize:install:inst-a"]);
  });

  it("a deny in either bucket is 429", async () => {
    for (const e of [
      E({ RL_BROKER_IP: limiter(0) }),
      E({ RL_BROKER_INSTALL: limiter(0) }),
    ]) {
      const r = await call(
        `/google/authorize?install=inst-a&state=s&nonce=n&code_challenge=${CH}`,
        {},
        e,
      );
      expect(r.status).toBe(429);
    }
  });
});

describe("install buckets are charged only after auth", () => {
  it("100 unauthenticated redeems naming B don't stop B's valid redeem", async () => {
    installLimit = limiter(1);
    for (let i = 0; i < 100; i++)
      expect((await redeem(KEY_A, { install: "inst-b" })).status).toBe(401);
    expect(installLimit.keys).toEqual([]);
    expect(ipLimit.keys).toHaveLength(100);
    expect((await redeem(KEY_B, { install: "inst-b" })).status).toBe(200);
    expect(installLimit.keys).toEqual(["redeem:install:inst-b"]);
  });

  it("authorize and redeem have separate per-install buckets: draining authorize doesn't block a signed redeem (review item 24)", async () => {
    // One charge allowed per key: authorize spends only its own bucket.
    const keys: string[] = [];
    installLimit = {
      keys,
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: keys.filter((k) => k === key).length <= 1 };
      },
    };
    const AUTHZ = `/google/authorize?install=inst-a&state=s&nonce=n&code_challenge=${CH}`;
    expect((await call(AUTHZ)).status).toBe(302);
    expect((await call(AUTHZ)).status).toBe(429);
    expect((await redeem(KEY_A, {})).status).toBe(200);
    expect(installLimit.keys).toEqual([
      "authorize:install:inst-a",
      "authorize:install:inst-a",
      "redeem:install:inst-a",
    ]);
  });

  it("unknown-install authorizes don't touch any install bucket", async () => {
    installLimit = limiter(1);
    for (let i = 0; i < 20; i++)
      expect(
        (
          await call(
            `/google/authorize?install=nope-${i}&state=s&nonce=n&code_challenge=${CH}`,
          )
        ).status,
      ).toBe(404);
    expect(installLimit.keys).toEqual([]);
    const r = await call(
      `/google/authorize?install=inst-b&state=s&nonce=n&code_challenge=${CH}`,
    );
    expect(r.status).toBe(302);
    expect(installLimit.keys).toEqual(["authorize:install:inst-b"]);
  });
});

describe("redeem verifies the broker state's flow hash", () => {
  it("a mismatched nonce hash, another install's state, a tampered or missing state: 401, no Google call", async () => {
    const otherFlow = await mintBstate("inst-a", "other-nonce");
    const [p, sig] = (BS["inst-a"] as string).split(".");
    for (const r of [
      await redeem(KEY_A, { h: await flowHash("other", CH) }),
      await redeem(KEY_A, { h: "" }),
      await redeem(KEY_A, { bstate: otherFlow }),
      await redeem(KEY_A, { bstate: BS["inst-b"] }),
      await redeem(KEY_A, { bstate: `${p}.${sig}x` }),
      await redeem(KEY_A, { bstate: "" }),
      await redeem(KEY_A, { bstate: undefined }),
    ])
      expect(r.status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("an expired broker state is refused", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 11 * 60_000);
    const old = await mintBstate("inst-a");
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect((await redeem(KEY_A, { bstate: old })).status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });
});
