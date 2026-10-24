import { env } from "cloudflare:workers";
import {
  boxKeyPair,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_DIRECTORY_SCOPES,
  GOOGLE_TOKEN_URL,
  keyId,
  openFromBroker,
  publicFromPkcs8,
  signRedeem,
  signRequest,
} from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import broker, { type Env } from "../src/index.js";
import wranglerText from "../wrangler.jsonc?raw";

// P3 T12: the directory broker. Its own Directory client, a directory-only
// state, a signed path-bound token exchange, tokens sealed to the install,
// and a registry it only reads.
const ORIGIN = "https://directory.hosted.test";
const TOKEN = "/google/directory/token";

/** The registry as the Worker sees it: every call recorded; writes refused. */
const calls: string[] = [];
const readOnly = new Proxy(env.DIRECTORY_REGISTRY, {
  get(t, p) {
    const v = Reflect.get(t, p);
    if (typeof v !== "function") return v;
    return (...a: unknown[]) => {
      calls.push(String(p));
      if (p === "put" || p === "delete")
        throw new Error(`registry ${String(p)} refused`);
      return v.apply(t, a);
    };
  },
});

const limiter = () => ({ limit: async () => ({ success: true }) });
const E = (over: Partial<Env> = {}) =>
  ({
    ...env,
    DIRECTORY_REGISTRY: readOnly,
    RL_DIRECTORY_IP: limiter(),
    RL_DIRECTORY_INSTALL: limiter(),
    ...over,
  }) as Env;
const pk = (fill: number) =>
  Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, fill),
  ]).toString("base64url");
const KEY_A = pk(1);
const KEY_B = pk(2);

/** Platform's write (the test's raw binding, not the Worker's). */
async function register(id: string, origin: string, key: string) {
  const x = await publicFromPkcs8(key);
  await env.DIRECTORY_REGISTRY.put(
    `install:${id}`,
    JSON.stringify({
      installId: id,
      origin,
      keys: [{ kid: await keyId(x), x }],
      domains: ["a.com"],
    }),
  );
}

const call = (path: string, init?: RequestInit, e: Env = E()) =>
  broker.fetch(new Request(`${ORIGIN}${path}`, init) as never, e);
const loc = (r: Response) => new URL(r.headers.get("location") ?? "");

const VERIFIER = "dir-verifier";
const challengeOf = async (v: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
  ).toString("base64url");

async function start(install = "inst-a", e: Env = E()) {
  const r = await call(
    `/google/directory/start?install=${install}&state=s1&code_challenge=${await challengeOf(VERIFIER)}`,
    undefined,
    e,
  );
  return { r, q: r.status === 302 ? loc(r).searchParams : null };
}

const kidOf = async (key: string) => keyId(await publicFromPkcs8(key));

/** A signed token request with a fresh install box key; returns the key too. */
async function signed(
  body: Record<string, unknown>,
  key = KEY_A,
  path = TOKEN,
) {
  const box = await boxKeyPair();
  const text = JSON.stringify({ epk: box.pub, ...body });
  const kid = await kidOf(key);
  const r = await call(TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-kid": kid,
      "x-oa-sig":
        path === "/google/redeem"
          ? await signRedeem(key, kid, text)
          : await signRequest(key, path, kid, text),
    },
    body: text,
  });
  return { r, box, kid };
}

let tokenCalls: URLSearchParams[] = [];
let tokenReply: () => Response;
beforeEach(async () => {
  clearRegistryCache();
  calls.length = 0;
  tokenCalls = [];
  tokenReply = () =>
    Response.json({
      refresh_token: "rt-1",
      access_token: "at-1",
      scope: GOOGLE_DIRECTORY_SCOPES.join(" "),
      id_token: "raw.id.token",
      expires_in: 3599,
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === GOOGLE_TOKEN_URL) {
      tokenCalls.push(new URLSearchParams(await req.text()));
      return tokenReply();
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
  await register("inst-a", "https://a.hosted.test", KEY_A);
  await register("inst-b", "https://b.hosted.test", KEY_B);
});
afterEach(() => vi.restoreAllMocks());

const codeBody = async (over: Record<string, unknown> = {}) => ({
  install: "inst-a",
  ts: Date.now(),
  grant: "code",
  code: "c1",
  verifier: VERIFIER,
  bstate: (await start()).q?.get("state") ?? "",
  ...over,
});

describe("GET /google/directory/start", () => {
  it("redirects to Google with the Directory client, scopes, offline consent, hd and the fixed redirect URI", async () => {
    const { r, q } = await start();
    expect(r.status).toBe(302);
    expect(loc(r).origin + loc(r).pathname).toBe(GOOGLE_AUTHORIZE_URL);
    expect(q?.get("client_id")).toBe(env.GOOGLE_DIRECTORY_CLIENT_ID);
    expect(q?.get("redirect_uri")).toBe(`${ORIGIN}/google/directory/callback`);
    expect(q?.get("scope")?.split(" ")).toEqual([...GOOGLE_DIRECTORY_SCOPES]);
    expect(q?.get("access_type")).toBe("offline");
    expect(q?.get("prompt")).toBe("consent");
    expect(q?.get("hd")).toBe("a.com");
    expect(q?.get("code_challenge_method")).toBe("S256");
  });

  it("the redirect URI ignores the request Host", async () => {
    const r = await broker.fetch(
      new Request(
        `https://evil.test/google/directory/start?install=inst-a&state=s&code_challenge=${"A".repeat(43)}`,
      ) as never,
      E(),
    );
    expect(loc(r).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/google/directory/callback`,
    );
  });

  it("404 for an unknown install, a bad challenge, or no client (an unfilled placeholder included)", async () => {
    expect((await start("inst-zz")).r.status).toBe(404);
    expect(
      (
        await call(
          "/google/directory/start?install=inst-a&state=s&code_challenge=x",
        )
      ).status,
    ).toBe(404);
    expect(
      (await start("inst-a", E({ GOOGLE_DIRECTORY_CLIENT_SECRET: "" }))).r
        .status,
    ).toBe(404);
    expect(
      (
        await start(
          "inst-a",
          E({
            GOOGLE_DIRECTORY_CLIENT_ID: "{{GOOGLE_DIRECTORY_CLIENT_ID_PROD}}",
          }),
        )
      ).r.status,
    ).toBe(404);
  });

  it("fails closed (503) without its rate-limit bindings", async () => {
    expect(
      (await start("inst-a", E({ RL_DIRECTORY_IP: undefined }))).r.status,
    ).toBe(503);
  });
});

describe("GET /google/directory/callback", () => {
  it("sends the code back to the install's registered origin only", async () => {
    const bstate = (await start()).q?.get("state") ?? "";
    const r = await call(
      `/google/directory/callback?code=c1&state=${encodeURIComponent(bstate)}`,
    );
    expect(r.status).toBe(302);
    const to = loc(r);
    expect(to.origin).toBe("https://a.hosted.test");
    expect(to.pathname).toBe("/api/v1/directory/callback");
    expect(to.searchParams.get("code")).toBe("c1");
    expect(to.searchParams.get("state")).toBe("s1");
    expect(to.searchParams.get("bstate")).toBe(bstate);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a consent refusal comes back as error, never a code", async () => {
    const { q } = await start();
    const r = await call(
      `/google/directory/callback?error=access_denied&state=${encodeURIComponent(q?.get("state") ?? "")}`,
    );
    expect(loc(r).searchParams.get("error")).toBe("access_denied");
    expect(loc(r).searchParams.has("code")).toBe(false);
  });

  it("refuses a forged state, and a state MACed without the directory domain", async () => {
    expect(
      (await call("/google/directory/callback?code=c&state=forged.sig")).status,
    ).toBe(404);
    const { signState } = await import("@oa/broker-core");
    const plain = await signState(env.DIRECTORY_STATE_KEY, {
      i: "inst-a",
      s: "s",
      h: "h",
      exp: Date.now() + 60_000,
    });
    expect(
      (
        await call(
          `/google/directory/callback?code=c&state=${encodeURIComponent(plain)}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /google/directory/token", () => {
  it("code grant: exchanges with the Directory client and the verifier; every token comes back sealed to the install", async () => {
    const { r, box, kid } = await signed(await codeBody());
    expect(r.status).toBe(200);
    const text = await r.text();
    for (const raw of ["rt-1", "at-1", "raw.id.token"])
      expect(text).not.toContain(raw);
    const out = JSON.parse(text) as { box: never };
    // Nothing but the box: the scope is sealed with the tokens.
    expect(Object.keys(out)).toEqual(["box"]);
    const tokens = JSON.parse(
      await openFromBroker(box, "inst-a", kid, out.box),
    ) as Record<string, string>;
    expect(tokens).toEqual({
      refresh_token: expect.stringMatching(/^v1\./),
      access_token: "at-1",
      id_token: "raw.id.token",
      scope: GOOGLE_DIRECTORY_SCOPES.join(" "),
    });
    // Google's refresh token never leaves raw, even inside the box.
    expect(tokens.refresh_token).not.toContain("rt-1");
    // Another install id or another key pair can't open it.
    await expect(openFromBroker(box, "inst-b", kid, out.box)).rejects.toThrow();
    await expect(
      openFromBroker(await boxKeyPair(), "inst-a", kid, out.box),
    ).rejects.toThrow();
    const t = tokenCalls[0];
    expect(t?.get("client_id")).toBe(env.GOOGLE_DIRECTORY_CLIENT_ID);
    expect(t?.get("client_secret")).toBe(env.GOOGLE_DIRECTORY_CLIENT_SECRET);
    expect(t?.get("redirect_uri")).toBe(`${ORIGIN}/google/directory/callback`);
    expect(t?.get("code_verifier")).toBe(VERIFIER);
  });

  /** The install-bound refresh blob a code grant hands `install`. */
  const blobFor = async (install = "inst-a", key = KEY_A) => {
    const bstate = (await start(install)).q?.get("state") ?? "";
    const { r, box, kid } = await signed(
      await codeBody({ install, bstate }),
      key,
    );
    const out = (await r.json()) as { box: never };
    return (
      JSON.parse(await openFromBroker(box, install, kid, out.box)) as {
        refresh_token: string;
      }
    ).refresh_token;
  };

  it("refresh grant: a sealed access token; Google's invalid_grant is 400 invalid_grant", async () => {
    const body = {
      install: "inst-a",
      ts: Date.now(),
      grant: "refresh",
      refresh_token: await blobFor(),
    };
    tokenCalls = [];
    const { r, box, kid } = await signed(body);
    const out = (await r.json()) as { box: never };
    expect(
      JSON.parse(await openFromBroker(box, "inst-a", kid, out.box)),
    ).toEqual({ access_token: "at-1", expires_in: 3599 });
    expect(tokenCalls[0]?.get("grant_type")).toBe("refresh_token");
    // Google sees its own token, unwrapped by the broker.
    expect(tokenCalls[0]?.get("refresh_token")).toBe("rt-1");
    tokenReply = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    const bad = (await signed({ ...body, ts: Date.now() })).r;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_grant" });
  });

  it("refresh tokens are bound to the install: a cross-install blob, a raw token or a tampered blob is refused", async () => {
    const aBlob = await blobFor("inst-a", KEY_A);
    tokenCalls = [];
    const refresh = (install: string, refresh_token: string) => ({
      install,
      ts: Date.now(),
      grant: "refresh",
      refresh_token,
    });
    // Install B, with B's own valid assertion, presents A's blob.
    expect((await signed(refresh("inst-b", aBlob), KEY_B)).r.status).toBe(401);
    // Google's raw refresh token.
    expect((await signed(refresh("inst-a", "rt-1"))).r.status).toBe(401);
    // A tampered blob.
    expect((await signed(refresh("inst-a", `${aBlob}A`))).r.status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
    // The right install succeeds.
    expect((await signed(refresh("inst-a", aBlob))).r.status).toBe(200);
  });

  it("/start and /token charge separate per-install buckets", async () => {
    const keys: string[] = [];
    const rl = {
      limit: async ({ key }: { key: string }) => (
        keys.push(key), { success: true }
      ),
    };
    const e = E({ RL_DIRECTORY_INSTALL: rl as never });
    const st = await start("inst-a", e);
    const text = JSON.stringify({
      epk: (await boxKeyPair()).pub,
      ...(await codeBody({ bstate: st.q?.get("state") ?? "" })),
    });
    const kid = await kidOf(KEY_A);
    await call(
      TOKEN,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oa-kid": kid,
          "x-oa-sig": await signRequest(KEY_A, TOKEN, kid, text),
        },
        body: text,
      },
      e,
    );
    expect(keys).toEqual(["start:install:inst-a", "token:install:inst-a"]);
  });

  it("refuses another install's state, a wrong verifier, a stale ts, another install's key and a missing box key", async () => {
    const other = (await start("inst-b")).q?.get("state") ?? "";
    expect((await signed(await codeBody({ bstate: other }))).r.status).toBe(
      401,
    );
    expect((await signed(await codeBody({ verifier: "other" }))).r.status).toBe(
      401,
    );
    expect(
      (await signed(await codeBody({ ts: Date.now() - 120_000 }))).r.status,
    ).toBe(401);
    expect((await signed(await codeBody(), KEY_B)).r.status).toBe(401);
    expect((await signed(await codeBody({ epk: "short" }))).r.status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("refuses a sign-in redeem signature (path-bound)", async () => {
    expect(
      (await signed(await codeBody(), KEY_A, "/google/redeem")).r.status,
    ).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("a code grant without a refresh token or id token is refused", async () => {
    tokenReply = () => Response.json({ access_token: "at", scope: "openid" });
    expect((await signed(await codeBody())).r.status).toBe(400);
  });

  it("logs route and outcome only, never a code, token or state", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => {
      lines.push(s);
    });
    const body = await codeBody({ code: "secret-code" });
    await signed(body);
    const all = lines.join("\n");
    for (const bad of [
      "secret-code",
      "rt-1",
      "at-1",
      body.bstate as string,
      VERIFIER,
    ])
      expect(all).not.toContain(bad);
  });
});

describe("registry", () => {
  it("the Worker only reads its registry: never put or delete", async () => {
    await start();
    const bstate = (await start()).q?.get("state") ?? "";
    await call(
      `/google/directory/callback?code=c&state=${encodeURIComponent(bstate)}`,
    );
    await signed(await codeBody());
    await signed({
      install: "inst-a",
      ts: Date.now(),
      grant: "refresh",
      refresh_token: "rt",
    });
    expect(calls.length).toBeGreaterThan(0);
    // Only get: never put, delete or list.
    expect(new Set(calls)).toEqual(new Set(["get"]));
  });

  it("the config never binds BROKER_REGISTRY, and keeps observability off", () => {
    expect(wranglerText).not.toMatch(/"binding": "BROKER_REGISTRY"/);
    expect(wranglerText.match(/"binding": "DIRECTORY_REGISTRY"/g)).toHaveLength(
      2,
    );
    // The sign-in client never appears here.
    expect(wranglerText).not.toMatch(/"GOOGLE_CLIENT_(ID|SECRET)"/);
    expect(
      wranglerText.match(/"observability": \{ "enabled": false \}/g),
    ).toHaveLength(2);
  });
});
