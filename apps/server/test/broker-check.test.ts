// POST R.adminBrokerCheck: the org owner proves the install reaches its
// brokers through the real transport. Only broker-core's own refusal (401,
// no gate header, {"error":"unauthorized"}) counts as reached.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import authBroker, {
  type Env as AuthBrokerEnv,
} from "../../auth-broker/src/index.js";
import { createApp } from "../src/app.js";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import {
  type BrokerCheck,
  checkBrokers,
} from "../src/services/broker-check.js";
import { CID, direct, TEST_BROKER_KEY } from "./auth-helpers.js";
import { brokerGate, registerInstall } from "./directory-helpers.js";
import { api, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const AUTH_URL = "https://auth.hosted.test";
const DIR_URL = "https://directory.hosted.test";
const DIR_KEY = "directory-token-key-0123456789abcdef";

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
const REFUSED = json({ error: "unauthorized" }, 401);

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
afterEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
});

describe("who may run it", () => {
  it("the org owner gets 200 { auth, directory }", async () => {
    const r = await api(app, R.adminBrokerCheck, owner.cookie, {
      method: "POST",
    });
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

describe("what counts as reached", () => {
  it("broker-core's refusal (401 {error: unauthorized}) is ok, by the binding", async () => {
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

  it("signs a real redeem and token request: the real brokers refuse them as bad_flow", async () => {
    await registerInstall();
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
    const logs = vi.spyOn(console, "log");
    const e = hosted({
      auth: {
        fetch: (req: Request) => authBroker.fetch(req as never, authEnv),
      } as unknown as Fetcher,
    });
    const gate = brokerGate([]);
    const out = await withBrokerProps(
      { props: { DIRECTORY_BROKER: gate } },
      () => checkBrokers(e),
    );
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
    // Both got past the signature to the flow check.
    const lines = logs.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toMatch(/redeem[^\n]*bad_flow/);
    expect(lines).toMatch(/token[^\n]*bad_flow/);
  });

  it("401 with the gate header is not ok (binding: status kept; props: thrown, status 0)", async () => {
    const gated = json({ error: "unauthorized" }, 401, { "x-oa-gate": "1" });
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
      { error: "unauthorized", extra: 1 },
      { error: "nope" },
      "unauthorized",
    ]) {
      const out = await checkBrokers(both(json(body, 401)));
      expect(out.auth, JSON.stringify(body)).toMatchObject({
        ok: false,
        status: 401,
      });
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

  it("a stale capability is status 0, stale", async () => {
    const stale = {
      fetch: async () => {
        throw new Error("Cannot perform I/O on behalf of a different request.");
      },
    };
    const out = await withBrokerProps({ props: { AUTH_BROKER: stale } }, () =>
      checkBrokers(hosted()),
    );
    expect(out.auth).toMatchObject({ ok: false, status: 0, error: "stale" });
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
  it("writes one system auth.broker_check row: statuses only, no bodies, codes or URLs", async () => {
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
      actor_kind: "system",
      actor_id: null,
      target_type: "directory",
      target_id: "brokers",
    });
    expect(JSON.parse(row.detail as string)).toEqual({
      auth: { ok: true, status: 401, transport: "binding" },
      directory: { ok: false, status: 503, transport: "binding" },
    });
    const all = `${row.detail}\n${JSON.stringify(out)}\n${logs.mock.calls
      .map((c) => String(c[0]))
      .join("\n")}`;
    for (const secret of [
      "oa-broker-check",
      "hosted.test",
      "unauthorized",
      "https://",
      TEST_BROKER_KEY,
    ])
      expect(all).not.toContain(secret);
  });

  it("RL_AUTH per install, one unit per broker: over the limit is 429", async () => {
    const keys: string[] = [];
    let left = 2;
    const RL_AUTH = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: left-- > 0 };
      },
    } as unknown as RateLimit;
    const e = { ...both(REFUSED), RL_AUTH } as Env;
    const first = await call(e, owner.cookie);
    await first.body?.cancel();
    expect(first.status).toBe(200);
    const second = await call(e, owner.cookie);
    expect(second.status).toBe(429);
    expect(
      ((await second.json()) as { error: { code: string } }).error.code,
    ).toBe("rate_limited");
    expect(new Set(keys)).toEqual(new Set(["broker-check:inst-a"]));
    // The refused check never reached a broker.
    expect(calls).toHaveLength(2);
  });
});
