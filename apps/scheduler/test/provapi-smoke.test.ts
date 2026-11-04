import { describe, expect, it } from "vitest";
import {
  SMOKE_BUS_SKIPPED,
  SMOKE_TITLE_PREFIX,
  type SmokeFetch,
  type SmokeInput,
  smoke,
} from "../src/provapi/smoke.js";

// #1343: the canary smoke against a fake canary. Every route the smoke calls
// is implemented here as the server answers it; a fault replaces one answer.

const HOST = "canary.example.test";
const ID = "icanary00001";
const BROKER = "https://auth.example.test";
const TOKEN = "oat_smoke_secret_never_logged";
const SHARE_TO = "smoke-b@example.test";
const ME = { id: "u-a", email: "smoke-a@example.test", role: "member" };
const VERSION = "0.93.0";
const NONCE = "n0nce";
const TITLE = `${SMOKE_TITLE_PREFIX}0_93_0-${NONCE}`;

type Fault = (
  path: string,
  method: string,
) => Response | "throw" | "hang" | null;

interface Art {
  id: string;
  title: string;
  owner: string;
  content: string;
  shares: string[];
  deleted: boolean;
}

function canary(o: { fault?: Fault; arts?: Art[]; me?: object } = {}) {
  const arts: Art[] = o.arts ?? [];
  const calls: { method: string; path: string; auth: boolean }[] = [];
  let n = 0;
  const fetch: SmokeFetch = async (url, init) => {
    const u = new URL(url);
    expect(u.host).toBe(HOST);
    const method = init.method ?? "GET";
    const path = `${u.pathname}${u.search}`;
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, path, auth: auth !== null });
    expect(init.redirect).toBe("manual");
    const f = o.fault?.(u.pathname, method) ?? null;
    if (f === "throw") throw new Error("network");
    if (f === "hang") return new Promise<Response>(() => {});
    if (f) return f;
    const authed = auth === `Bearer ${TOKEN}`;
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const p = u.pathname;
    if (p === "/auth/providers")
      return json({
        mode: "google",
        providers: [{ id: "google", start: "/auth/login/google" }],
      });
    if (p === "/auth/login/google")
      return new Response(null, {
        status: 302,
        headers: {
          location: `${BROKER}/google/authorize?install=${ID}&state=s&nonce=n&code_challenge=c`,
        },
      });
    if (!authed) return json({ error: "unauthorized" }, 401);
    if (p === "/api/v1/me") return json({ user: o.me ?? ME });
    if (p === "/api/v1/artifacts" && method === "GET")
      return json({
        items: arts
          .filter((a) => !a.deleted)
          .map((a) => ({ id: a.id, title: a.title, owner: { id: a.owner } })),
        nextCursor: null,
      });
    if (p === "/api/v1/artifacts" && method === "POST") {
      const b = JSON.parse(String(init.body));
      expect(b.visibility).toBe("private");
      const a: Art = {
        id: `a${++n}`,
        title: b.title,
        owner: ME.id,
        content: b.content,
        shares: [],
        deleted: false,
      };
      arts.push(a);
      return json(
        { id: a.id, version: 1, url: `https://${HOST}/a/${a.id}` },
        201,
      );
    }
    const m = /^\/api\/v1\/artifacts\/([^/]+)(\/.*)?$/.exec(p);
    const a = arts.find((x) => x.id === m?.[1] && !x.deleted);
    if (!m || !a) return json({ error: "not_found" }, 404);
    const rest = m[2] ?? "";
    if (rest === "" && method === "DELETE") {
      a.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (rest === "/versions") return json([{ version: 1, entry: "index.md" }]);
    if (rest === "/versions/1/files/index.md") return new Response(a.content);
    if (rest === "/shares" && method === "PUT") {
      const b = JSON.parse(String(init.body));
      a.shares.push(b.email);
      return json({ email: b.email, role: b.role, emailed: false });
    }
    if (rest === "/shares") return json(a.shares.map((email) => ({ email })));
    if (rest.startsWith("/shares/") && method === "DELETE") {
      const e = decodeURIComponent(rest.slice(8));
      a.shares = a.shares.filter((x) => x !== e);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, 404);
  };
  const mcpFetch: SmokeFetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname !== "/mcp") return fetch(url, init);
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: "/mcp",
      auth: new Headers(init.headers).has("authorization"),
    });
    const f = o.fault?.("/mcp", method) ?? null;
    if (f === "throw") throw new Error("network");
    if (f === "hang") return new Promise<Response>(() => {});
    if (f) return f;
    const rpc = JSON.parse(String(init.body));
    const reply = (result: unknown) =>
      new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    if (rpc.method === "tools/list")
      return reply({
        tools: [{ name: "publish_artifact" }, { name: "get_artifact" }],
      });
    if (rpc.method === "tools/call") {
      const a = arts.find(
        (x) => x.id === rpc.params.arguments.id && !x.deleted,
      );
      return reply({ structuredContent: { id: a?.id, title: a?.title } });
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -1 } });
  };
  return { fetch: mcpFetch, calls, arts };
}

const input = (
  c: ReturnType<typeof canary>,
  over: Partial<SmokeInput> = {},
): SmokeInput => ({
  fetch: c.fetch,
  installId: ID,
  appHost: HOST,
  token: TOKEN,
  shareTo: SHARE_TO,
  brokerOrigin: BROKER,
  version: VERSION,
  nonce: () => NONCE,
  callMs: 200,
  budgetMs: 5_000,
  ...over,
});
const live = (c: ReturnType<typeof canary>) => c.arts.filter((a) => !a.deleted);

describe("the canary smoke", () => {
  it("passes every check, cleans up, and notes the bus skip", async () => {
    const c = canary();
    expect(await smoke(input(c))).toEqual({
      ok: true,
      notes: [SMOKE_BUS_SKIPPED],
    });
    expect(live(c)).toEqual([]);
    expect(c.arts.map((a) => a.title)).toEqual([TITLE]);
    expect(c.arts[0]?.shares).toEqual([]);
    expect(c.calls.map((x) => `${x.method} ${x.path.split("?")[0]}`)).toEqual([
      "GET /api/v1/me",
      "GET /auth/providers",
      "GET /auth/login/google",
      "GET /api/v1/artifacts",
      "POST /api/v1/artifacts",
      "GET /api/v1/artifacts/a1/versions",
      "GET /api/v1/artifacts/a1/versions/1/files/index.md",
      "PUT /api/v1/artifacts/a1/shares",
      "GET /api/v1/artifacts/a1/shares",
      `DELETE /api/v1/artifacts/a1/shares/${encodeURIComponent(SHARE_TO)}`,
      "POST /mcp",
      "POST /mcp",
      "DELETE /api/v1/artifacts/a1",
    ]);
    // The public sign-in routes go without the token.
    for (const x of c.calls)
      expect(x.auth, x.path).toBe(!x.path.startsWith("/auth/"));
  });

  it("sweeps only smoke-a's own fleet-smoke-* leftovers", async () => {
    const c = canary({
      arts: [
        {
          id: "old",
          title: `${SMOKE_TITLE_PREFIX}0_92_0-x`,
          owner: ME.id,
          content: "",
          shares: [],
          deleted: false,
        },
        {
          id: "mine-other",
          title: "notes",
          owner: ME.id,
          content: "",
          shares: [],
          deleted: false,
        },
        {
          id: "someone-else",
          title: `${SMOKE_TITLE_PREFIX}team`,
          owner: "u-other",
          content: "",
          shares: [],
          deleted: false,
        },
      ],
    });
    expect((await smoke(input(c))).ok).toBe(true);
    expect(live(c).map((a) => a.id)).toEqual(["mine-other", "someone-else"]);
    expect(
      c.calls
        .filter((x) => x.method === "DELETE" && !x.path.includes("/shares/"))
        .map((x) => x.path),
    ).toEqual(["/api/v1/artifacts/old", "/api/v1/artifacts/a1"]);
  });

  it("emailed:true is a failure of the share check, at once", async () => {
    const c = canary();
    // The share lands as usual; only the answer says an email went out.
    const f: SmokeFetch = async (url, init) => {
      const r = await c.fetch(url, init);
      if (init.method === "PUT" && new URL(url).pathname.endsWith("/shares"))
        return Response.json({ ...(await r.json()), emailed: true });
      return r;
    };
    expect(await smoke(input(c, { fetch: f }))).toEqual({
      ok: false,
      kind: "assert",
      check: "share",
    });
    // Cleanup still ran: the share and the artifact are gone.
    expect(live(c)).toEqual([]);
    expect(c.arts[0]?.shares).toEqual([]);
  });

  const wrong: [string, Fault, string][] = [
    [
      "a /me that isn't JSON",
      (p) => (p === "/api/v1/me" ? new Response("x") : null),
      "signin",
    ],
    [
      "providers listing none",
      (p) =>
        p === "/auth/providers" ? Response.json({ providers: [] }) : null,
      "signin",
    ],
    [
      "Google sign-in starting at another broker",
      (p) =>
        p === "/auth/login/google"
          ? new Response(null, {
              status: 302,
              headers: {
                location: `https://evil.example/google/authorize?install=${ID}`,
              },
            })
          : null,
      "signin",
    ],
    [
      "Google sign-in for another install",
      (p) =>
        p === "/auth/login/google"
          ? new Response(null, {
              status: 302,
              headers: {
                location: `${BROKER}/google/authorize?install=iother000001`,
              },
            })
          : null,
      "signin",
    ],
    [
      "a publish that isn't 201",
      (p, m) =>
        p === "/api/v1/artifacts" && m === "POST"
          ? Response.json({ error: "bad" }, { status: 400 })
          : null,
      "publish",
    ],
    [
      "a read-back that differs",
      (p) => (p.endsWith("/files/index.md") ? new Response("other") : null),
      "read",
    ],
    [
      "a share list without smoke-b",
      (p, m) =>
        p.endsWith("/shares") && m === "GET" ? Response.json([]) : null,
      "share",
    ],
    [
      "an MCP error",
      (p) =>
        p === "/mcp"
          ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601 } })
          : null,
      "mcp",
    ],
  ];
  for (const [name, fault, check] of wrong)
    it(`asserts: ${name}`, async () => {
      const c = canary({ fault });
      expect(await smoke(input(c))).toEqual({
        ok: false,
        kind: "assert",
        check,
      });
      expect(live(c)).toEqual([]);
    });

  it("an MCP tools/list without get_artifact is a failure", async () => {
    const c = canary();
    const f: SmokeFetch = async (url, init) => {
      if (new URL(url).pathname === "/mcp")
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "publish_artifact" }] },
        });
      return c.fetch(url, init);
    };
    expect(await smoke(input(c, { fetch: f }))).toEqual({
      ok: false,
      kind: "assert",
      check: "mcp",
    });
  });

  for (const [name, fault] of [
    ["a 5xx", () => new Response("no", { status: 502 })],
    ["a 429", () => new Response("slow", { status: 429 })],
    ["a network error", () => "throw" as const],
    ["a timeout", () => "hang" as const],
  ] as const)
    it(`transport: ${name} on read counts once, and cleanup still runs`, async () => {
      const c = canary({
        fault: (p) => (p.endsWith("/versions") ? fault() : null),
      });
      expect(await smoke(input(c))).toEqual({
        ok: false,
        kind: "transport",
        check: "read",
      });
      expect(live(c)).toEqual([]);
    });

  it("config: no token, no smoke-b, smoke-b being smoke-a, a refused token, or an admin", async () => {
    const run = async (o: {
      over?: Partial<SmokeInput>;
      me?: object;
      fault?: Fault;
    }) => {
      const c = canary({ me: o.me, fault: o.fault });
      const r = await smoke(input(c, o.over));
      return { r, calls: c.calls.length, live: live(c) };
    };
    expect((await run({ over: { token: "" } })).r).toEqual({
      ok: false,
      kind: "config",
      check: "token",
    });
    expect((await run({ over: { token: "" } })).calls).toBe(0);
    expect((await run({ over: { shareTo: "" } })).r).toMatchObject({
      kind: "config",
      check: "share",
    });
    expect(
      (await run({ over: { shareTo: "not-an-address" } })).r,
    ).toMatchObject({ kind: "config", check: "share" });
    expect(
      (await run({ over: { shareTo: ME.email.toUpperCase() } })).r,
    ).toMatchObject({ kind: "config", check: "share" });
    expect((await run({ over: { token: "oat_revoked" } })).r).toMatchObject({
      kind: "config",
      check: "token",
    });
    for (const role of ["admin", "owner", "manager"]) {
      const x = await run({ me: { ...ME, role } });
      expect(x.r, role).toMatchObject({ kind: "config", check: "token" });
      // Nothing published as an over-privileged identity.
      expect(x.live).toEqual([]);
    }
    expect((await run({ me: { ...ME, status: "suspended" } })).r).toMatchObject(
      { kind: "config", check: "token" },
    );
  });

  it("the budget: past it, the run stops as budget, and still cleans up", async () => {
    let t = 0;
    const c = canary();
    // Each call takes 1 s of the clock; a 4 s budget ends mid-run.
    const f: SmokeFetch = async (url, init) => {
      t += 1_000;
      return c.fetch(url, init);
    };
    const r = await smoke(
      input(c, { fetch: f, clock: () => t, budgetMs: 4_500, callMs: 500 }),
    );
    expect(r).toMatchObject({ ok: false, kind: "budget" });
    expect(live(c)).toEqual([]);
  });

  it("a failed delete fails a passing run (delete); the next sweep catches it", async () => {
    const c = canary({
      fault: (p, m) =>
        m === "DELETE" && /^\/api\/v1\/artifacts\/a1$/.test(p)
          ? Response.json({ error: "nope" }, { status: 403 })
          : null,
    });
    expect(await smoke(input(c))).toEqual({
      ok: false,
      kind: "assert",
      check: "delete",
    });
    const d = canary({ arts: c.arts });
    expect(await smoke(input(d, { nonce: () => "n2" }))).toEqual({
      ok: true,
      notes: [SMOKE_BUS_SKIPPED],
    });
    expect(live(d)).toEqual([]);
  });

  it("never puts the token, a body or smoke-b's address in its result", async () => {
    for (const fault of [
      undefined,
      ((p: string) =>
        p.endsWith("/files/index.md") ? new Response(TOKEN) : null) as Fault,
    ]) {
      const c = canary({ fault });
      const r = JSON.stringify(await smoke(input(c)));
      for (const s of [TOKEN, SHARE_TO, ME.email, TITLE])
        expect(r).not.toContain(s);
    }
  });

  it("no Google offered: the sign-in check skips the redirect", async () => {
    const c = canary({
      fault: (p) =>
        p === "/auth/providers"
          ? Response.json({ providers: [{ id: "email" }] })
          : null,
    });
    expect((await smoke(input(c))).ok).toBe(true);
    expect(c.calls.some((x) => x.path === "/auth/login/google")).toBe(false);
  });
});
