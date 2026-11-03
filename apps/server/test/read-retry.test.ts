import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  breakerOpen,
  isReadOnlySql,
  RETRY,
  resetBreaker,
  retryingD1,
  retryingKv,
  setRetryDeps,
  withReadBudget,
  withRetries,
} from "../src/db/retry.js";
import { stmt } from "../src/db/stmt.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { oauthEnv } from "../src/mcp/oauth-store.js";
import { fetchAndWait } from "./helpers.js";

const E = env as unknown as Env;

const d1Down = () =>
  new Error("D1_ERROR: internal error; reference = abcd1234efgh5678");
const kvDown = (op = "GET") =>
  new Error(`KV ${op} failed: 500 Internal Server Error`);

/** The atomic one-time-code claim (auth/codes.ts): a retry counts a guess twice. */
const LOGIN_CODE_CLAIM =
  "delete from login_codes where email_key = ?1 and request_id = ?2 and code_hash = ?3 returning 1 as x";

// ------------------------------------------------------------ fakes

type Outcome = Error | unknown;

/** Every call (read or write) takes the next outcome; past the list, "ok". */
class Script {
  calls = 0;
  constructor(private readonly outcomes: Outcome[] = []) {}
  next(): Promise<unknown> {
    const o = this.outcomes[this.calls++];
    return o instanceof Error ? Promise.reject(o) : Promise.resolve(o ?? "ok");
  }
}

class FakeStmt {
  constructor(
    readonly sql: string,
    readonly s: Script,
    readonly params: unknown[] = [],
  ) {}
  bind(...p: unknown[]) {
    return new FakeStmt(this.sql, this.s, p);
  }
  first() {
    return this.s.next();
  }
  all() {
    return this.s.next();
  }
  raw() {
    return this.s.next();
  }
  run() {
    return this.s.next();
  }
}

function fakeDb(s: Script) {
  return {
    prepare: (sql: string) => new FakeStmt(sql, s),
    batch: (_x: unknown[]) => s.next(),
    exec: (_q: string) => s.next(),
  } as unknown as D1Database;
}

function fakeKv(s: Script) {
  return {
    get: vi.fn((..._a: unknown[]) => s.next()),
    getWithMetadata: vi.fn(() => s.next()),
    put: vi.fn(() => s.next()),
    delete: vi.fn(() => s.next()),
    list: vi.fn(() => s.next()),
  } as unknown as KVNamespace & Record<string, ReturnType<typeof vi.fn>>;
}

/** mulberry32: a seeded random in [0, 1). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let clock = 1_000_000;
let sleeps: number[] = [];
let logs: string[] = [];

beforeEach(() => {
  clock = 1_000_000;
  sleeps = [];
  logs = [];
  resetBreaker();
  setRetryDeps({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: seeded(42),
  });
  for (const k of ["log", "warn", "error"] as const)
    vi.spyOn(console, k).mockImplementation((s: unknown) => {
      logs.push(String(s));
    });
});

afterEach(() => {
  setRetryDeps(null);
  resetBreaker();
  vi.restoreAllMocks();
});

const events = () =>
  logs
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);

// ------------------------------------------------------------ classification

describe("isReadOnlySql", () => {
  it.each([
    ["select id from users where id = ?", true],
    ["  SELECT 1", true],
    ["SeLeCt * from t", true],
    ["with x as (select 1) select * from x", true],
    ["explain query plan select 1", true],
    ["-- lead\nselect 1", true],
    ["/* lead */ select 1", true],
    ["/* a */ -- b\n /* c */ SELECT 1", true],
    ["select updated_at, deleted_at from t", true],
    ["with x as (select 1) insert into t select * from x", false],
    ["WITH x AS (SELECT 1) DELETE FROM t WHERE id IN x", false],
    ["insert into t (a) values (?) returning id", false],
    ["delete from t where id = ? returning id", false],
    [LOGIN_CODE_CLAIM, false],
    ["update t set a = 1", false],
    ["UPDATE t SET a = 1 WHERE id = ?", false],
    ["select 1 returning x", false],
    ["pragma table_info(t)", false],
    ["select * from pragma_table_info('t')", true],
    ["select 1; drop table t", false],
    ["select 1 /* update */", false],
    ["-- select\nupdate t set a = 1", false],
    ["/* select */ delete from t", false],
    ["replace into t values (1)", false],
    ["create table t (a)", false],
    ["values (1)", false],
    ["vacuum", false],
    ["analyze", false],
    ["reindex t", false],
    ["attach database 'x' as y", false],
    ["detach database y", false],
    ["begin", false],
    ["savepoint s", false],
    ["select 1; vacuum", false],
    ["with x as (select 1) select * from x; analyze", false],
    ["", false],
  ])("%s -> %s", (sql, want) => {
    expect(isReadOnlySql(sql)).toBe(want);
  });
});

// ------------------------------------------------------------ d1 reads

describe("D1 read retry", () => {
  it("retries a read that fails once with a storage error, once", async () => {
    const s = new Script([d1Down(), { id: 7 }]);
    const db = retryingD1(fakeDb(s));
    const r = await db.prepare("select id from t where a = ?").bind(1).first();
    expect(r).toEqual({ id: 7 });
    expect(s.calls).toBe(2);
    expect(sleeps).toHaveLength(1);
    const ok = events().filter((e) => e.evt === "storage_read_retry_ok");
    expect(ok).toEqual([
      { evt: "storage_read_retry_ok", store: "d1", attempts: 2 },
    ]);
  });

  it("retries all() and raw(), bound or not", async () => {
    for (const m of ["all", "raw"] as const) {
      const s1 = new Script([d1Down(), "r"]);
      const unbound = retryingD1(fakeDb(s1)).prepare("select 1");
      expect(await unbound[m]()).toBe("r");
      expect(s1.calls).toBe(2);
      const s2 = new Script([d1Down(), "r"]);
      const bound = retryingD1(fakeDb(s2)).prepare("select ?").bind(1).bind(2);
      expect(await bound[m]()).toBe("r");
      expect(s2.calls).toBe(2);
    }
  });

  it("gives up after 3 storage failures, with the storage error", async () => {
    const err = d1Down();
    const s = new Script([err, err, err, "never"]);
    const db = retryingD1(fakeDb(s));
    await expect(db.prepare("select 1").first()).rejects.toBe(err);
    expect(s.calls).toBe(RETRY.attempts);
    expect(s.calls).toBe(3);
    const gave = events().filter((e) => e.evt === "storage_read_gave_up");
    expect(gave).toEqual([
      {
        evt: "storage_read_gave_up",
        store: "d1",
        attempts: 3,
        reason: "attempts",
      },
    ]);
  });

  it("never retries an error that isn't a storage failure", async () => {
    for (const e of [
      new Error("D1_ERROR: no such table: t"),
      new Error("boom: D1_ERROR: internal error"),
      new TypeError("x is undefined"),
    ]) {
      const s = new Script([e, "ok"]);
      const db = retryingD1(fakeDb(s));
      await expect(db.prepare("select 1").first()).rejects.toBe(e);
      expect(s.calls).toBe(1);
    }
  });

  it("never retries a write, RETURNING included", async () => {
    for (const sql of [
      LOGIN_CODE_CLAIM,
      "insert into t (a) values (?) returning id",
      "with x as (select 1) insert into t select * from x",
      "update t set a = 1",
      "pragma foreign_keys",
    ]) {
      for (const m of ["first", "all", "raw"] as const) {
        const s = new Script([d1Down(), "second try"]);
        const st = retryingD1(fakeDb(s)).prepare(sql).bind("a", "b", "c");
        const read = (st[m] as () => Promise<unknown>).bind(st);
        await expect(read()).rejects.toThrow(/D1_ERROR/);
        expect(s.calls, `${sql} ${m}`).toBe(1);
      }
    }
  });

  it("the login code claim counts a guess once", async () => {
    const s = new Script([d1Down(), { x: 1 }]);
    const db = retryingD1(fakeDb(s));
    await expect(
      db.prepare(LOGIN_CODE_CLAIM).bind("k", "r", "h").first(),
    ).rejects.toThrow(/D1_ERROR/);
    expect(s.calls).toBe(1);
  });

  it("never retries run(), even on a read-only statement", async () => {
    for (const sql of ["select 1", "insert into t values (1)"]) {
      const s = new Script([d1Down(), "ok"]);
      const st = retryingD1(fakeDb(s)).prepare(sql);
      await expect(st.run()).rejects.toThrow(/D1_ERROR/);
      await expect(
        retryingD1(fakeDb(new Script([d1Down()])))
          .prepare(sql)
          .bind(1)
          .run(),
      ).rejects.toThrow(/D1_ERROR/);
      expect(s.calls).toBe(1);
    }
  });

  it("a read that throws synchronously still throws synchronously", () => {
    const boom = new Error("D1_ERROR: free tier exceeded");
    const db = retryingD1({
      prepare: () => ({
        first: () => {
          throw boom;
        },
      }),
    } as unknown as D1Database);
    expect(() => db.prepare("select 1").first()).toThrow(boom);
  });

  it("batch() receives the statements the binding made, not the wrappers", async () => {
    const made: unknown[] = [];
    let got: unknown[] = [];
    const db = retryingD1({
      prepare: (sql: string) => {
        const s = new FakeStmt(sql, new Script());
        made.push(s);
        return s;
      },
      batch: async (x: unknown[]) => {
        got = x;
        return [];
      },
    } as unknown as D1Database);
    const read = db.prepare("select 1");
    const write = db.prepare("insert into t values (1)");
    await db.batch([read, write]);
    expect(read).not.toBe(made[0]);
    expect(got).toHaveLength(2);
    expect(got[0]).toBe(made[0]);
    expect(got[1]).toBe(made[1]);
  });

  it("never retries batch() or exec()", async () => {
    const s = new Script([d1Down(), "ok"]);
    const db = retryingD1(fakeDb(s));
    await expect(db.batch([db.prepare("select 1")])).rejects.toThrow(
      /D1_ERROR/,
    );
    expect(s.calls).toBe(1);
    const s2 = new Script([d1Down(), "ok"]);
    await expect(retryingD1(fakeDb(s2)).exec("select 1")).rejects.toThrow(
      /D1_ERROR/,
    );
    expect(s2.calls).toBe(1);
  });

  it("logs no SQL, params, keys or values", async () => {
    const s = new Script([d1Down(), d1Down(), d1Down()]);
    const db = retryingD1(fakeDb(s));
    await expect(
      db
        .prepare("select secret_col from t where k = ?")
        .bind("param-xyz")
        .first(),
    ).rejects.toThrow();
    const s2 = new Script([d1Down(), { v: "value-xyz" }]);
    await retryingD1(fakeDb(s2)).prepare("select v from t").first();
    clock += RETRY.breakerWindowMs; // 4 failures so far: keep it closed
    const kv = retryingKv(fakeKv(new Script([kvDown(), "value-abc"])));
    await kv.get("key-xyz");
    const all = logs.join("\n");
    expect(all).not.toMatch(
      /secret_col|param-xyz|value-xyz|key-xyz|value-abc|select/i,
    );
    for (const e of events())
      expect(Object.keys(e).sort()).toEqual(
        e.evt === "storage_read_gave_up"
          ? ["attempts", "evt", "reason", "store"]
          : e.evt === "storage_breaker_open"
            ? ["evt", "openMs"]
            : ["attempts", "evt", "store"],
      );
  });
});

// ------------------------------------------------------------ bounds

describe("bounds and jitter", () => {
  it("waits with full jitter under each doubling cap, under 300 ms", async () => {
    for (let seed = 1; seed <= 50; seed++) {
      resetBreaker();
      sleeps = [];
      setRetryDeps({
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: seeded(seed),
      });
      const s = new Script([d1Down(), d1Down(), d1Down()]);
      await expect(
        retryingD1(fakeDb(s)).prepare("select 1").first(),
      ).rejects.toThrow();
      expect(sleeps).toHaveLength(2);
      sleeps.forEach((ms, i) => {
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(RETRY.baseMs * 2 ** i);
      });
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(RETRY.maxWaitMs);
    }
  });

  it("the jitter is random, not the full delay", async () => {
    setRetryDeps({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });
    const s = new Script([d1Down(), d1Down(), "ok"]);
    await retryingD1(fakeDb(s)).prepare("select 1").first();
    expect(sleeps).toEqual([25, 50]);
  });

  it("one request waits at most 300 ms across all its reads", async () => {
    // The clock moves past the breaker window on every read, so only the
    // budget stops the waiting.
    setRetryDeps({
      now: () => (clock += RETRY.breakerWindowMs + 1),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.999,
    });
    let calls = 0;
    await withReadBudget(async () => {
      for (let i = 0; i < 10; i++) {
        const s = new Script([d1Down(), d1Down(), d1Down()]);
        await expect(
          retryingD1(fakeDb(s)).prepare("select 1").first(),
        ).rejects.toThrow();
        calls += s.calls;
      }
    });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      RETRY.maxWaitMs,
    );
    expect(calls).toBeLessThan(30);
    const budget = events().filter((e) => e.reason === "budget");
    expect(budget.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ breaker

describe("breaker", () => {
  it("opens after 5 storage failures in 10 s, and closes after 30 s", async () => {
    const a = new Script([d1Down(), d1Down(), d1Down()]);
    await expect(
      retryingD1(fakeDb(a)).prepare("select 1").first(),
    ).rejects.toThrow();
    expect(a.calls).toBe(3); // 3 failures
    expect(breakerOpen()).toBe(false);
    clock += 1_000;
    const b = new Script([d1Down(), d1Down(), d1Down()]);
    await expect(
      retryingD1(fakeDb(b)).prepare("select 1").first(),
    ).rejects.toThrow();
    expect(b.calls).toBe(2); // failures 4 and 5: open, no third try
    expect(breakerOpen()).toBe(true);
    expect(events().some((e) => e.evt === "storage_breaker_open")).toBe(true);
    expect(events().at(-1)).toMatchObject({ reason: "breaker", attempts: 2 });

    clock += RETRY.breakerOpenMs - 1_000;
    const c = new Script([d1Down(), "ok"]);
    await expect(
      retryingD1(fakeDb(c)).prepare("select 1").first(),
    ).rejects.toThrow();
    expect(c.calls).toBe(1); // open: fails at once
    const k = fakeKv(new Script([kvDown(), "v"]));
    await expect(retryingKv(k).get("x")).rejects.toThrow();
    expect(k.get).toHaveBeenCalledTimes(1);

    clock += 1_001; // 30 s after opening
    expect(breakerOpen()).toBe(false);
    const d = new Script([d1Down(), "ok"]);
    expect(await retryingD1(fakeDb(d)).prepare("select 1").first()).toBe("ok");
    expect(d.calls).toBe(2);
  });

  it("failures older than 10 s don't count", async () => {
    for (let i = 0; i < 8; i++) {
      const s = new Script([d1Down(), d1Down(), "ok"]);
      expect(await retryingD1(fakeDb(s)).prepare("select 1").first()).toBe(
        "ok",
      );
      expect(s.calls).toBe(3);
      clock += 5_001; // 2 failures per 5 s: at most 4 in any 10 s
    }
    expect(breakerOpen()).toBe(false);
  });
});

// ------------------------------------------------------------ memo / caches

describe("one wrapper per binding and env", () => {
  it("the same wrapper comes back for the same binding and env", () => {
    const db = E.DB;
    expect(retryingD1(db)).toBe(retryingD1(db));
    expect(retryingD1(retryingD1(db))).toBe(retryingD1(db));
    const w = withRetries(E);
    expect(withRetries(E)).toBe(w);
    expect(withRetries(w)).toBe(w);
    expect(w.DB).toBe(w.DB);
    expect(w.DB).toBe(retryingD1(db));
    expect(w.DB).not.toBe(db);
    expect(w.APP_HOST).toBe(E.APP_HOST);
    const kv = fakeKv(new Script());
    expect(retryingKv(kv)).toBe(retryingKv(kv));
    expect(retryingKv(retryingKv(kv))).toBe(retryingKv(kv));
  });

  it("stmt()'s cache still hits through the wrapper", () => {
    const sql = "select 1 as one";
    const a = stmt(withRetries(E).DB, sql);
    const b = stmt(withRetries(E).DB, sql);
    expect(a).toBe(b);
    // The cached statement is the patched one.
    expect(Object.hasOwn(a, "first")).toBe(true);
  });

  it("an env spread past the wrapper keeps the wrapped bindings", () => {
    const spread = { ...withRetries(E) };
    expect(spread.DB).toBe(retryingD1(E.DB));
  });
});

// ------------------------------------------------------------ real D1

describe("real D1 through the wrapper", () => {
  it("read-only statements stay real statements and batch() accepts them", async () => {
    const db = withRetries(E).DB;
    await db.exec(
      "create table if not exists rr_t (id integer primary key, v text)",
    );
    await db.prepare("delete from rr_t").run();
    const read = stmt(db, "select v from rr_t where id = ?");
    expect(Object.hasOwn(read, "first")).toBe(true);
    const bound = read.bind(1);
    expect(Object.hasOwn(bound, "first")).toBe(true);
    const res = await db.batch([
      db.prepare("insert into rr_t (id, v) values (?, ?)").bind(1, "a"),
      db
        .prepare("insert into rr_t (id, v) values (?, ?) returning id")
        .bind(2, "b"),
      bound,
      stmt(db, "select count(*) as n from rr_t"),
    ]);
    expect(res[1]?.results).toEqual([{ id: 2 }]);
    expect(res[2]?.results).toEqual([{ v: "a" }]);
    expect(res[3]?.results).toEqual([{ n: 2 }]);
    expect(await read.bind(2).first("v")).toBe("b");
    expect(await read.bind(2).raw()).toEqual([["b"]]);
    expect((await read.bind(1).all()).results).toEqual([{ v: "a" }]);
    // A plain error from real D1 is not retried and comes through as is.
    await expect(db.prepare("select nope from rr_t").first()).rejects.toThrow(
      /no such column/,
    );
  });

  it("leaves the real statement alone, and works over proxied statements", async () => {
    // A binding whose statements are Proxies (as the counting test doubles
    // are): patching them in place would recurse.
    let reads = 0;
    const proxied = new Proxy(E.DB, {
      get(t, p) {
        if (p !== "prepare") {
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        }
        const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(s, {
            get(st, q) {
              if (q === "bind") return (...a: unknown[]) => wrap(st.bind(...a));
              const v = Reflect.get(st, q, st);
              if (q === "first") reads++;
              return typeof v === "function" ? v.bind(st) : v;
            },
          });
        return (sql: string) => wrap(t.prepare(sql));
      },
    });
    const db = retryingD1(proxied);
    expect(await db.prepare("select ? as v").bind(3).first("v")).toBe(3);
    expect(reads).toBe(1);
    const raw = E.DB.prepare("select 1 as one");
    const wrapped = retryingD1(E.DB).prepare("select 1 as one");
    expect(Object.hasOwn(raw, "first")).toBe(false);
    expect(wrapped).not.toBe(raw);
  });
});

// ------------------------------------------------------------ kv

describe("KV", () => {
  it("get retries, text and json forms", async () => {
    const s = new Script([kvDown(), "v", kvDown(), { a: 1 }]);
    const kv = fakeKv(s);
    const w = retryingKv(kv);
    expect(await w.get("k")).toBe("v");
    expect(await w.get("k", "json")).toEqual({ a: 1 });
    expect(kv.get).toHaveBeenCalledTimes(4);
    expect(kv.get).toHaveBeenLastCalledWith("k", "json");
  });

  it("put, delete and list never retry", async () => {
    for (const [op, call] of [
      ["PUT", (w: KVNamespace) => w.put("k", "v")],
      ["DELETE", (w: KVNamespace) => w.delete("k")],
      ["LIST", (w: KVNamespace) => w.list({ prefix: "p" })],
    ] as const) {
      const s = new Script([kvDown(op), "ok"]);
      await expect(call(retryingKv(fakeKv(s)))).rejects.toThrow(/KV/);
      expect(s.calls, op).toBe(1);
    }
  });

  it("the OAuth store seam retries its KV gets (kv mode)", async () => {
    const s = new Script([kvDown(), "grant"]);
    const kv = fakeKv(s);
    const store = oauthEnv({ ...E, OAUTH_STORE: "kv", OAUTH_KV: kv }).OAUTH_KV;
    expect(await store.get("grant:x")).toBe("grant");
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("the OAuth store seam retries its KV gets (dual mode, on a D1 miss)", async () => {
    const s = new Script([kvDown(), "grant"]);
    const kv = fakeKv(s);
    const store = oauthEnv({
      ...E,
      OAUTH_STORE: "dual",
      OAUTH_KV: kv,
    }).OAUTH_KV;
    expect(await store.get("rr:missing-in-d1")).toBe("grant");
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("the env wrapper's OAUTH_KV retries get", async () => {
    const s = new Script([kvDown(), "v"]);
    const kv = fakeKv(s);
    const w = withRetries({ OAUTH_KV: kv } as { OAUTH_KV: KVNamespace });
    expect(await w.OAUTH_KV.get("k")).toBe("v");
    expect(kv.get).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------ real D1

// The statements are Object.create(real), not the real objects. Real workerd
// D1, not a fake: every method still works on them, including the ones the
// wrapper doesn't define (run), and batch() takes them.
describe("a wrapped read statement under real workerd D1", () => {
  it("run, first, all, raw and batch all work", async () => {
    const db = retryingD1(E.DB);
    const s = db.prepare("select ?1 as n");
    const bound = s.bind(7);
    expect(Object.getPrototypeOf(bound)).not.toBe(Object.prototype);
    const run = await bound.run<{ n: number }>();
    expect(run.success).toBe(true);
    expect(run.results).toEqual([{ n: 7 }]);
    expect(await bound.first<{ n: number }>()).toEqual({ n: 7 });
    expect((await bound.all<{ n: number }>()).results).toEqual([{ n: 7 }]);
    expect(await bound.raw()).toEqual([[7]]);
    const unbound = db.prepare("select 1 as one");
    expect((await unbound.run()).results).toEqual([{ one: 1 }]);
    const out = await db.batch([bound, db.prepare("select 2 as two")]);
    expect(out.map((r) => r.results)).toEqual([[{ n: 7 }], [{ two: 2 }]]);
    // An unwrapped batch() given a wrapped statement: real D1 takes it too.
    const raw = await E.DB.batch([bound]);
    expect(raw[0]?.results).toEqual([{ n: 7 }]);
  });
});

// ------------------------------------------------------------ entry points

describe("Durable Objects read through the wrapper", () => {
  it("ArtifactRuntime", async () => {
    const ns = E.ARTIFACT_RUNTIME;
    const stub = ns.get(ns.idFromName("rr-artifact"));
    await runInDurableObject(stub, (i) => {
      const env = (i as unknown as { env: Env }).env;
      // Already the wrapper: wrapping it again is a no-op.
      expect(retryingD1(env.DB)).toBe(env.DB);
      expect(withRetries(env)).toBe(env);
    });
  });

  it("DirectorySync", async () => {
    const ns = E.DIRECTORY_SYNC;
    if (!ns) return;
    const stub = ns.get(ns.idFromName("rr-directory"));
    await runInDurableObject(stub, (i) => {
      const env = (i as unknown as { env: Env }).env;
      expect(retryingD1(env.DB)).toBe(env.DB);
      expect(withRetries(env)).toBe(env);
    });
  });
});

/**
 * Real D1 whose next `failures` reads (first/all/raw) fail with a storage
 * error; statements stay real, so batch() still works.
 */
function flakyD1(db: D1Database, failures: number): D1Database {
  let left = failures;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const rec = s as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["first", "all", "raw"]) {
      const orig = rec[m] as (...a: unknown[]) => unknown;
      rec[m] = (...a: unknown[]) => {
        if (left > 0) {
          left--;
          return Promise.reject(d1Down());
        }
        return orig.apply(s, a);
      };
    }
    const bind = rec.bind as (...a: unknown[]) => D1PreparedStatement;
    rec.bind = (...a: unknown[]) => wrap(bind.apply(s, a));
    return s;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (x: D1PreparedStatement[]) => db.batch(x),
    exec: (q: string) => db.exec(q),
  } as unknown as D1Database;
}

describe("the Worker's fetch reads through the wrapper", () => {
  it("a read that fails once still answers (/healthz's markers read)", async () => {
    const res = await fetchAndWait(
      worker as unknown as Parameters<typeof fetchAndWait>[0],
      new Request(`https://${E.APP_HOST}/healthz`),
      { ...E, DB: flakyD1(E.DB, 1) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oauthStore: unknown };
    expect(body.oauthStore).not.toBeNull();
    expect(events().filter((e) => e.evt === "storage_read_retry_ok")).toEqual([
      { evt: "storage_read_retry_ok", store: "d1", attempts: 2 },
    ]);
  });
});
