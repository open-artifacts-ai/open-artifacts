import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { removeMember, SYSTEM_ACTOR } from "../src/services/members.js";
import { login } from "./helpers.js";
import {
  APP,
  callWorker,
  connect,
  E,
  limiter,
  nextIp,
  tool,
} from "./mcp-helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const CONTENT = "https://content.localhost";
const REDIRECT = "http://localhost:3333/cb";

const req = (
  path: string,
  o: {
    method?: string;
    cookie?: string;
    bearer?: string;
    body?: unknown;
    ip?: string;
    headers?: Record<string, string>;
    host?: string;
  } = {},
) => {
  const h: Record<string, string> = { "x-oa-request": "1", ...o.headers };
  if (o.cookie) h.cookie = o.cookie;
  if (o.bearer) h.authorization = `Bearer ${o.bearer}`;
  if (o.ip) h["cf-connecting-ip"] = o.ip;
  if (o.body !== undefined) h["content-type"] = "application/json";
  return new Request(`${o.host ?? APP}${path}`, {
    method: o.method ?? "GET",
    headers: h,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
};
const w = (r: Request, e?: unknown) => callWorker(r, e);

async function create(cookie: string, extra: Record<string, unknown>) {
  const r = await w(
    req(R.artifacts, {
      method: "POST",
      cookie,
      body: { title: "t", format: "html", content: "<p>x</p>", ...extra },
    }),
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Register + consent: a code ready for the token exchange. */
async function authorize(email: string, e?: unknown, basic = false) {
  const m = await login(email);
  const reg = await w(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({
        client_name: "Adv",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: basic ? "client_secret_basic" : "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    e,
  );
  const { client_id: clientId, client_secret: clientSecret } =
    (await reg.json()) as { client_id: string; client_secret?: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const url = `${APP}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    resource: `${APP}/mcp`,
  })}`;
  const page = await w(new Request(url, { headers: { cookie: m.cookie } }), e);
  const body = await page.text();
  const f = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(body)?.[1] ?? "";
  const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]);
  const form = new URLSearchParams({
    csrf: f("csrf"),
    request: f("request"),
    decision: "approve",
  }).toString();
  const d = await w(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie: [m.cookie, ...cookies].join("; "),
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(form.length),
      },
      body: form,
    }),
    e,
  );
  const code =
    new URL(d.headers.get("location") ?? "").searchParams.get("code") ?? "";
  return { m, clientId, clientSecret, code, verifier };
}

type Authorized = Awaited<ReturnType<typeof authorize>>;

/** The code exchange, from `ip` (a fresh one by default); Basic auth when the client has a secret. */
const exchange = (a: Authorized, e?: unknown, ip = nextIp()) =>
  w(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
        ...(a.clientSecret
          ? {
              authorization: `Basic ${btoa(`${a.clientId}:${a.clientSecret}`)}`,
            }
          : {}),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: REDIRECT,
        ...(a.clientSecret ? {} : { client_id: a.clientId }),
        code_verifier: a.verifier,
        resource: `${APP}/mcp`,
      }).toString(),
    }),
    e,
  );

async function oauth(email: string, e?: unknown) {
  const a = await authorize(email, e);
  const t = await exchange(a, e);
  expect(t.status).toBe(200);
  const j = (await t.json()) as { access_token: string; refresh_token: string };
  return { m: a.m, clientId: a.clientId, ...j };
}

/** The socket's close code: no timer; the 20 s testTimeout bounds the wait. */
const closeCode = (ws: WebSocket) =>
  new Promise<number>((res) => {
    ws.addEventListener("close", (e) => res((e as CloseEvent).code));
  });

describe("M2 whole-track adversarial", () => {
  it("F1 publish with a visibility change closes live sockets (as patch does)", async () => {
    const owner = await login(`o1-${tag}@x.com`);
    const viewer = await login(`v1-${tag}@x.com`);
    const id = await create(owner.cookie, {
      visibility: "team",
      capabilities: { db: true },
    });
    const up = await w(
      req(`${R.dataSubscribe(id, "c")}`, {
        cookie: viewer.cookie,
        headers: { upgrade: "websocket" },
      }),
    );
    const ws = up.webSocket;
    if (!ws) throw new Error(`no ws ${up.status}`);
    ws.accept();
    const closed = closeCode(ws);
    const v = await w(
      req(`/api/v1/artifacts/${id}/versions`, {
        method: "POST",
        cookie: owner.cookie,
        body: { format: "html", content: "<p>y</p>", visibility: "private" },
      }),
    );
    expect(v.status).toBe(201);
    // viewer has lost access (REST)…
    expect(
      (await w(req(R.dataCollection(id, "c"), { cookie: viewer.cookie })))
        .status,
    ).toBe(404);
    // …and the live feed is cut.
    expect(await closed).toBe(4403);
  });

  it('F2 anonymous writer\'s IP is never returned to other viewers (updatedBy "anon:<anonId>")', async () => {
    const owner = await login(`o2-${tag}@x.com`);
    const id = await create(owner.cookie, {
      visibility: "public",
      capabilities: { db: true },
      allowAnonymousWrites: true,
    });
    const put = await w(
      req(R.dataDoc(id, "c", "d1"), {
        method: "PUT",
        body: { v: 1 },
        ip: "203.0.113.77",
      }),
    );
    expect(put.status).toBe(200);
    const list = await (
      await w(req(R.dataCollection(id, "c"), { ip: "198.51.100.1" }))
    ).text();
    expect(list).not.toContain("203.0.113.77");
    // "anon:<short>": the signed anonId, never derived from the IP.
    expect(JSON.parse(list).items[0].updatedBy).toMatch(
      /^anon:[A-Za-z0-9_-]{8}$/,
    );
  });

  it("F3 refresh_token storms are rate-limited per client_id", async () => {
    let puts = 0;
    const kv = env.OAUTH_KV;
    const counting = new Proxy(kv, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "put")
          return (...a: unknown[]) => {
            puts++;
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const e = E({ OAUTH_KV: counting, RL_ANON: limiter().RL_ANON });
    const o = await oauth(`o3-${tag}@x.com`, e);
    let rt = o.refresh_token;
    puts = 0;
    let ok = 0;
    let limited: Response | null = null;
    for (let i = 0; i < 30; i++) {
      const r = await w(
        new Request(`${APP}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: rt,
            client_id: o.clientId,
          }).toString(),
        }),
        e,
      );
      if (r.status === 200) {
        ok++;
        rt = ((await r.json()) as { refresh_token: string }).refresh_token;
      } else limited ??= r;
    }
    // 1000 KV writes/day on Free: RL_ANON `tok:<client_id>` (30/min, incl. the code exchange).
    expect(ok).toBeLessThan(30);
    expect(limited?.status).toBe(429);
    expect(await limited?.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    expect(puts).toBeLessThanOrEqual(2 * ok);
  });

  const token = (params: Record<string, string>, ip: string, e: unknown) =>
    w(
      new Request(`${APP}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": ip,
        },
        body: new URLSearchParams(params).toString(),
      }),
      e,
    );

  it("F3d requests naming a client_id without valid credentials cannot drain that client's bucket (#149)", async () => {
    const o = await oauth(`o3d-${tag}@x.com`);
    const l = limiter(3);
    const e = E({ RL_ANON: l.RL_ANON });
    for (let i = 0; i < 6; i++) {
      const bogus = await token(
        {
          grant_type: "refresh_token",
          client_id: o.clientId,
          ...(i % 2 ? { refresh_token: `${o.m.userId}:nope:${i}` } : {}),
        },
        `198.51.100.${i + 1}`,
        e,
      );
      expect(bogus.status).not.toBe(200);
    }
    expect(l.counts.has(`tok:${o.clientId}`)).toBe(false);
    const ok = await token(
      {
        grant_type: "refresh_token",
        refresh_token: o.refresh_token,
        client_id: o.clientId,
      },
      "192.0.2.10",
      e,
    );
    expect(ok.status).toBe(200);
    expect(l.counts.get(`tok:${o.clientId}`)).toBe(1);
  });

  it("F3e every token request is rate-limited per IP before the provider, valid ones too", async () => {
    const o = await oauth(`o3e-${tag}@x.com`);
    const l = limiter(3);
    const e = E({ RL_ANON: l.RL_ANON });
    const fail = (ip: string) =>
      token(
        {
          grant_type: "refresh_token",
          client_id: o.clientId,
          refresh_token: "x:y:z",
        },
        ip,
        e,
      );
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await fail("203.0.113.9")).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses.slice(3)).toEqual([429, 429]);
    // Another IP is unaffected; the limited IP is limited even when valid.
    expect((await fail("203.0.113.10")).status).not.toBe(429);
    const valid = (ip: string) =>
      token(
        {
          grant_type: "refresh_token",
          refresh_token: o.refresh_token,
          client_id: o.clientId,
        },
        ip,
        e,
      );
    expect((await valid("203.0.113.9")).status).toBe(429);
    expect((await valid("203.0.113.11")).status).toBe(200);
  });

  it("F3f a valid client is limited at its own threshold, before the refresh rotates", async () => {
    const o = await oauth(`o3f-${tag}@x.com`);
    const l = limiter(2);
    const e = E({ RL_ANON: l.RL_ANON });
    const refresh = (rt: string) =>
      token(
        {
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id: o.clientId,
        },
        nextIp(),
        e,
      );
    const r1 = await refresh(o.refresh_token);
    expect(r1.status).toBe(200);
    const rt1 = ((await r1.json()) as { refresh_token: string }).refresh_token;
    const r2 = await refresh(rt1);
    expect(r2.status).toBe(200);
    const rt2 = ((await r2.json()) as { refresh_token: string }).refresh_token;
    const limited = await refresh(rt2);
    expect(limited.status).toBe(429);
    expect(l.counts.get(`tok:${o.clientId}`)).toBe(3);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    // rt1 is still the grant's previous token only if the limited refresh did
    // not rotate it (a rotation would make rt2 the previous one).
    l.counts.clear();
    expect((await refresh(rt1)).status).toBe(200);
  });

  it("F3g a code exchange over the client's limit is 429 and leaves the code usable", async () => {
    const l = limiter(30);
    const e = E({ RL_ANON: l.RL_ANON });
    const a = await authorize(`o3g-${tag}@x.com`, e);
    l.counts.set(`tok:${a.clientId}`, 30);
    expect((await exchange(a, e)).status).toBe(429);
    l.counts.delete(`tok:${a.clientId}`);
    expect((await exchange(a, e)).status).toBe(200);
  });

  it("F3h a Basic-auth client is limited on its authenticated client_id only", async () => {
    const l = limiter(30);
    const e = E({ RL_ANON: l.RL_ANON });
    const a = await authorize(`o3h-${tag}@x.com`, e, true);
    expect(a.clientSecret).toBeTruthy();
    const forged = await exchange({ ...a, clientSecret: "wrong" }, e);
    expect(forged.status).toBe(401);
    expect(l.counts.has(`tok:${a.clientId}`)).toBe(false);
    expect((await exchange(a, e)).status).toBe(200);
    expect(l.counts.get(`tok:${a.clientId}`)).toBe(1);
  });

  it("F3i revocation (token, no grant_type) is rate-limited per IP", async () => {
    const o = await oauth(`o3i-${tag}@x.com`);
    const l = limiter(3);
    const e = E({ RL_ANON: l.RL_ANON });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push(
        (
          await token(
            { token: `x:y:${i}`, client_id: o.clientId },
            "203.0.113.30",
            e,
          )
        ).status,
      );
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it("F3k a streamed token body under 16 KB without content-length reaches the provider", async () => {
    const o = await oauth(`o3k-${tag}@x.com`);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: o.refresh_token,
      client_id: o.clientId,
    }).toString();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    });
    const r = new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(r.headers.get("content-length")).toBeNull();
    const res = await w(r, E({ RL_ANON: limiter().RL_ANON }));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("refresh_token");
  });

  it("F3j token bodies over 16 KB → 413, with or without content-length", async () => {
    const big = `grant_type=refresh_token&pad=${"x".repeat(17 * 1024)}`;
    const declared = await w(
      new Request(`${APP}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(big.length),
          "cf-connecting-ip": nextIp(),
        },
        body: big,
      }),
    );
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const streamed = new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await w(streamed)).status).toBe(413);
  });

  it("F3b access tokens live 24 h", async () => {
    const o = (await oauth(`o3b-${tag}@x.com`)) as unknown as {
      expires_in: number;
    };
    expect(o.expires_in).toBe(86_400);
  });

  it("F3c consent page renders are rate-limited per user", async () => {
    const m = await login(`o3c-${tag}@x.com`);
    let n = 0;
    const e = E({
      RL_ANON: {
        async limit({ key }: { key: string }) {
          if (key === `consent:u:${m.userId}`) n++;
          return { success: !key.startsWith("consent:") || n <= 2 };
        },
      },
    });
    const get = () =>
      w(
        new Request(`${APP}/oauth/authorize?client_id=x`, {
          headers: { cookie: m.cookie },
        }),
        e,
      );
    expect((await get()).status).not.toBe(429);
    expect((await get()).status).not.toBe(429);
    expect((await get()).status).toBe(429);
  });

  it("F4 rejected registrations past the daily cap write nothing to D1", async () => {
    // The seed's day and the server's own Date.now() must agree.
    const day = new Date(pinMiddayUtc()).toISOString().slice(0, 10);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await env.DB.prepare(
      "insert into counters (key,n,day) values ('oauth_register',200,?) on conflict(key) do update set n=200, day=excluded.day",
    )
      .bind(day)
      .run();
    for (let i = 0; i < 3; i++) {
      const r = await w(
        new Request(`${APP}/oauth/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": nextIp(),
          },
          body: JSON.stringify({ client_name: "x", redirect_uris: [REDIRECT] }),
        }),
      );
      expect(r.status).toBe(429);
    }
    const n = await env.DB.prepare(
      "select n from counters where key='oauth_register'",
    ).first<{ n: number }>();
    await env.DB.prepare(
      "update counters set n=0 where key='oauth_register'",
    ).run();
    expect(n?.n).toBe(200);
  });

  it("F5 MCP data tools follow REST (viewer write; owner exempt from capability)", async () => {
    const owner = await login(`o5-${tag}@x.com`);
    const sv = await login(`sv5-${tag}@x.com`);
    const id = await create(owner.cookie, { capabilities: { db: true } });
    await w(
      req(`/api/v1/artifacts/${id}/shares`, {
        method: "PUT",
        cookie: owner.cookie,
        body: { email: `sv5-${tag}@x.com`, role: "viewer" },
      }),
    );
    const rest = await w(
      req(R.dataDoc(id, "c", "a"), {
        method: "PUT",
        cookie: sv.cookie,
        body: { a: 1 },
      }),
    );
    const { token } = await createPat(env, sv.userId, "agent");
    const c = await connect(token);
    const mcp = await tool(c, "artifact_data_set", {
      id,
      collection: "c",
      docId: "a",
      data: { a: 2 },
    });
    // owner, no db capability: REST 403; MCP lets the uncapped owner seed (B14, narrowed)
    const id2 = await create(owner.cookie, {});
    const rest2 = await w(
      req(R.dataDoc(id2, "c", "a"), {
        method: "PUT",
        cookie: owner.cookie,
        body: {},
      }),
    );
    const { token: ot } = await createPat(env, owner.userId, "agent");
    const mcp2 = await tool(await connect(ot), "artifact_data_set", {
      id: id2,
      collection: "c",
      docId: "a",
      data: {},
    });
    expect({
      rest: rest.status,
      mcpErr: !!mcp.isError,
      rest2: rest2.status,
      mcp2Err: !!mcp2.isError,
    }).toEqual({
      rest: 200,
      mcpErr: false,
      rest2: 403,
      mcp2Err: false,
    });
    // MCP writes as the user (shares the REST rate bucket), not as "agent:".
    expect(String(mcp.structuredContent?.updatedBy)).toBe(`u:${sv.userId}`);
  });

  it("F6 an anonymous data write writes ≤3 rows (DO Free: 100k rows/day)", async () => {
    const owner = await login(`o6-${tag}@x.com`);
    const id = await create(owner.cookie, {
      visibility: "public",
      capabilities: { db: true },
      allowAnonymousWrites: true,
    });
    await w(
      req(R.dataDoc(id, "c", "warm"), {
        method: "PUT",
        body: 1,
        ip: "203.0.113.90",
      }),
    );
    let written = 0;
    await runInDurableObject(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (inst, state) => {
        const sql = state.storage.sql;
        const orig = sql.exec.bind(sql);
        (sql as { exec: unknown }).exec = (...a: Parameters<typeof orig>) => {
          const cur = orig(...a);
          const arr = cur.toArray();
          written += cur.rowsWritten;
          return Object.assign(arr[Symbol.iterator](), {
            toArray: () => arr,
            one: () => arr[0],
            rowsWritten: cur.rowsWritten,
          });
        };
        inst.setRaw(
          "c",
          "d",
          new TextEncoder().encode('{"v":2}'),
          "ip:203.0.113.90",
        );
      },
    );
    expect(written).toBeLessThanOrEqual(3);
  });

  describe("required probes (expected to hold)", () => {
    it("(a) bearer routing", async () => {
      const m = await login(`a-${tag}@x.com`);
      const rpc = (auth: Record<string, string>, path = "/mcp") =>
        w(
          new Request(`${APP}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...auth,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
            }),
          }),
        );
      expect((await rpc({ authorization: "Bearer notapat" })).status).toBe(401);
      expect((await rpc({ authorization: "Bearer oa_pat_" })).status).toBe(401);
      expect((await rpc({ cookie: m.cookie })).status).toBe(401);
      const { token } = await createPat(env, m.userId, "x");
      expect(
        (await rpc({ authorization: `Bearer ${token}` }, "/mcp/")).status,
      ).toBe(401);
      const o = await oauth(`a2-${tag}@x.com`);
      expect(
        (
          await w(
            req("/api/v1/me", { bearer: o.access_token, cookie: o.m.cookie }),
          )
        ).status,
      ).toBe(401);
      await login(`owner@example.com`, "owner").catch(() => {});
      await removeMember(env, o.m.userId, SYSTEM_ACTOR);
      expect(
        (await rpc({ authorization: `Bearer ${o.access_token}` })).status,
      ).toBe(401);
      await removeMember(env, m.userId, SYSTEM_ACTOR);
      expect((await rpc({ authorization: `Bearer ${token}` })).status).toBe(
        401,
      );
    });

    it("(b) guest at consent → 403", async () => {
      const g = await login(`g-${tag}@x.com`, "guest");
      const r = await w(
        new Request(`${APP}/oauth/authorize?client_id=x`, {
          headers: { cookie: g.cookie },
        }),
      );
      expect(r.status).toBe(403);
    });

    it("(d) public→private: /p/, OG, thumbnail, cross-id data", async () => {
      const owner = await login(`d-${tag}@x.com`);
      const id = await create(owner.cookie, {
        visibility: "public",
        title: "Secret plan",
      });
      expect(
        (await w(req(`/p/${id}/v1/__view`, { host: CONTENT }))).status,
      ).toBe(200);
      await w(
        req(`/api/v1/artifacts/${id}`, {
          method: "PATCH",
          cookie: owner.cookie,
          body: { visibility: "private" },
        }),
      );
      expect(
        (await w(req(`/p/${id}/v1/__view`, { host: CONTENT }))).status,
      ).toBe(404);
      expect(
        (await w(req(`/p/${id}/v1/index.html`, { host: CONTENT }))).status,
      ).toBe(404);
      const og = await w(req(`/a/${id}`));
      if (og.status === 200)
        expect(await og.text()).not.toContain("Secret plan");
      expect((await w(req(`/api/v1/artifacts/${id}/thumbnail`))).status).toBe(
        404,
      );
      const other = await login(`d2-${tag}@x.com`);
      expect(
        (await w(req(R.dataCollection(id, "c"), { cookie: other.cookie })))
          .status,
      ).toBe(404);
    });
  });
});
