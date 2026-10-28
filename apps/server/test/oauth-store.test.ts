import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "../src/cron.js";
import { revokeAllGrants } from "../src/mcp/oauth-api.js";
import {
  BACKFILLED_KEY,
  COPY_PAGE,
  copyKvToD1,
  D1KvStore,
  KV_WRITES_OFF_KEY,
  keyCompare,
  mapStoreError,
  OAUTH_SWEEP_QUERIES,
  type OAuthStoreMode,
  oauthEnv,
  resetOAuthStoreMarkers,
  sweepOAuthStore,
  TOMBSTONE_DAYS,
} from "../src/mcp/oauth-store.js";
import { login } from "./helpers.js";
import {
  APP,
  authorizeUrl,
  b64url,
  callWorker,
  E,
  MCP_URL,
  nextIp,
  pkce,
  REDIRECT,
} from "./mcp-helpers.js";

// The OAuth store move (post-M1): OAUTH_STORE kv | dual | d1. The provider's
// own flows run in every mode with identical results; d1 and dual close
// #769 and the post-revocation window; dual never loses a KV-only grant; d1
// runs with no OAUTH_KV binding at all.

const MODES: readonly OAuthStoreMode[] = ["kv", "dual", "d1"];
const tag = newId().slice(0, 6).toLowerCase();
let seq = 0;
const email = (what: string) => `os-${what}-${tag}-${++seq}@x.com`;
const nowS = () => Math.floor(Date.now() / 1000);

type TestEnv = typeof env;
const inMode = (mode: OAuthStoreMode, over: Record<string, unknown> = {}) =>
  E({ OAUTH_STORE: mode, ...over }) as TestEnv;

/** d1 with OAUTH_KV deleted from env (not just undefined). */
function noKv(over: Record<string, unknown> = {}): TestEnv {
  const e = { ...(env as object), OAUTH_STORE: "d1", ...over } as Record<
    string,
    unknown
  >;
  delete e.OAUTH_KV;
  return e as unknown as TestEnv;
}

// ------------------------------------------------------------ flow helpers

const form = (e: unknown, body: Record<string, string>) =>
  callWorker(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: new URLSearchParams(body).toString(),
    }),
    e,
  );

async function register(e: unknown, name = "Store Agent"): Promise<string> {
  const r = await callWorker(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    e,
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Consent approved as `cookie`: an unredeemed code. */
async function authorize(e: unknown, cookie: string, clientId: string) {
  const { verifier, challenge } = await pkce();
  const url = authorizeUrl(clientId, challenge);
  const r0 = await callWorker(new Request(url, { headers: { cookie } }), e);
  const body = await r0.text();
  expect(r0.status).toBe(200);
  const field = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(body)?.[1] ?? "";
  const cookies = r0.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");
  const fields = new URLSearchParams({
    csrf: field("csrf"),
    request: field("request"),
    decision: "approve",
  }).toString();
  const r = await callWorker(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie: [cookie, ...cookies].join("; "),
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(fields.length),
      },
      body: fields,
    }),
    e,
  );
  expect(r.status).toBe(302);
  const code = new URL(r.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  return { code: code ?? "", verifier };
}

type Tokens = { access_token: string; refresh_token: string };

async function exchange(e: unknown, clientId: string, code: string, v: string) {
  return form(e, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: v,
    resource: `${APP}/mcp`,
  });
}

const refresh = (e: unknown, clientId: string, rt: string) =>
  form(e, {
    grant_type: "refresh_token",
    refresh_token: rt,
    client_id: clientId,
  });

/** Register, consent and exchange in `e`: a member, client and tokens. */
async function connectAgent(e: unknown, who = email("agent")) {
  const member = await login(who);
  const clientId = await register(e);
  const { code, verifier } = await authorize(e, member.cookie, clientId);
  const t = await exchange(e, clientId, code, verifier);
  expect(t.status).toBe(200);
  return { member, clientId, ...((await t.json()) as Tokens) };
}

const mcp = (e: unknown, token: string) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    e,
  );

const appCall = (e: unknown, path: string, cookie: string, method = "GET") =>
  callWorker(
    new Request(`${APP}${path}`, {
      method,
      headers: { cookie, "x-oa-request": "1" },
    }),
    e,
  );

const grants = async (e: unknown, cookie: string) => {
  const r = await appCall(e, R.oauthClients, cookie);
  expect(r.status).toBe(200);
  return (await r.json()) as { grantId: string; clientName: string }[];
};

/**
 * KV as seen through one edge location's read cache: the first value read
 * for a key is served again for the rest of the test (issue #769), even
 * after a put or delete elsewhere.
 */
function staleKv(kv: KVNamespace): KVNamespace {
  const seen = new Map<string, string | null>();
  return new Proxy(kv, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === "get")
        return async (key: string, opt?: unknown) => {
          if (!seen.has(key)) seen.set(key, await t.get(key, "text"));
          const s = seen.get(key) ?? null;
          const type =
            typeof opt === "string" ? opt : (opt as { type?: string })?.type;
          return s !== null && type === "json" ? JSON.parse(s) : s;
        };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** D1 with every executed statement counted (batch: each statement). */
function countingDb(db: D1Database) {
  const sqls: string[] = [];
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const w = new Proxy(s, {
      get(t, p) {
        if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
        if (p === "first" || p === "all" || p === "run" || p === "raw")
          return (...a: unknown[]) => {
            sqls.push(sql);
            return (Reflect.get(t, p) as (...x: unknown[]) => unknown).apply(
              t,
              a,
            );
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(w, s);
    return w;
  };
  const sqlOf = new WeakMap<object, string>();
  const proxy = new Proxy(db, {
    get(t, p) {
      if (p === "prepare")
        return (sql: string) => {
          const w = wrap(t.prepare(sql), sql);
          sqlOf.set(w, sql);
          return w;
        };
      if (p === "batch")
        return (stmts: D1PreparedStatement[]) => {
          for (const s of stmts) sqls.push(sqlOf.get(s) ?? "<bound>");
          return t.batch(stmts.map((s) => real.get(s) ?? s));
        };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return {
    db: proxy,
    sqls,
    oauthKv: () => sqls.filter((s) => /oauth_kv/.test(s)),
  };
}

const rowOf = (key: string) =>
  env.DB.prepare("select * from oauth_kv where key = ?")
    .bind(key)
    .first<{ key: string; value: string; expires_at: number | null }>();

const grantKeyFor = async (userId: string) => {
  const r = await env.DB.prepare(
    "select key from oauth_kv where key like ? and (expires_at is null or expires_at > ?)",
  )
    .bind(`grant:${userId}:%`, nowS())
    .first<{ key: string }>();
  return r?.key ?? "";
};

/** KV_WRITES_OFF's stamp (epoch ms text), or null. */
const offSince = async () =>
  (
    await env.DB.prepare("select value from settings where key = ?")
      .bind(KV_WRITES_OFF_KEY)
      .first<{ value: string }>()
  )?.value ?? null;

// Each test starts as if this install never served in d1 mode (leaving d1
// is refused otherwise), with no isolate's markers checked.
beforeEach(async () => {
  resetOAuthStoreMarkers();
  await env.DB.prepare("delete from settings where key = ?")
    .bind(KV_WRITES_OFF_KEY)
    .run();
});

/** Any app-host request: a serve, which checks and writes the markers. */
const robots = (e: unknown) => callWorker(new Request(`${APP}/robots.txt`), e);

/** Every D1 query of one nightly cron run here (d1 mode, OAuth backlog). */
const NIGHTLY_QUERIES = 18;

/** Another isolate: its own marker check (keyed by the DB binding). */
const isolate = (mode: OAuthStoreMode, over: Record<string, unknown> = {}) =>
  inMode(mode, { DB: countingDb(env.DB).db, ...over });

// ------------------------------------------------------------ contract

describe("contract: the provider's flows in kv, dual and d1", () => {
  it("register, authorize, exchange, refresh, revoke, listUserGrants, revokeAllGrants: identical", async () => {
    const results: Record<string, unknown> = {};
    for (const mode of MODES) {
      const e = inMode(mode);
      const a = await connectAgent(e);
      const steps: Record<string, unknown> = {};
      steps.mcp = (await mcp(e, a.access_token)).status;
      const r1 = await refresh(e, a.clientId, a.refresh_token);
      steps.refresh = r1.status;
      const t1 = (await r1.json()) as Tokens & {
        token_type: string;
        expires_in: number;
        scope?: string;
      };
      steps.tokenShape = {
        token_type: t1.token_type,
        expires_in: t1.expires_in,
        scope: t1.scope,
      };
      steps.mcpAfterRefresh = (await mcp(e, t1.access_token)).status;
      const listed = await grants(e, a.member.cookie);
      steps.listed = listed.map((g) => g.clientName);
      // revoke (the user's DELETE: revokeGrant)
      const id = listed[0]?.grantId ?? "";
      steps.revoke = (
        await appCall(e, R.oauthClient(id), a.member.cookie, "DELETE")
      ).status;
      steps.mcpAfterRevoke = (await mcp(e, t1.access_token)).status;
      const rr = await refresh(e, a.clientId, t1.refresh_token);
      steps.refreshAfterRevoke = [
        rr.status,
        ((await rr.json()) as { error: string }).error,
      ];
      steps.listedAfterRevoke = (await grants(e, a.member.cookie)).length;
      // Three more grants (three clients), then revokeAllGrants.
      const tokens: string[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await register(e, `Agent ${i}`);
        const { code, verifier } = await authorize(e, a.member.cookie, c);
        const t = await exchange(e, c, code, verifier);
        tokens.push(((await t.json()) as Tokens).access_token);
      }
      steps.listedThree = (await grants(e, a.member.cookie))
        .map((g) => g.clientName)
        .sort();
      await revokeAllGrants(e as never, a.member.userId);
      steps.afterRevokeAll = (await grants(e, a.member.cookie)).length;
      steps.mcpAfterRevokeAll = await Promise.all(
        tokens.map(async (t) => (await mcp(e, t)).status),
      );
      results[mode] = steps;
    }
    expect(results.kv).toEqual({
      mcp: 200,
      refresh: 200,
      tokenShape: { token_type: "bearer", expires_in: 86400, scope: "" },
      mcpAfterRefresh: 200,
      listed: ["Store Agent"],
      revoke: 204,
      mcpAfterRevoke: 401,
      refreshAfterRevoke: [400, "invalid_grant"],
      listedAfterRevoke: 0,
      listedThree: ["Agent 0", "Agent 1", "Agent 2"],
      afterRevokeAll: 0,
      mcpAfterRevokeAll: [401, 401, 401],
    });
    expect(results.dual).toEqual(results.kv);
    expect(results.d1).toEqual(results.kv);
  });

  it("d1 writes D1 only; dual writes both; kv writes KV only", async () => {
    for (const mode of MODES) {
      const a = await connectAgent(inMode(mode));
      const inD1 = await grantKeyFor(a.member.userId);
      const kvList = await env.OAUTH_KV.list({
        prefix: `grant:${a.member.userId}:`,
      });
      expect([mode, !!inD1, kvList.keys.length > 0]).toEqual([
        mode,
        mode !== "kv",
        mode !== "d1",
      ]);
    }
  });
});

// ------------------------------------------------------------ #769, revocation

describe("#769 and revocation", () => {
  it("a refresh straight after the exchange works in d1 and dual (stale KV edge cache); kv shows the bug", async () => {
    const out: Record<string, number> = {};
    for (const mode of MODES) {
      const e = inMode(mode, { OAUTH_KV: staleKv(env.OAUTH_KV) });
      const a = await connectAgent(e);
      out[mode] = (await refresh(e, a.clientId, a.refresh_token)).status;
    }
    // kv: the edge cache serves the pre-redeem grant (the #769 repro).
    expect(out).toEqual({ kv: 400, dual: 200, d1: 200 });
  });

  it("a revoked token is refused at once in d1 and dual (stale KV edge cache)", async () => {
    const out: Record<string, number> = {};
    for (const mode of MODES) {
      const e = inMode(mode, { OAUTH_KV: staleKv(env.OAUTH_KV) });
      const a = await connectAgent(e);
      expect((await mcp(e, a.access_token)).status).toBe(200);
      const [g] = await grants(e, a.member.cookie);
      const d = await appCall(
        e,
        R.oauthClient(g?.grantId ?? ""),
        a.member.cookie,
        "DELETE",
      );
      expect(d.status).toBe(204);
      out[mode] = (await mcp(e, a.access_token)).status;
    }
    // kv: the cached token record still verifies (up to 60 s in prod).
    expect(out).toEqual({ kv: 200, dual: 401, d1: 401 });
  });

  it("dual: a grant held only in KV is listed, works, and is revoked", async () => {
    const a = await connectAgent(inMode("kv"));
    expect(await grantKeyFor(a.member.userId)).toBe("");
    const dual = inMode("dual");
    const listed = await grants(dual, a.member.cookie);
    expect(listed.map((g) => g.clientName)).toEqual(["Store Agent"]);
    expect((await mcp(dual, a.access_token)).status).toBe(200);
    // A removed member's path: revokeAllGrants finds it through the merge.
    await revokeAllGrants(dual as never, a.member.userId);
    expect((await mcp(dual, a.access_token)).status).toBe(401);
    expect((await mcp(inMode("kv"), a.access_token)).status).toBe(401);
    expect(
      (await env.OAUTH_KV.list({ prefix: `grant:${a.member.userId}:` })).keys,
    ).toEqual([]);
    expect(
      (await env.OAUTH_KV.list({ prefix: `token:${a.member.userId}:` })).keys,
    ).toEqual([]);
  });

  it("dual: a deleted key's tombstone hides KV's copy (no resurrection)", async () => {
    const dual = inMode("dual");
    const key = `grant:tomb-${tag}:g1`;
    await env.OAUTH_KV.put(key, JSON.stringify({ id: "g1" }));
    const s = oauthEnv(dual).OAUTH_KV;
    await s.delete(key);
    // KV's delete is lost (another location still holds it): D1 decides.
    await env.OAUTH_KV.put(key, JSON.stringify({ id: "g1" }));
    const fresh = oauthEnv(dual).OAUTH_KV;
    expect(await fresh.get(key)).toBeNull();
    expect((await fresh.list({ prefix: `grant:tomb-${tag}:` })).keys).toEqual(
      [],
    );
    await env.OAUTH_KV.delete(key);
  });

  it("switching dual to kv loses nothing", async () => {
    const dual = inMode("dual");
    const a = await connectAgent(dual);
    const r = await refresh(dual, a.clientId, a.refresh_token);
    const t = (await r.json()) as Tokens;
    const kv = inMode("kv");
    expect((await mcp(kv, t.access_token)).status).toBe(200);
    expect((await grants(kv, a.member.cookie)).length).toBe(1);
    expect((await refresh(kv, a.clientId, t.refresh_token)).status).toBe(200);
  });

  it("dual -> kv (revoke in kv) -> dual: the revoked grant stays dead", async () => {
    const dual = inMode("dual");
    const a = await connectAgent(dual);
    expect(await grantKeyFor(a.member.userId)).not.toBe("");
    const kv = inMode("kv");
    const [g] = await grants(kv, a.member.cookie);
    expect(
      (
        await appCall(
          kv,
          R.oauthClient(g?.grantId ?? ""),
          a.member.cookie,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    expect((await mcp(kv, a.access_token)).status).toBe(401);
    // Back to dual: D1 still held the grant's rows from the first dual run.
    expect((await mcp(dual, a.access_token)).status).toBe(401);
    const rr = await refresh(dual, a.clientId, a.refresh_token);
    expect(rr.status).toBe(400);
    expect(await grants(dual, a.member.cookie)).toEqual([]);
  });

  it("kv and dual isolates overlapping: a revoke in either kills the grant in both", async () => {
    // kv isolate revokes a grant a dual isolate wrote (its markers already
    // checked by an earlier write, as a long-lived isolate's would be).
    const kvIso = isolate("kv");
    await connectAgent(kvIso);
    const dualIso = isolate("dual");
    const a = await connectAgent(dualIso);
    expect(await grantKeyFor(a.member.userId)).not.toBe("");
    await revokeAllGrants(kvIso as never, a.member.userId);
    expect((await mcp(kvIso, a.access_token)).status).toBe(401);
    expect((await mcp(dualIso, a.access_token)).status).toBe(401);
    expect((await refresh(dualIso, a.clientId, a.refresh_token)).status).toBe(
      400,
    );
    expect(await grants(dualIso, a.member.cookie)).toEqual([]);
    // dual isolate revokes a grant a kv isolate wrote.
    const b = await connectAgent(kvIso);
    expect(await grantKeyFor(b.member.userId)).toBe("");
    await revokeAllGrants(dualIso as never, b.member.userId);
    expect((await mcp(dualIso, b.access_token)).status).toBe(401);
    expect((await mcp(kvIso, b.access_token)).status).toBe(401);
    expect((await refresh(kvIso, b.clientId, b.refresh_token)).status).toBe(
      400,
    );
  });

  it("kv and dual isolates overlapping: a kv refresh never leaves dual a stale grant", async () => {
    const kvIso = isolate("kv");
    await connectAgent(kvIso);
    const dualIso = isolate("dual");
    const a = await connectAgent(dualIso);
    // kv rotates the grant (KV only): D1's pre-refresh row goes.
    const r = await refresh(kvIso, a.clientId, a.refresh_token);
    expect(r.status).toBe(200);
    const t = (await r.json()) as Tokens;
    expect((await mcp(dualIso, t.access_token)).status).toBe(200);
    expect((await refresh(dualIso, a.clientId, t.refresh_token)).status).toBe(
      200,
    );
  });

  it("an expired grant or token is refused before the sweep runs; the sweep then deletes it", async () => {
    const e = inMode("d1");
    const a = await connectAgent(e);
    const key = await grantKeyFor(a.member.userId);
    const userGrant = key.slice("grant:".length);
    const tok = await env.DB.prepare(
      "select key from oauth_kv where key like ?",
    )
      .bind(`token:${userGrant}:%`)
      .first<{ key: string }>();
    expect(tok?.key).toBeTruthy();
    await env.DB.prepare("update oauth_kv set expires_at = ? where key = ?")
      .bind(nowS() - 1, tok?.key)
      .run();
    expect((await mcp(e, a.access_token)).status).toBe(401);
    expect(await rowOf(tok?.key ?? "")).not.toBeNull();
    await env.DB.prepare("update oauth_kv set expires_at = ? where key = ?")
      .bind(nowS() - 1, key)
      .run();
    const r = await refresh(e, a.clientId, a.refresh_token);
    expect(r.status).toBe(400);
    expect(await grants(e, a.member.cookie)).toEqual([]);
    expect(await rowOf(key)).not.toBeNull();
    expect(await sweepOAuthStore(env, Date.now())).toBeGreaterThanOrEqual(2);
    expect(await rowOf(key)).toBeNull();
    expect(await rowOf(tok?.key ?? "")).toBeNull();
  });

  it("the sweep keeps tombstones for TOMBSTONE_DAYS, then deletes them", async () => {
    const key = `grant:sweep-${tag}:g`;
    const now = nowS();
    await env.DB.prepare(
      "insert into oauth_kv (key, value, expires_at) values (?, '', ?)",
    )
      .bind(key, -(now - 3600))
      .run();
    const later = Date.now() + TOMBSTONE_DAYS * 86_400_000;
    await sweepOAuthStore(inMode("d1"), Date.now());
    expect(await rowOf(key)).not.toBeNull();
    // kv and dual: a tombstone keeps KV's copy dead, so it stays.
    for (const mode of ["kv", "dual"] as const) {
      await sweepOAuthStore(inMode(mode), later);
      expect(await rowOf(key)).not.toBeNull();
    }
    await sweepOAuthStore(inMode("d1"), later);
    expect(await rowOf(key)).toBeNull();
  });

  it("the nightly cron: the sweep stays in its slot, and the whole run's D1 queries are counted", async () => {
    // A backlog past one night's slot: expired rows only.
    const n = OAUTH_SWEEP_QUERIES * 1000 + 1;
    await env.DB.prepare(
      "insert into oauth_kv (key, value, expires_at) with recursive i(x) as (select 1 union all select x + 1 from i where x < ?) select ? || x, '', ? from i",
    )
      .bind(n, `token:nightly-${tag}:`, nowS() - 10)
      .run();
    const c = countingDb(env.DB);
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 429 }));
    try {
      await scheduled(
        {} as ScheduledController,
        inMode("d1", { DB: c.db }),
        ctx,
      );
      const settled = (await waits[0]) as PromiseSettledResult<unknown>[];
      expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    } finally {
      f.mockRestore();
    }
    expect(c.oauthKv().length).toBe(OAUTH_SWEEP_QUERIES);
    // Every nightly task's queries together, within D1's 50 per invocation.
    expect(c.sqls.length).toBeLessThanOrEqual(50);
    expect(c.sqls.length).toBe(NIGHTLY_QUERIES);
    const left = await env.DB.prepare(
      "select count(*) n from oauth_kv where key like ?",
    )
      .bind(`token:nightly-${tag}:%`)
      .first<{ n: number }>();
    expect(left?.n).toBe(1);
    await sweepOAuthStore(env, Date.now());
  });
});

// ------------------------------------------------------------ query budget

describe("D1 queries per invocation", () => {
  it("revoking 100 grants (2 tokens each) in one request stays within 50 queries (d1)", async () => {
    const user = `bulk-${tag}`;
    const seed = new D1KvStore(env.DB);
    const exp = nowS() + 3600;
    for (let i = 0; i < 100; i++) {
      const g = `g${String(i).padStart(3, "0")}`;
      await seed.put(
        `grant:${user}:${g}`,
        JSON.stringify({
          id: g,
          clientId: `c${i}`,
          userId: user,
          scope: [],
          metadata: { clientName: "x" },
          createdAt: 1,
        }),
        { metadata: { clientId: `c${i}` } },
      );
      for (const t of ["t1", "t2"])
        await seed.put(`token:${user}:${g}:${t}`, "{}", { expiration: exp });
    }
    const c = countingDb(env.DB);
    await revokeAllGrants(inMode("d1", { DB: c.db }) as never, user);
    // 2 snapshot reads (grants, tokens) and 2 batched tombstone writes.
    expect(c.sqls.length).toBeLessThanOrEqual(50);
    expect(c.sqls.length).toBe(4);
    const left = await env.DB.prepare(
      "select count(*) n from oauth_kv where (key like ? or key like ?) and (expires_at is null or expires_at > ?)",
    )
      .bind(`grant:${user}:%`, `token:${user}:%`, nowS())
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("one /mcp request: oauth_kv queries per mode", async () => {
    const counts: Record<string, [number, number]> = {};
    for (const mode of MODES) {
      const a = await connectAgent(inMode(mode));
      const c = countingDb(env.DB);
      const e = inMode(mode, { DB: c.db });
      // Warm: this isolate's markers for the mode are written once.
      expect((await mcp(e, a.access_token)).status).toBe(200);
      c.sqls.length = 0;
      expect((await mcp(e, a.access_token)).status).toBe(200);
      counts[mode] = [c.oauthKv().length, c.sqls.length];
    }
    // [oauth_kv queries, every D1 query] for a warm tools/list: the token
    // read is the only addition; the rest (the member lookup) is the same in
    // every mode.
    expect(counts).toEqual({ kv: [0, 1], dual: [1, 2], d1: [1, 2] });
  });
});

// ------------------------------------------------------------ d1 without KV

describe("d1 with no OAUTH_KV binding", () => {
  it("OAuth flows, /healthz and /oauth-clients work with OAUTH_KV deleted from env", async () => {
    const e = noKv();
    expect("OAUTH_KV" in e).toBe(false);
    const a = await connectAgent(e);
    expect((await mcp(e, a.access_token)).status).toBe(200);
    const r = await refresh(e, a.clientId, a.refresh_token);
    expect(r.status).toBe(200);
    const listed = await grants(e, a.member.cookie);
    expect(listed).toHaveLength(1);
    expect(
      (
        await appCall(
          e,
          R.oauthClient(listed[0]?.grantId ?? ""),
          a.member.cookie,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    const h = await callWorker(new Request(`${APP}/healthz`), e);
    expect(h.status).toBe(200);
    expect(((await h.json()) as { oauthStore: unknown }).oauthStore).toEqual({
      mode: "d1",
      backfilled: false,
      kvWritesOffSince: expect.any(Number),
    });
  });

  it("kv or dual with no binding fails clearly (503), never silently", async () => {
    for (const mode of ["kv", "dual"]) {
      const e = noKv({ OAUTH_STORE: mode });
      for (const path of ["/healthz", "/oauth/register"]) {
        const r = await callWorker(
          new Request(`${APP}${path}`, {
            method: path === "/healthz" ? "GET" : "POST",
          }),
          e,
        );
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({
          error: "oauth_store_misconfigured",
          message: `OAUTH_STORE=${mode} needs the OAUTH_KV binding`,
        });
      }
    }
  });

  it("an unknown OAUTH_STORE fails clearly (503)", async () => {
    const r = await callWorker(
      new Request(`${APP}/healthz`),
      inMode("D2" as never),
    );
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe(
      "oauth_store_misconfigured",
    );
  });
});

// ------------------------------------------------------------ /healthz

describe("/healthz oauthStore", () => {
  const health = async (e: unknown) => {
    const r = await callWorker(new Request(`${APP}/healthz`), e);
    expect(r.status).toBe(200);
    return ((await r.json()) as { oauthStore: Record<string, unknown> })
      .oauthStore;
  };
  it("kvWritesOffSince: stamped on the first d1 serve (never by /healthz), unchanged by later serves", async () => {
    expect(await health(inMode("dual"))).toEqual({
      mode: "dual",
      backfilled: expect.any(Boolean),
      kvWritesOffSince: null,
    });
    // /healthz in d1 mode reads only: one query, nothing stamped.
    const c = countingDb(env.DB);
    expect((await health(inMode("d1", { DB: c.db }))).kvWritesOffSince).toBe(
      null,
    );
    expect(c.sqls).toEqual([
      "select key, value from settings where key in (?, ?)",
    ]);
    expect(await offSince()).toBeNull();
    // The first d1 serve (any app-host request) stamps it.
    const before = Date.now();
    await robots(inMode("d1"));
    const t1 = Number(await offSince());
    expect(t1).toBeGreaterThanOrEqual(before);
    // Later serves (another isolate too) leave it.
    while (Date.now() <= t1) await Promise.resolve();
    resetOAuthStoreMarkers();
    await robots(inMode("d1"));
    expect((await health(inMode("d1"))).kvWritesOffSince).toBe(t1);
    expect(Number(await offSince())).toBe(t1);
  });

  it("kvWritesOffSince only ever moves earlier (two d1 isolates racing to stamp)", async () => {
    await robots(inMode("d1"));
    const t1 = Number(await offSince());
    while (Date.now() <= t1) await Promise.resolve();
    // An isolate whose marker read missed the first stamp writes a later one.
    const blind = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare")
          return (sql: string) =>
            /^select key, value from settings/.test(sql)
              ? t.prepare(`${sql} and 0`)
              : t.prepare(sql);
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await robots(inMode("d1", { DB: blind }));
    expect(Number(await offSince())).toBe(t1);
    // An earlier one wins.
    await env.DB.prepare("update settings set value = ? where key = ?")
      .bind(String(t1 + 5000), KV_WRITES_OFF_KEY)
      .run();
    resetOAuthStoreMarkers();
    await robots(inMode("d1", { DB: blind }));
    expect(Number(await offSince())).toBeLessThan(t1 + 5000);
  });

  it("/healthz with D1 down: oauthStore null, never a 500", async () => {
    const down = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare" || p === "batch")
          return () => {
            throw new Error("D1_ERROR: Network connection lost.");
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await callWorker(
      new Request(`${APP}/healthz`),
      inMode("d1", { DB: down }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; oauthStore: unknown };
    expect(body.ok).toBe(true);
    expect(body.oauthStore).toBeNull();
  });

  it("only mode, backfilled and kvWritesOffSince", async () => {
    expect(Object.keys(await health(inMode("d1")))).toEqual([
      "mode",
      "backfilled",
      "kvWritesOffSince",
    ]);
  });
});

// ------------------------------------------------------------ leaving d1

describe("leaving d1 is refused", () => {
  it("kv or dual after d1: 503 oauth_store_misconfigured, the stamp kept, unless OAUTH_STORE_ROLLBACK=1", async () => {
    const a = await connectAgent(inMode("d1"));
    const t1 = await offSince();
    expect(t1).not.toBeNull();
    for (const mode of ["kv", "dual"] as const) {
      resetOAuthStoreMarkers();
      for (const r of [
        await robots(inMode(mode)),
        await mcp(inMode(mode), a.access_token),
      ]) {
        expect(r.status).toBe(503);
        const body = (await r.json()) as { error: string; message: string };
        expect(body.error).toBe("oauth_store_misconfigured");
        expect(body.message).toMatch(
          new RegExp(
            `^OAUTH_STORE=${mode} is refused: .*OAUTH_STORE_ROLLBACK=1`,
          ),
        );
      }
      // The store's writes outside the serve path are refused too.
      await expect(
        oauthEnv(inMode(mode)).OAUTH_KV.put(`x:refused-${tag}`, "1"),
      ).rejects.toThrow(/is refused/);
      await expect(
        oauthEnv(inMode(mode)).OAUTH_KV.delete(`x:refused-${tag}`),
      ).rejects.toThrow(/is refused/);
      // Nothing of this mode cleared the stamp before the check.
      expect(await offSince()).toBe(t1);
      // /healthz still answers and shows it.
      const h = await callWorker(new Request(`${APP}/healthz`), inMode(mode));
      expect(h.status).toBe(200);
      expect(
        ((await h.json()) as { oauthStore: { kvWritesOffSince: number } })
          .oauthStore.kvWritesOffSince,
      ).toBe(Number(t1));
    }
    await expect(copyKvToD1(inMode("dual"))).rejects.toThrow(/is refused/);
    // The override (after KV's OAuth keys were emptied): serves, clears it.
    resetOAuthStoreMarkers();
    const r = await robots(inMode("dual", { OAUTH_STORE_ROLLBACK: "1" }));
    expect(r.status).toBe(200);
    expect(await offSince()).toBeNull();
    resetOAuthStoreMarkers();
    expect((await robots(inMode("kv"))).status).toBe(200);
  });
});

// ------------------------------------------------------------ copy

/** An in-memory KV with KV's list order, cursor, expiry and metadata. */
function memKv(now = () => nowS()) {
  const m = new Map<
    string,
    { v: string; expiration?: number; metadata?: unknown }
  >();
  const liveKeys = () =>
    [...m.entries()]
      .filter(([, x]) => x.expiration === undefined || x.expiration > now())
      .sort(([a], [b]) => keyCompare(a, b));
  return {
    m,
    async get(k: string) {
      const x = m.get(k);
      return x && (x.expiration === undefined || x.expiration > now())
        ? x.v
        : null;
    },
    async put(
      k: string,
      v: string,
      o: { expiration?: number; metadata?: unknown } = {},
    ) {
      m.set(k, { v, ...o });
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const all = liveKeys().filter(([k]) => k.startsWith(o.prefix ?? ""));
      const start = o.cursor ? Number(o.cursor) : 0;
      const lim = o.limit ?? 1000;
      const page = all.slice(start, start + lim).map(([name, x]) => ({
        name,
        ...(x.expiration !== undefined ? { expiration: x.expiration } : {}),
        ...(x.metadata !== undefined ? { metadata: x.metadata } : {}),
      }));
      const done = start + lim >= all.length;
      return done
        ? { keys: page, list_complete: true }
        : { keys: page, list_complete: false, cursor: String(start + lim) };
    },
  };
}

describe("copyKvToD1 (the backfill's core)", () => {
  it("copies with the original expiry and metadata, never overwrites D1, is idempotent, and records backfilled", async () => {
    await env.DB.prepare("delete from oauth_kv").run();
    await env.DB.prepare("delete from settings where key = ?")
      .bind(BACKFILLED_KEY)
      .run();
    const kv = memKv();
    const exp = nowS() + 3600;
    await kv.put("grant:u:a", "A", { metadata: { clientId: "c" } });
    await kv.put("token:u:a:b", "B", { expiration: exp });
    await kv.put("transaction:x", "X", { expiration: nowS() + 30 });
    await kv.put("client:d", "KV-OLD");
    await kv.put("grant:u:e", "E-REVOKED");
    // D1 already holds a newer d, and a tombstone for e (deleted in dual).
    const d1 = new D1KvStore(env.DB);
    await d1.put("client:d", "D1-NEW");
    await d1.put("grant:u:e", "E");
    await d1.delete("grant:u:e");
    await d1.flush();
    const e = inMode("dual", { OAUTH_KV: kv });
    expect(await copyKvToD1(e)).toEqual({
      kvKeys: 5,
      copied: 2,
      skippedExpiring: 1,
      d1Rows: 3,
      nextCursor: null,
    });
    expect(await rowOf("grant:u:a")).toMatchObject({
      value: "A",
      expires_at: null,
    });
    const meta = await env.DB.prepare(
      "select metadata from oauth_kv where key = 'grant:u:a'",
    ).first<{ metadata: string }>();
    expect(JSON.parse(meta?.metadata ?? "null")).toEqual({ clientId: "c" });
    expect(await rowOf("token:u:a:b")).toMatchObject({
      value: "B",
      expires_at: exp,
    });
    expect((await rowOf("client:d"))?.value).toBe("D1-NEW");
    const fresh = oauthEnv(e).OAUTH_KV;
    expect(await fresh.get("grant:u:e")).toBeNull();
    // Rerun: nothing new.
    expect(await copyKvToD1(e)).toMatchObject({ kvKeys: 5, copied: 0 });
    const h = await callWorker(new Request(`${APP}/healthz`), e);
    expect(((await h.json()) as { oauthStore: unknown }).oauthStore).toEqual({
      mode: "dual",
      backfilled: true,
      kvWritesOffSince: null,
    });
  });

  it("resumes by cursor within KV's and D1's per-invocation limits; backfilled only after the final page", async () => {
    await env.DB.prepare("delete from oauth_kv").run();
    await env.DB.prepare("delete from settings where key = ?")
      .bind(BACKFILLED_KEY)
      .run();
    const mem = memKv();
    const n = COPY_PAGE * 2 + 37;
    const exp = nowS() + 3600;
    for (let i = 0; i < n; i++)
      mem.m.set(`token:bf-${tag}:${String(i).padStart(5, "0")}`, {
        v: `v${i}`,
        expiration: exp,
      });
    let kvOps = 0;
    const kv = {
      get: (k: string) => {
        kvOps++;
        return mem.get(k);
      },
      list: (o: { limit?: number; cursor?: string }) => {
        kvOps++;
        return mem.list(o);
      },
    };
    const backfilled = async () =>
      (await env.DB.prepare("select 1 from settings where key = ?")
        .bind(BACKFILLED_KEY)
        .first()) !== null;
    let cursor: string | null = null;
    let calls = 0;
    let copied = 0;
    do {
      kvOps = 0;
      const c = countingDb(env.DB);
      const r = await copyKvToD1(inMode("dual", { OAUTH_KV: kv, DB: c.db }), {
        cursor,
      });
      calls++;
      copied += r.copied;
      expect(kvOps).toBeLessThanOrEqual(1000);
      expect(c.sqls.length).toBeLessThanOrEqual(50);
      expect(await backfilled()).toBe(r.nextCursor === null);
      expect(r.d1Rows === null).toBe(r.nextCursor !== null);
      cursor = r.nextCursor;
    } while (cursor);
    expect(calls).toBe(3);
    expect(copied).toBe(n);
    const count = await env.DB.prepare(
      "select count(*) n from oauth_kv where key like ?",
    )
      .bind(`token:bf-${tag}:%`)
      .first<{ n: number }>();
    expect(count?.n).toBe(n);
  });

  it("is refused outside dual mode", async () => {
    for (const mode of ["kv", "d1"] as const)
      await expect(copyKvToD1(inMode(mode))).rejects.toThrow(
        /only with OAUTH_STORE=dual/,
      );
  });

  it("kv mode: a put drops D1's row, a delete tombstones only a row D1 holds, backfilled is cleared; no bulk wipe", async () => {
    const p = `grant:kvm-${tag}:`;
    const d1 = new D1KvStore(env.DB);
    // Rows from an earlier dual run, and one kv never touches.
    await d1.put(`${p}a`, "OLD");
    await d1.put(`${p}b`, "B");
    await d1.put(`${p}keep`, "K");
    await env.DB.prepare(
      "insert into settings (key, value) values (?, '1') on conflict(key) do nothing",
    )
      .bind(BACKFILLED_KEY)
      .run();
    const c = countingDb(env.DB);
    const s = oauthEnv(inMode("kv", { DB: c.db })).OAUTH_KV;
    await s.put(`${p}a`, "NEW");
    expect(await rowOf(`${p}a`)).toBeNull();
    expect(await env.OAUTH_KV.get(`${p}a`)).toBe("NEW");
    await Promise.all([s.delete(`${p}b`), s.delete(`${p}none`)]);
    expect((await rowOf(`${p}b`))?.expires_at).toBeLessThan(0);
    expect(await rowOf(`${p}none`)).toBeNull();
    expect((await rowOf(`${p}keep`))?.value).toBe("K");
    // The marker read, the backfilled clear, one drop, one batched tombstone.
    expect(c.sqls.length).toBe(4);
    const h = await callWorker(new Request(`${APP}/healthz`), inMode("dual"));
    expect(
      ((await h.json()) as { oauthStore: { backfilled: boolean } }).oauthStore
        .backfilled,
    ).toBe(false);
    // dual reads KV's value (no stale D1 row), and b stays dead.
    const dual = oauthEnv(inMode("dual")).OAUTH_KV;
    expect(await dual.get(`${p}a`)).toBe("NEW");
    expect(await dual.get(`${p}b`)).toBeNull();
    await env.OAUTH_KV.delete(`${p}a`);
  });
});

// ------------------------------------------------------------ store unit

describe("D1KvStore matches KV", () => {
  it("list order, prefix bounds, limit, cursor and metadata match Workers KV", async () => {
    const p = `ls-${tag}`;
    const keys = [
      `grant:${p}:b`,
      `grant:${p}:a`,
      `grant:${p}:a:nested`,
      `grant:${p}2:z`,
      `grant:${p}:c~`,
      `grant:${p}:C`,
      `grant:${p}:é`,
      `grant:${p}:｡`,
    ];
    const d1 = new D1KvStore(env.DB);
    for (const [i, k] of keys.entries()) {
      const opt = {
        ...(i % 2 ? { metadata: { i } } : {}),
        ...(i % 3 ? { expiration: nowS() + 7200 + i } : {}),
      };
      await d1.put(k, `v${i}`, opt);
      await env.OAUTH_KV.put(k, `v${i}`, opt);
    }
    const walk = async (kv: KVNamespace, limit: number) => {
      const pages: unknown[] = [];
      let cursor: string | undefined;
      do {
        const r = await kv.list({ prefix: `grant:${p}:`, limit, cursor });
        pages.push({ keys: r.keys, complete: r.list_complete });
        cursor = r.list_complete ? undefined : r.cursor;
      } while (cursor);
      return pages;
    };
    for (const limit of [1, 3, 1000]) {
      // A fresh store each time: no cache between pages.
      const ours = await walk(
        new D1KvStore(env.DB) as unknown as KVNamespace,
        limit,
      );
      expect(ours).toEqual(await walk(env.OAUTH_KV, limit));
    }
    for (const k of keys) await env.OAUTH_KV.delete(k);
  });

  it("get text and json; put expirationTtl and expiration; delete; a past expiry reads as missing", async () => {
    const s = new D1KvStore(env.DB);
    const k = `x:${tag}:get`;
    await s.put(k, JSON.stringify({ a: 1 }), { expirationTtl: 120 });
    expect(await s.get(k)).toBe('{"a":1}');
    expect(await s.get(k, "json")).toEqual({ a: 1 });
    expect(await s.get(k, { type: "json" })).toEqual({ a: 1 });
    const row = await rowOf(k);
    expect(row?.expires_at).toBeGreaterThanOrEqual(nowS() + 119);
    await s.put(k, "v2", { expiration: nowS() - 1 });
    expect(await new D1KvStore(env.DB).get(k)).toBeNull();
    expect(
      (await new D1KvStore(env.DB).list({ prefix: `x:${tag}:` })).keys,
    ).toEqual([]);
    await s.put(k, "v3");
    await s.delete(k);
    expect(await s.get(k)).toBeNull();
    expect(await new D1KvStore(env.DB).get(k)).toBeNull();
  });

  it("a list then put/delete in one request reads its own writes", async () => {
    const s = new D1KvStore(env.DB);
    const p = `own-${tag}:u:`;
    await s.put(`${p}a`, "1");
    expect((await s.list({ prefix: p })).keys.map((k) => k.name)).toEqual([
      `${p}a`,
    ]);
    await s.put(`${p}b`, "2");
    await s.delete(`${p}a`);
    expect((await s.list({ prefix: p })).keys.map((k) => k.name)).toEqual([
      `${p}b`,
    ]);
    expect(await s.get(`${p}a`)).toBeNull();
  });

  it("a stale snapshot is never used (a newer one, or the one just loaded)", async () => {
    const p = `snap-${tag}:u:`;
    const names = (r: { keys: { name: string }[] }) =>
      r.keys.map((k) => k.name);
    await new D1KvStore(env.DB).put(`${p}a`, "1");
    const s = new D1KvStore(env.DB);
    expect(names(await s.list({ prefix: p }))).toEqual([`${p}a`]);
    // Another isolate writes b after this store's snapshot.
    await new D1KvStore(env.DB).put(`${p}b`, "2");
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => t0 + 6_000);
    try {
      expect(names(await s.list({ prefix: p }))).toEqual([`${p}a`, `${p}b`]);
      expect(await s.get(`${p}b`)).toBe("2");
      // Still within the new snapshot's window: it answers, not the old one.
      expect(names(await s.list({ prefix: p, limit: 1 }))).toEqual([`${p}a`]);
      expect(await s.get(`${p}b`)).toBe("2");
    } finally {
      clock.mockRestore();
    }
  });

  it("keyCompare is UTF-8 byte order (code points), not UTF-16", () => {
    const astral = "\u{1F600}";
    const highBmp = "｡";
    expect(keyCompare(astral, highBmp)).toBeGreaterThan(0);
    expect(highBmp < astral).toBe(false);
    expect(keyCompare("a", "ab")).toBeLessThan(0);
    expect(keyCompare("b", "ab")).toBeGreaterThan(0);
  });

  it("D1 overload or busy maps to the KV 429 the library retries; other errors pass through", async () => {
    const overloaded = new Error(
      "D1_ERROR: D1 DB is overloaded. Too many requests queued.",
    );
    const busyDb = {
      prepare: () => ({
        bind: () => ({
          first: () => Promise.reject(overloaded),
        }),
      }),
    } as unknown as D1Database;
    await expect(new D1KvStore(busyDb).get("k")).rejects.toThrow(
      /429 Too Many Requests/,
    );
    const other = new Error("D1_ERROR: no such table: oauth_kv");
    expect(mapStoreError(other)).toBe(other);
    // The per-invocation limit is this request's own: not retryable.
    const perInvocation = new Error(
      "D1_ERROR: Too many API requests by single Worker invocation.",
    );
    expect(mapStoreError(perInvocation)).toBe(perInvocation);
    const tooMany = new Error("Too many requests");
    expect(mapStoreError(tooMany)).toBe(tooMany);
    expect(String(mapStoreError(new Error("SQLITE_BUSY")))).toMatch(
      /429 Too Many Requests/,
    );
  });

  it("the cursor is opaque base64url of the last key", async () => {
    const s = new D1KvStore(env.DB);
    const p = `cur-${tag}:u:`;
    await s.put(`${p}1`, "1");
    await s.put(`${p}2`, "2");
    const r = await new D1KvStore(env.DB).list({ prefix: p, limit: 1 });
    expect(r.list_complete).toBe(false);
    const cursor = (r as { cursor: string }).cursor;
    expect(cursor).toBe(b64url(new TextEncoder().encode(`${p}1`)));
    await expect(
      new D1KvStore(env.DB).list({ prefix: p, cursor: "%%%" }),
    ).rejects.toThrow(/invalid list cursor/);
  });
});
