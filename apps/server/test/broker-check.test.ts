// POST R.adminBrokerCheck: the org owner proves the install reaches its
// brokers through the real transport and that they verify its signature.
// Only broker-core's post-verification refusal (401, no gate header,
// {"error":"bad_flow"}) is ok.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import authBroker, {
  type Env as AuthBrokerEnv,
} from "../../auth-broker/src/index.js";
import { createApp } from "../src/app.js";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { BROKER_CHECK_RL_UNITS } from "../src/routes/admin.js";
import {
  type BrokerCheck,
  checkBrokers,
} from "../src/services/broker-check.js";
import { CID, direct, TEST_BROKER_KEY } from "./auth-helpers.js";
import { brokerGate, registerInstall } from "./directory-helpers.js";
import { api, fetchAndWait, login } from "./helpers.js";
import { oauthToken } from "./mcp-helpers.js";

const app = createApp();
const AUTH_URL = "https://auth.hosted.test";
const DIR_URL = "https://directory.hosted.test";
const DIR_KEY = "directory-token-key-0123456789abcdef";

const ALLOW = {
  limit: async () => ({ success: true }),
} as unknown as RateLimit;
type Answer = (req: Request) => Promise<Response>;
const calls: string[] = [];
// Not async: a rejection adopted through an async return reaches workerd's
// unhandled-rejection hook a tick before it is handled.
const fake = (name: string, answer: Answer) =>
  ({
    fetch: (req: Request) => {
      calls.push(`${name} ${req.method} ${new URL(req.url).pathname}`);
      return answer(req);
    },
  }) as unknown as Fetcher;
const json =
  (body: unknown, status: number, headers = {}) =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
/** broker-core's refusal after verifying the install: ok. */
const REFUSED = json({ error: "bad_flow" }, 401);
/** broker-core's refusal before verifying (unknown install, bad signature). */
const UNVERIFIED = json({ error: "unauthorized" }, 401);
/** Another valid Ed25519 key (PKCS#8, base64url), registered nowhere. */
const OTHER_KEY =
  "MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

/** Both brokers configured (self-host), reached through `bind` (or HTTPS/props). */
const brokers = (
  bind: { auth?: Fetcher; directory?: Fetcher } = {},
  over: Partial<Env> = {},
): Env =>
  direct({
    AUTH_BROKER_URL: AUTH_URL,
    DIRECTORY_BROKER_URL: DIR_URL,
    BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    DIRECTORY_TOKEN_KEY: DIR_KEY,
    // The pool binds RL_AUTH (shared by every test here); the rate-limit
    // test brings its own.
    RL_AUTH: ALLOW,
    ...(bind.auth ? { BROKER: bind.auth } : {}),
    ...(bind.directory ? { DIRECTORY_BROKER: bind.directory } : {}),
    ...over,
  });
const hosted = (bind: { auth?: Fetcher; directory?: Fetcher } = {}) => {
  const e = brokers(bind, { HOSTED: "1" });
  delete (e as Partial<Env>).GOOGLE_CLIENT_SECRET;
  return e;
};
const both = (answer: Answer) =>
  brokers({ auth: fake("auth", answer), directory: fake("dir", answer) });

const call = (e: Env, cookie: string, props?: Record<string, unknown>) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.adminBrokerCheck}`, {
      method: "POST",
      headers: { "x-oa-request": "1", cookie },
    }),
    e,
    props,
  );

let owner: { cookie: string; userId: string };
beforeAll(async () => {
  owner = await login(`bcheck-owner-${crypto.randomUUID()}@a.com`, "owner");
});
/** Past the cooldown: no recent check to serve from the audit log. */
const forget = () =>
  env.DB.prepare(
    "delete from audit_events where action = 'auth.broker_check'",
  ).run();
beforeEach(forget);
afterEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
});

describe("who may run it", () => {
  it("the org owner gets 200 { auth, directory }", async () => {
    const r = await call(direct({ RL_AUTH: ALLOW }), owner.cookie);
    expect(r.status).toBe(200);
    const out = (await r.json()) as BrokerCheck;
    // The test pool configures no broker: both skipped.
    for (const k of ["auth", "directory"] as const)
      expect(out[k]).toEqual({
        ok: true,
        status: 0,
        ms: 0,
        transport: null,
        skipped: "no_broker",
      });
  });

  it("anyone else gets 404: admin, member, guest, a non-owner's PAT; anonymous 401", async () => {
    const got: Record<string, number> = {};
    for (const role of ["admin", "member", "guest"] as const) {
      const u = await login(
        `bcheck-${role}-${crypto.randomUUID()}@a.com`,
        role,
      );
      const r = await call(both(REFUSED), u.cookie);
      await r.body?.cancel();
      got[role] = r.status;
      if (role !== "guest") {
        const pat = (await createPat(env, u.userId, "bcheck")).token;
        const p = await fetchAndWait(
          app,
          new Request(`http://app.localhost${R.adminBrokerCheck}`, {
            method: "POST",
            headers: { authorization: `Bearer ${pat}` },
          }),
          both(REFUSED),
        );
        await p.body?.cancel();
        got[`${role} pat`] = p.status;
      }
    }
    const anon = await api(app, R.adminBrokerCheck, null, { method: "POST" });
    await anon.body?.cancel();
    got.anonymous = anon.status;
    expect(got).toEqual({
      admin: 404,
      "admin pat": 404,
      member: 404,
      "member pat": 404,
      guest: 404,
      anonymous: 401,
    });
    // Nothing reached a broker.
    expect(calls).toEqual([]);
  });
});

describe("the owner's other credentials", () => {
  it("the owner's own PAT gets 200; an MCP grant is no /api/v1 credential (401)", async () => {
    const email = `bcheck-own2-${crypto.randomUUID()}@a.com`;
    const o = await login(email, "owner");
    const { token } = await createPat(env, o.userId, "bcheck");
    const bearer = (t: string) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${R.adminBrokerCheck}`, {
          method: "POST",
          headers: { authorization: `Bearer ${t}` },
        }),
        both(REFUSED),
      );
    const r = await bearer(token);
    expect(r.status).toBe(200);
    expect(((await r.json()) as BrokerCheck).auth).toMatchObject({
      ok: true,
    });
    await forget();
    const { accessToken } = await oauthToken(email, "Agent", o);
    const g = await bearer(accessToken);
    await g.body?.cancel();
    expect(g.status).toBe(401);
  });
});

describe("what counts as verified", () => {
  it("broker-core's post-verification refusal (401 {error: bad_flow}) is ok, by the binding", async () => {
    const out = await checkBrokers(both(REFUSED));
    expect(out.auth).toMatchObject({
      ok: true,
      status: 401,
      transport: "binding",
    });
    expect(out.directory).toMatchObject({
      ok: true,
      status: 401,
      transport: "binding",
    });
    expect(out.auth.error).toBeUndefined();
    expect(calls.sort()).toEqual([
      "auth POST /google/redeem",
      "dir POST /google/directory/token",
    ]);
  });

  it("401 {error: unauthorized} is unverified; 401 {error: stale} is stale", async () => {
    const pre = await checkBrokers(both(UNVERIFIED));
    for (const k of ["auth", "directory"] as const)
      expect(pre[k]).toMatchObject({
        ok: false,
        status: 401,
        error: "unverified",
      });
    const stale = await checkBrokers(both(json({ error: "stale" }, 401)));
    for (const k of ["auth", "directory"] as const)
      expect(stale[k]).toMatchObject({
        ok: false,
        status: 401,
        error: "stale",
      });
  });

  describe("the real brokers, in process", () => {
    const rl = { limit: async () => ({ success: true }) };
    const authEnv = {
      BROKER_REGISTRY: env.OAUTH_KV,
      GOOGLE_CLIENT_ID: CID,
      GOOGLE_CLIENT_SECRET: "broker-secret",
      BROKER_ORIGIN: AUTH_URL,
      BROKER_STATE_KEY: "s".repeat(40),
      RL_BROKER_IP: rl,
      RL_BROKER_INSTALL: rl,
    } as unknown as AuthBrokerEnv;
    const run = async (over: Partial<Env> = {}) => {
      await registerInstall();
      const logs = vi.spyOn(console, "log");
      const e = {
        ...hosted({
          auth: fake("auth", (req) =>
            Promise.resolve(authBroker.fetch(req as never, authEnv)),
          ),
        }),
        ...over,
      } as Env;
      const gate = brokerGate([]);
      const dir = fake("dir", (req) => gate.fetch(req));
      const out = await withBrokerProps(
        { props: { DIRECTORY_BROKER: dir } },
        () => checkBrokers(e),
      );
      const lines = logs.mock.calls.map((c) => String(c[0])).join("\n");
      return { out, lines, gate };
    };

    it(
      "a correctly signed check is verified and refused as bad_flow: ok",
      async () => {
        const { out, lines, gate } = await run();
        expect(out.auth).toMatchObject({
          ok: true,
          status: 401,
          transport: "binding",
        });
        expect(out.directory).toMatchObject({
          ok: true,
          status: 401,
          transport: "props",
        });
        expect(gate.calls).toEqual([
          { method: "POST", path: "/google/directory/token" },
        ]);
        expect(lines).toMatch(/"route":"redeem","outcome":"bad_flow"/);
        expect(lines).toMatch(/"route":"token","outcome":"bad_refresh"/);
      },
    );

    it("another signing key: unverified (bad_signature)", async () => {
      const { out, lines } = await run({ BROKER_SIGNING_KEY: OTHER_KEY });
      for (const k of ["auth", "directory"] as const)
        expect(out[k]).toMatchObject({
          ok: false,
          status: 401,
          error: "unverified",
        });
      expect(lines).toMatch(/"route":"redeem","outcome":"bad_signature"/);
      expect(lines).toMatch(/"route":"token","outcome":"bad_signature"/);
    });

    it("an install id the broker doesn't know: unverified (unknown_install)", async () => {
      const { out, lines } = await run({ INSTALL_ID: "inst-unknown" });
      for (const k of ["auth", "directory"] as const)
        expect(out[k]).toMatchObject({
          ok: false,
          status: 401,
          error: "unverified",
        });
      expect(lines).toMatch(/"route":"redeem","outcome":"unknown_install"/);
      expect(lines).toMatch(/"route":"token","outcome":"unknown_install"/);
    });
  });

  it("401 with the gate header is not ok (binding: status kept; props: thrown, status 0)", async () => {
    const gated = json({ error: "bad_flow" }, 401, { "x-oa-gate": "1" });
    const out = await checkBrokers(both(gated));
    expect(out.auth).toMatchObject({ ok: false, status: 401, error: "gate" });
    const viaProps = await withBrokerProps(
      { props: { AUTH_BROKER: fake("auth", gated) } },
      () => checkBrokers(hosted()),
    );
    expect(viaProps.auth).toMatchObject({
      ok: false,
      status: 0,
      transport: "props",
      error: "gate",
    });
  });

  it("401 with any other body is not ok", async () => {
    for (const body of [
      { error: "bad_flow", extra: 1 },
      { error: "nope" },
      "bad_flow",
    ]) {
      const out = await checkBrokers(both(json(body, 401)));
      expect(out.auth, JSON.stringify(body)).toMatchObject({
        ok: false,
        status: 401,
      });
      expect(out.auth.error).toBeUndefined();
      expect(out.directory.ok).toBe(false);
    }
    const html = await checkBrokers(
      both(async () => new Response("<h1>401</h1>", { status: 401 })),
    );
    expect(html.auth.ok).toBe(false);
  });

  it("5xx and 522 are not ok, with the status", async () => {
    for (const status of [503, 522, 500]) {
      const out = await checkBrokers(both(json({ error: "x" }, status)));
      expect(out.auth).toMatchObject({ ok: false, status });
      expect(out.directory).toMatchObject({ ok: false, status });
      expect(out.auth.error).toBeUndefined();
    }
  });

  it("a broker that never answers times out: status 0, timeout", async () => {
    const out = await checkBrokers(
      both(() => new Promise<never>(() => {})),
      20,
    );
    expect(out.auth).toMatchObject({ ok: false, status: 0, error: "timeout" });
    expect(out.directory).toMatchObject({
      ok: false,
      status: 0,
      error: "timeout",
    });
  });

  it("a late answer after the timeout has its body cancelled", async () => {
    let cancelled!: () => void;
    const gone = new Promise<void>((r) => {
      cancelled = r;
    });
    let answer!: (res: Response) => void;
    const late = new Promise<Response>((r) => {
      answer = r;
    });
    const out = await checkBrokers(
      brokers({
        auth: fake("auth", () => late),
        directory: fake("dir", REFUSED),
      }),
      10,
    );
    expect(out.auth).toMatchObject({ ok: false, status: 0, error: "timeout" });
    const res = new Response('{"error":"bad_flow"}', { status: 401 });
    const body = res.body as ReadableStream;
    const cancel = body.cancel.bind(body);
    body.cancel = (reason?: unknown) => {
      cancelled();
      return cancel(reason);
    };
    answer(res);
    await gone;
  });

  it("a network error is status 0, network", async () => {
    const out = await checkBrokers(
      both(() => {
        throw new TypeError("connect failed: https://secret.example/x");
      }),
    );
    expect(out.auth).toEqual({
      ok: false,
      status: 0,
      ms: expect.any(Number),
      transport: "binding",
      error: "network",
    });
  });

  it("hosted without a binding or props: unavailable, no HTTPS", async () => {
    const net = vi.spyOn(globalThis, "fetch");
    const out = await checkBrokers(hosted());
    for (const k of ["auth", "directory"] as const)
      expect(out[k]).toMatchObject({
        ok: false,
        status: 0,
        transport: null,
        error: "unavailable",
      });
    expect(net).not.toHaveBeenCalled();
  });

  it("a stale capability is status 0, stale_props", async () => {
    const stale = {
      fetch: async () => {
        throw new Error("Cannot perform I/O on behalf of a different request.");
      },
    };
    const out = await withBrokerProps({ props: { AUTH_BROKER: stale } }, () =>
      checkBrokers(hosted()),
    );
    expect(out.auth).toMatchObject({
      ok: false,
      status: 0,
      error: "stale_props",
    });
  });

  it("the props transport is reported as props", async () => {
    const out = await withBrokerProps(
      {
        props: {
          AUTH_BROKER: fake("auth", REFUSED),
          DIRECTORY_BROKER: fake("dir", REFUSED),
        },
      },
      () => checkBrokers(hosted()),
    );
    expect(out.auth).toMatchObject({ ok: true, transport: "props" });
    expect(out.directory).toMatchObject({ ok: true, transport: "props" });
  });

  it("self-host without a binding uses HTTPS (reported as https)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => REFUSED());
    const out = await checkBrokers(brokers());
    expect(out.auth).toMatchObject({ ok: true, transport: "https" });
    expect(out.directory).toMatchObject({ ok: true, transport: "https" });
  });

  it("no broker configured (direct Google, no directory broker): skipped", async () => {
    const net = vi.spyOn(globalThis, "fetch");
    const out = await checkBrokers(
      direct({
        GOOGLE_DIRECTORY_CLIENT_ID: "d",
        GOOGLE_DIRECTORY_CLIENT_SECRET: "s",
        DIRECTORY_TOKEN_KEY: DIR_KEY,
      }),
    );
    expect(out).toEqual({
      auth: {
        ok: true,
        status: 0,
        ms: 0,
        transport: null,
        skipped: "no_broker",
      },
      directory: {
        ok: true,
        status: 0,
        ms: 0,
        transport: null,
        skipped: "no_broker",
      },
    });
    expect(net).not.toHaveBeenCalled();
  });
});

describe("audit and rate limit", () => {
  it("writes one auth.broker_check row by the owner: statuses only, no bodies, codes or URLs", async () => {
    const logs = vi.spyOn(console, "log");
    const before = Date.now();
    const e = brokers({
      auth: fake("auth", REFUSED),
      directory: fake("dir", json({ error: "x" }, 503)),
    });
    const r = await call(e, owner.cookie);
    expect(r.status).toBe(200);
    const out = (await r.json()) as BrokerCheck;
    expect(Object.keys(out).sort()).toEqual(["auth", "directory"]);
    expect(Object.keys(out.auth).sort()).toEqual([
      "ms",
      "ok",
      "status",
      "transport",
    ]);
    const rows = await env.DB.prepare(
      "select actor_kind, actor_id, target_type, target_id, detail from audit_events where action = 'auth.broker_check' and at >= ?",
    )
      .bind(before)
      .all<Record<string, string | null>>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0] as Record<string, string | null>;
    expect(row).toMatchObject({
      actor_kind: "user",
      actor_id: owner.userId,
      target_type: "directory",
      target_id: "brokers",
    });
    expect(JSON.parse(row.detail as string)).toEqual({
      auth: { ok: true, status: 401, transport: "binding" },
      directory: {
        ok: false,
        status: 503,
        transport: "binding",
      },
    });
    const all = `${row.detail}\n${JSON.stringify(out)}\n${logs.mock.calls
      .map((c) => String(c[0]))
      .join("\n")}`;
    for (const secret of [
      "oa-broker-check",
      "hosted.test",
      "bad_flow",
      "https://",
      TEST_BROKER_KEY,
    ])
      expect(all).not.toContain(secret);
  });

  it("within 30 s the last result comes back cached: no broker call, no audit row", async () => {
    const e = both(REFUSED);
    const first = await call(e, owner.cookie);
    const fb = await first.text();
    expect(first.status, fb).toBe(200);
    expect((JSON.parse(fb) as BrokerCheck).auth.cached).toBeUndefined();
    expect(calls).toHaveLength(2);
    const again = await call(e, owner.cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      auth: {
        ok: true,
        status: 401,
        ms: 0,
        transport: "binding",
        cached: true,
      },
      directory: {
        ok: true,
        status: 401,
        ms: 0,
        transport: "binding",
        cached: true,
      },
    });
    expect(calls).toHaveLength(2);
    const n = await env.DB.prepare(
      "select count(*) n from audit_events where action = 'auth.broker_check'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
    // Past the cooldown it runs again.
    await env.DB.prepare(
      "update audit_events set at = at - 31000 where action = 'auth.broker_check'",
    ).run();
    const later = await call(e, owner.cookie);
    expect(((await later.json()) as BrokerCheck).auth.cached).toBeUndefined();
    expect(calls).toHaveLength(4);
  });

  it("RL_AUTH per install: 2 checks a minute, the third is 429", async () => {
    expect(BROKER_CHECK_RL_UNITS).toBe(10);
    const keys: string[] = [];
    // RL_AUTH's own limit: 20 a minute per key.
    let left = 20;
    const RL_AUTH = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: left-- > 0 };
      },
    } as unknown as RateLimit;
    const e = { ...both(REFUSED), RL_AUTH } as Env;
    for (let i = 0; i < 2; i++) {
      const ok = await call(e, owner.cookie);
      await ok.body?.cancel();
      expect(ok.status).toBe(200);
      await forget();
    }
    const third = await call(e, owner.cookie);
    expect(third.status).toBe(429);
    expect(
      ((await third.json()) as { error: { code: string } }).error.code,
    ).toBe("rate_limited");
    expect(new Set(keys)).toEqual(new Set(["broker-check:inst-a"]));
    // The refused check never reached a broker.
    expect(calls).toHaveLength(4);
  });
});
