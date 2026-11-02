import { env } from "cloudflare:workers";
import { MeSchema, newId, R, UsageSchema } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import { api, fetchAndWait, login } from "./helpers.js";
import { connect, E, textOf, tool } from "./mcp-helpers.js";

const app = createApp();
let admin: { cookie: string };
let member: { cookie: string };
beforeAll(async () => {
  const t = newId().slice(0, 6).toLowerCase();
  admin = await login(`us-a-${t}@x.com`, "admin");
  member = await login(`us-m-${t}@x.com`, "member");
});
afterEach(() => vi.restoreAllMocks());

const gql = (over: object = {}, acct: object = {}) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            {
              workers: [{ sum: { requests: 1200 } }],
              d1: [{ sum: { rowsRead: 3000, rowsWritten: 40 } }],
              dos: [{ sum: { requests: 77 } }],
              cpu: [{ quantiles: { cpuTimeP99: 8500 } }],
              cpuHits: [{ sum: { requests: 2 } }, { sum: { requests: 1 } }],
              kv: [{ sum: { requests: 40 } }, { sum: { requests: 2 } }],
              ...acct,
            },
          ],
        },
      },
      errors: null,
      ...over,
    }),
    { headers: { "content-type": "application/json" } },
  );
const withToken = (token?: string) => ({
  ...(env as object),
  WORKER_NAME: "oa-test",
  OAUTH_KV_ID: "kv-test",
  ANALYTICS_TOKEN: token,
});
const graphqlCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) =>
    String(c[0] instanceof Request ? c[0].url : c[0]).includes("graphql"),
  );
const usageFor = async (e: unknown) =>
  UsageSchema.parse(await (await call(admin.cookie, e)).json());
const call = (cookie: string | null, e: unknown) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.usage}`, {
      headers: { ...(cookie ? { cookie } : {}), "x-oa-request": "1" },
    }),
    e,
  );

describe("usage", () => {
  it("owner/admin only; others 404", async () => {
    expect((await api(app, R.usage, member.cookie)).status).toBe(404);
    expect((await api(app, R.usage, null)).status).toBe(401);
  });

  it("no token -> unavailable", async () => {
    const r = await call(admin.cookie, withToken());
    const u = UsageSchema.parse(await r.json());
    expect(u).toMatchObject({ available: false, plan: "free", metrics: [] });
    expect(u.date).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("maps GraphQL metrics and caches for 5 minutes", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-cache" };
    const u = UsageSchema.parse(await (await call(admin.cookie, e)).json());
    expect(u.available).toBe(true);
    expect(u.plan).toBe("free");
    expect(u.metrics).toEqual([
      { key: "requests", used: 1200, limit: 100000 },
      { key: "d1_reads", used: 3000, limit: 5000000 },
      { key: "d1_writes", used: 40, limit: 100000 },
      { key: "do_requests", used: 77, limit: 100000 },
      { key: "cpu_limit_hits", used: 3, limit: 0 },
      { key: "cpu_p99_ms", used: 8.5, limit: 10 },
      { key: "kv_writes", used: 42, limit: 1000 },
    ]);
    const calls = spy.mock.calls.filter((c) =>
      String(c[0] instanceof Request ? c[0].url : c[0]).includes("graphql"),
    );
    expect(calls).toHaveLength(1);
    const init = calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
    const u2 = UsageSchema.parse(await (await call(admin.cookie, e)).json());
    expect(u2).toEqual(u);
    expect(
      spy.mock.calls.filter((c) => String(c[0]).includes("graphql")),
    ).toHaveLength(1);
  });

  it("PLAN=paid: no daily caps (limit 0), CPU p99 against 30 s", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => gql());
    const u = await usageFor({
      ...withToken("tok"),
      PLAN: "paid",
      CF_ACCOUNT_ID: "acct-paid",
    });
    expect(u.plan).toBe("paid");
    expect(u.metrics).toEqual([
      { key: "requests", used: 1200, limit: 0 },
      { key: "d1_reads", used: 3000, limit: 0 },
      { key: "d1_writes", used: 40, limit: 0 },
      { key: "do_requests", used: 77, limit: 0 },
      { key: "cpu_limit_hits", used: 3, limit: 0 },
      { key: "cpu_p99_ms", used: 8.5, limit: 30000 },
      { key: "kv_writes", used: 42, limit: 0 },
    ]);
  });

  it("PLAN=paid, no token -> unavailable with plan paid", async () => {
    const u = await usageFor({ ...withToken(), PLAN: "paid" });
    expect(u).toMatchObject({ available: false, plan: "paid", metrics: [] });
  });

  it("cache is per plan: a Free read is not served after PLAN flips to paid", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-flip" };
    expect((await usageFor(e)).plan).toBe("free");
    expect((await usageFor({ ...e, PLAN: "paid" })).plan).toBe("paid");
    expect(graphqlCalls(spy)).toHaveLength(2);
  });

  it("GraphQL errors or bad shape -> available:false, not cached", async () => {
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-err" };
    let n = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n++;
      return n === 1
        ? gql({ errors: [{ message: "boom" }] })
        : new Response('{"data":{"nope":1}}', { status: 200 });
    });
    for (let i = 0; i < 2; i++) {
      const r = await call(admin.cookie, e);
      expect(r.status).toBe(200);
      expect(UsageSchema.parse(await r.json()).available).toBe(false);
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("CPU query: scriptName filter, outcome filter, today's window", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    await usageFor({ ...withToken("tok"), CF_ACCOUNT_ID: "acct-cpu-q" });
    const init = graphqlCalls(spy)[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.query).toContain("scriptName: $s");
    expect(body.query).toContain(
      'status_in: ["exceededCpu", "exceededResources"]',
    );
    expect(body.query).toContain("cpuTimeP99");
    expect(body.variables.s).toBe("oa-test");
    expect(body.query).toContain(
      'kvOperationsAdaptiveGroups(limit: 10, filter: { namespaceId: $kv, date: $day, actionType: "write" })',
    );
    expect(body.variables.kv).toBe("kv-test");
    expect(body.variables.from).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/);
  });

  it("no invocations today -> CPU metrics are 0", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpu: [], cpuHits: [], kv: [] }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-cpu-empty",
    });
    expect(u.metrics.slice(4)).toEqual([
      { key: "cpu_limit_hits", used: 0, limit: 0 },
      { key: "cpu_p99_ms", used: 0, limit: 10 },
      { key: "kv_writes", used: 0, limit: 1000 },
    ]);
  });

  it("CPU data missing or malformed -> CPU metrics omitted, rest available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpu: [{ quantiles: { cpuTimeP99: "x" } }], cpuHits: null }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-cpu-bad",
    });
    expect(u.available).toBe(true);
    expect(u.metrics.map((m) => m.key)).toEqual([
      "requests",
      "d1_reads",
      "d1_writes",
      "do_requests",
      "kv_writes",
    ]);
  });

  it("KV data missing or malformed -> only kv_writes omitted", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { kv: [{ sum: { requests: -1 } }] }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-kv-bad",
    });
    expect(u.available).toBe(true);
    expect(u.metrics.map((m) => m.key)).not.toContain("kv_writes");
    expect(u.metrics).toHaveLength(6);
  });

  it("GraphQL error on the kv alias -> only kv_writes omitted", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql(
        { errors: [{ message: "no", path: ["viewer", "accounts", 0, "kv"] }] },
        { kv: null },
      ),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-kv-err",
    });
    expect(u.available).toBe(true);
    expect(u.metrics.map((m) => m.key)).toEqual([
      "requests",
      "d1_reads",
      "d1_writes",
      "do_requests",
      "cpu_limit_hits",
      "cpu_p99_ms",
    ]);
  });

  it("GraphQL error on cpuHits -> CPU metrics omitted, base and kv stay", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({
        errors: [{ message: "no", path: ["viewer", "accounts", 0, "cpuHits"] }],
      }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-cpu-err",
    });
    expect(u.available).toBe(true);
    expect(u.metrics.map((m) => m.key)).toEqual([
      "requests",
      "d1_reads",
      "d1_writes",
      "do_requests",
      "kv_writes",
    ]);
  });

  it("GraphQL error on a base alias -> available:false", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({
        errors: [{ message: "no", path: ["viewer", "accounts", 0, "d1"] }],
      }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-base-err",
    });
    expect(u.available).toBe(false);
  });

  it("no OAUTH_KV_ID -> no KV alias queried, kv_writes omitted", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const u = await usageFor({
      ...withToken("tok"),
      OAUTH_KV_ID: undefined,
      CF_ACCOUNT_ID: "acct-kv-noid",
    });
    expect(u.metrics.map((m) => m.key)).not.toContain("kv_writes");
    const init = graphqlCalls(spy)[0]?.[1] as RequestInit;
    expect(String(init.body)).not.toContain("kvOperationsAdaptiveGroups");
  });

  it("OAUTH_STORE=d1 with no OAUTH_KV binding: works, and the namespace id is never queried", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const e: Record<string, unknown> = {
      ...withToken("tok"),
      OAUTH_STORE: "d1",
      CF_ACCOUNT_ID: "acct-kv-d1",
    };
    delete e.OAUTH_KV;
    const u = await usageFor(e);
    expect(u.available).toBe(true);
    expect(u.metrics.map((m) => m.key)).not.toContain("kv_writes");
    const init = graphqlCalls(spy)[0]?.[1] as RequestInit;
    expect(String(init.body)).not.toContain("kvOperationsAdaptiveGroups");
    expect(String(init.body)).not.toContain("kv-test");
  });

  it("no WORKER_NAME -> no CPU aliases queried, CPU metrics omitted", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const u = await usageFor({
      ...withToken("tok"),
      WORKER_NAME: undefined,
      CF_ACCOUNT_ID: "acct-cpu-noname",
    });
    expect(u.metrics.map((m) => m.key)).not.toContain("cpu_p99_ms");
    expect(u.metrics).toHaveLength(5);
    const init = graphqlCalls(spy)[0]?.[1] as RequestInit;
    expect(String(init.body)).not.toContain("cpuTimeP99");
  });
});

// P3 T19: hosted sets FEATURES=usage_off; self-hosted default is unchanged.
describe("usage_off", () => {
  const withFeatures = (f: string) => ({ ...withToken("tok"), FEATURES: f });
  const me = async (e: unknown) =>
    MeSchema.parse(
      await (
        await fetchAndWait(
          app,
          new Request(`http://app.localhost${R.me}`, {
            headers: { cookie: owner.cookie },
          }),
          e,
        )
      ).json(),
    );
  let owner: { cookie: string };
  beforeAll(async () => {
    owner = await login(
      `us-o-${newId().slice(0, 6).toLowerCase()}@x.com`,
      "owner",
    );
  });

  it("usage_off → GET /api/v1/usage 404 for the owner", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const who of [owner, admin, member])
      expect((await call(who.cookie, withFeatures("usage_off"))).status).toBe(
        404,
      );
    // Absent for everyone: no 401 hint, and no analytics call.
    expect((await call(null, withFeatures("spaces,usage_off"))).status).toBe(
      404,
    );
    expect(graphqlCalls(spy)).toHaveLength(0);
  });

  it('usage_off → me.instance.features contains "usage_off"', async () => {
    // Me.instance.features appears on hosted (or direct sign-in) installs.
    const hosted = (f: string) => ({ ...withFeatures(f), HOSTED: "1" });
    expect((await me(hosted("usage_off"))).instance.features).toContain(
      "usage_off",
    );
    expect((await me(hosted(""))).instance.features).not.toContain("usage_off");
  });

  it("no flag → owner still gets usage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => gql());
    for (const f of ["", "spaces,content_revocation"]) {
      const r = await call(owner.cookie, {
        ...withFeatures(f),
        CF_ACCOUNT_ID: `acct-flag-${f.length}`,
      });
      expect(r.status).toBe(200);
      expect(UsageSchema.parse(await r.json()).available).toBe(true);
    }
  });

  it("the policy gate refuses on its own (offWhen)", () => {
    expect(ROUTE_POLICY[`GET ${R.usage}`]).toEqual({
      org: "usage.read",
      offWhen: "usage_off",
    });
  });
});

describe("MCP CPU-limit nudge", () => {
  const NUDGE = /hit Cloudflare's free-plan CPU limit (\d+) times today/;
  let pat: string;
  beforeAll(async () => {
    pat = (
      await createPat(
        env,
        (
          await login(`us-p-${newId().slice(0, 6).toLowerCase()}@x.com`)
        ).userId,
        "a",
      )
    ).token;
  });

  const listWith = async (hits: number, acct: string, plan?: string) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpuHits: [{ sum: { requests: hits } }] }),
    );
    await usageFor({ ...withToken("tok"), CF_ACCOUNT_ID: acct, PLAN: plan });
    vi.restoreAllMocks();
    const spy = vi.spyOn(globalThis, "fetch");
    const client = await connect(pat, { env: E(withToken("tok")) });
    const r = await tool(client, "list_artifacts", { scope: "mine" });
    await client.close();
    expect(graphqlCalls(spy)).toHaveLength(0);
    return r;
  };

  it("a guest's PAT is refused at /mcp (no tool results, no nudge)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpuHits: [{ sum: { requests: 5 } }] }),
    );
    await usageFor({ ...withToken("tok"), CF_ACCOUNT_ID: "acct-nudge-g" });
    vi.restoreAllMocks();
    const g = await login(
      `us-g-${newId().slice(0, 6).toLowerCase()}@x.com`,
      "guest",
    );
    const gpat = (await createPat(env, g.userId, "g")).token;
    await expect(connect(gpat, { env: E(withToken("tok")) })).rejects.toThrow();
  });

  it("2 hits today -> no nudge", async () => {
    const r = await listWith(2, "acct-nudge-2");
    expect(textOf(r)).not.toMatch(NUDGE);
    expect(r.content).toHaveLength(1);
  });

  it("3 hits today -> one extra text item with N; structured content unchanged", async () => {
    const r = await listWith(3, "acct-nudge-3");
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toEqual({
      type: "text",
      text: "Your instance hit Cloudflare's free-plan CPU limit 3 times today. See Settings → Usage for the fix (Workers Paid).",
    });
    expect(r.structuredContent).not.toHaveProperty("cpu_limit_hits");
    expect(JSON.stringify(r.structuredContent)).not.toMatch(NUDGE);
  });

  it("Workers Paid, 5 hits today -> no nudge (no 10 ms cap to point at)", async () => {
    const r = await listWith(5, "acct-nudge-paid", "paid");
    expect(textOf(r)).not.toMatch(NUDGE);
    expect(r.content).toHaveLength(1);
  });
});
