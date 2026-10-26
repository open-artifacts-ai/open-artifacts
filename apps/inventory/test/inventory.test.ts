import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";

const KEY = "k".repeat(40);

const ROW = {
  id: "inst1",
  app_host: "a.example.com",
  content_host: "c.example.com",
  state: "active",
  test_hooks: 1,
  owner_email: "o@example.com",
  inputs_hash: "h",
  d1_id: "d1",
  broker_kid: "kid",
};

// A KV stub: list() pages over the sorted keys, `page` at a time, with opaque
// cursors; get() takes one key or an array (bulk, at most 100).
function makeKv(entries: Record<string, string>, page = 2) {
  const names = Object.keys(entries).sort();
  const calls = { list: 0, get: 0, writes: 0 };
  const kv = {
    async list(opts: { cursor?: string; limit?: number } = {}) {
      calls.list++;
      const start = opts.cursor ? Number(opts.cursor.replace("c", "")) : 0;
      const n = Math.min(page, opts.limit ?? 1000);
      const slice = names.slice(start, start + n);
      const done = start + n >= names.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: done,
        cursor: done ? undefined : `c${start + n}`,
      };
    },
    async get(k: string | string[]) {
      calls.get++;
      if (Array.isArray(k)) {
        expect(k.length).toBeLessThanOrEqual(100);
        return new Map(k.map((x) => [x, entries[x] ?? null]));
      }
      return entries[k] ?? null;
    },
    async put() {
      calls.writes++;
    },
    async delete() {
      calls.writes++;
    },
  };
  return { kv, calls };
}

function makeEnv(over: Partial<Env> = {}, rows: object[] = [ROW]) {
  const sqls: string[] = [];
  const PLATFORM_DB = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: rows };
        },
      };
    },
  };
  return {
    env: {
      PLATFORM_DB,
      HOSTS: makeKv({}).kv,
      INVENTORY_KEY: KEY,
      ...over,
    } as unknown as Env,
    sqls,
  };
}

const req = (path = "/installs", init: RequestInit = {}, auth?: string) =>
  new Request(`https://x.test${path}`, {
    ...init,
    headers: auth === undefined ? {} : { authorization: auth },
  });

async function call(r: Request, env: Env) {
  return worker.fetch(r, env);
}

async function expect404(r: Request, env: Env) {
  const res = await call(r, env);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not found");
}

describe("auth", () => {
  it("wrong key -> 404", async () => {
    await expect404(
      req("/installs", {}, `Bearer ${"z".repeat(40)}`),
      makeEnv().env,
    );
  });
  it("missing header -> 404", async () => {
    await expect404(req(), makeEnv().env);
  });
  it("non-Bearer scheme -> 404", async () => {
    await expect404(req("/installs", {}, `Basic ${KEY}`), makeEnv().env);
    await expect404(req("/installs", {}, KEY), makeEnv().env);
  });
  it("missing or short INVENTORY_KEY fails closed", async () => {
    const short = "s".repeat(31);
    await expect404(
      req("/installs", {}, `Bearer ${short}`),
      makeEnv({ INVENTORY_KEY: short }).env,
    );
    await expect404(
      req("/installs", {}, "Bearer "),
      makeEnv({ INVENTORY_KEY: undefined }).env,
    );
    await expect404(
      req("/installs", {}, "Bearer undefined"),
      makeEnv({ INVENTORY_KEY: undefined }).env,
    );
  });
});

describe("routing", () => {
  it("other paths and methods -> 404", async () => {
    const { env } = makeEnv();
    await expect404(req("/installs", { method: "POST" }, `Bearer ${KEY}`), env);
    await expect404(req("/", {}, `Bearer ${KEY}`), env);
    await expect404(req("/installs/x", {}, `Bearer ${KEY}`), env);
  });
});

describe("response", () => {
  it("returns only the five mapped fields", async () => {
    const { env, sqls } = makeEnv();
    const res = await call(req("/installs", {}, `Bearer ${KEY}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { installs: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["installs"]);
    expect(body.installs).toHaveLength(1);
    expect(Object.keys(body.installs[0]).sort()).toEqual(
      ["appHost", "contentHost", "id", "state", "testHooks"].sort(),
    );
    expect(body.installs[0]).toEqual({
      id: "inst1",
      appHost: "a.example.com",
      contentHost: "c.example.com",
      state: "active",
      testHooks: true,
    });
    expect(typeof body.installs[0].testHooks).toBe("boolean");
    expect(JSON.stringify(body)).not.toMatch(/o@example|inputs|d1|kid/);
    expect(sqls).toEqual([
      "SELECT id, app_host, content_host, state, test_hooks FROM installs ORDER BY id",
    ]);
  });
  it("testHooks false for 0", async () => {
    const { env } = makeEnv({}, [{ ...ROW, test_hooks: 0 }]);
    const res = await call(req("/installs", {}, `Bearer ${KEY}`), env);
    const body = (await res.json()) as { installs: { testHooks: boolean }[] };
    expect(body.installs[0].testHooks).toBe(false);
  });
});

const auth = `Bearer ${KEY}`;
const hostsJson = async (path: string, env: Env) => {
  const res = await call(req(path, {}, auth), env);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json() as Promise<Record<string, unknown>>;
};

describe("GET /hosts", () => {
  const E = {
    "b.example.com": "ibbbbbbbbbbb",
    "a.example.com": "iaaaaaaaaaaa",
    "c.example.com": "iccccccccccc",
    "d.example.com": "iaaaaaaaaaaa",
    "e.example.com": "not an id <script>",
  };
  const withKv = (entries: Record<string, string>, page = 2) => {
    const k = makeKv(entries, page);
    return { ...k, env: makeEnv({ HOSTS: k.kv as never }).env };
  };

  it("auth: missing, wrong and short key -> 404", async () => {
    const { env } = withKv(E);
    await expect404(req("/hosts"), env);
    await expect404(req("/hosts", {}, `Bearer ${"z".repeat(40)}`), env);
    await expect404(req("/hosts", {}, `Basic ${KEY}`), env);
    const short = "s".repeat(31);
    await expect404(
      req("/hosts", {}, `Bearer ${short}`),
      makeEnv({ INVENTORY_KEY: short }).env,
    );
    await expect404(
      req("/hosts?host=a.example.com", {}, `Bearer ${"z".repeat(40)}`),
      env,
    );
  });

  it("other methods and paths -> 404", async () => {
    const { env } = withKv(E);
    for (const m of ["POST", "PUT", "DELETE", "HEAD"])
      await expect404(req("/hosts", { method: m }, auth), env);
    await expect404(req("/hosts/a.example.com", {}, auth), env);
    await expect404(req("/hostsx", {}, auth), env);
  });

  it("lists every host across 3 cursor pages, sorted, unparsable -> null", async () => {
    const { env, calls } = withKv(E, 2);
    const body = await hostsJson("/hosts", env);
    expect(Object.keys(body)).toEqual(["hosts", "complete"]);
    expect(body.complete).toBe(true);
    expect(body.hosts).toEqual([
      { host: "a.example.com", installId: "iaaaaaaaaaaa" },
      { host: "b.example.com", installId: "ibbbbbbbbbbb" },
      { host: "c.example.com", installId: "iccccccccccc" },
      { host: "d.example.com", installId: "iaaaaaaaaaaa" },
      { host: "e.example.com", installId: null },
    ]);
    expect(calls.list).toBe(3);
    expect(JSON.stringify(body)).not.toContain("script");
  });

  it("an empty namespace is complete with no hosts", async () => {
    const { env } = withKv({});
    expect(await hostsJson("/hosts", env)).toEqual({
      hosts: [],
      complete: true,
    });
  });

  it("stops at 10,000 keys with complete:false", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 10_001; i++)
      big[`h${String(i).padStart(5, "0")}.example.com`] = "iaaaaaaaaaaa";
    const { env } = withKv(big, 1000);
    const body = (await hostsJson("/hosts", env)) as {
      hosts: unknown[];
      complete: boolean;
    };
    expect(body.complete).toBe(false);
    expect(body.hosts).toHaveLength(10_000);
  });

  it("exactly 10,000 keys is still complete", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 10_000; i++)
      big[`h${String(i).padStart(5, "0")}.example.com`] = "iaaaaaaaaaaa";
    const { env } = withKv(big, 1000);
    const body = (await hostsJson("/hosts", env)) as {
      hosts: unknown[];
      complete: boolean;
    };
    expect(body.complete).toBe(true);
    expect(body.hosts).toHaveLength(10_000);
  });

  it("?host= hit, miss and unparsable; the key is exact", async () => {
    const { env } = withKv(E);
    expect(await hostsJson("/hosts?host=b.example.com", env)).toEqual({
      host: "b.example.com",
      installId: "ibbbbbbbbbbb",
    });
    expect(await hostsJson("/hosts?host=nope.example.com", env)).toEqual({
      host: "nope.example.com",
      installId: null,
    });
    expect(await hostsJson("/hosts?host=e.example.com", env)).toEqual({
      host: "e.example.com",
      installId: null,
    });
    // No normalization: case and a trailing dot are different keys.
    expect(await hostsJson("/hosts?host=B.example.com", env)).toEqual({
      host: "B.example.com",
      installId: null,
    });
    expect(await hostsJson("/hosts?host=b.example.com.", env)).toEqual({
      host: "b.example.com.",
      installId: null,
    });
  });

  it("never writes, and /installs is unchanged", async () => {
    const { env, calls } = withKv(E);
    await hostsJson("/hosts", env);
    await hostsJson("/hosts?host=a.example.com", env);
    expect(calls.writes).toBe(0);
    const res = await call(req("/installs", {}, auth), env);
    expect(Object.keys((await res.json()) as object)).toEqual(["installs"]);
  });
});

describe("read-only by construction", () => {
  it("src never calls a KV write or a D1 write verb", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/\.put\(|\.delete\(/);
      expect(src, f).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA)\b/i,
      );
      expect(src, f).not.toMatch(/\.(batch|run)\(/);
    }
  });
});

describe("wrangler.jsonc", () => {
  it("binds PLATFORM_DB and HOSTS only", () => {
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as Record<
      string,
      unknown
    >;
    expect(cfg.d1_databases).toEqual([
      expect.objectContaining({
        binding: "PLATFORM_DB",
        database_name: "oa-platform",
      }),
    ]);
    expect(cfg.kv_namespaces).toEqual([
      expect.objectContaining({ binding: "HOSTS" }),
    ]);
    for (const k of [
      "r2_buckets",
      "services",
      "durable_objects",
      "vars",
      "routes",
      "route",
      "triggers",
      "queues",
      "ai",
      "analytics_engine_datasets",
    ]) {
      expect(cfg, k).not.toHaveProperty(k);
    }
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.preview_urls).toBe(false);
  });
});
