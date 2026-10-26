import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import scheduler, {
  CRON,
  type Env,
  nightly,
  nightOrder,
  runNightly,
} from "../src/index.js";

// P1 Task 7 (Review Focus 5): one install's nightly job throwing or timing
// out must not stop the others. PLATFORM_DB is a local D1 with the real
// platform migrations; DISPATCHER is a fake that records every script asked
// for and each scheduled() call.

const db = (testEnv as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM installs").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type State = "creating" | "active" | "upgrading" | "deleting" | "deleted";

/** A valid install id for n: "i" + 11 base32-ish chars. */
const idOf = (n: number) => `i${n.toString(36).padStart(11, "0")}`;

async function seed(rows: { id: string; state: State; leaseUntil?: number }[]) {
  const ins = db.prepare(
    `INSERT INTO installs (id, slug, app_host, content_host, owner_email, rl_ns,
       inputs_hash, state, created_at, updated_at, lease_until)
     VALUES (?1, ?2, ?2 || '.app.test', ?2 || '.content.test', ?3, ?4, 'h', ?5, 0, 0, ?6)`,
  );
  const stmts = rows.map((r, i) =>
    ins.bind(
      r.id,
      `s${i}`,
      `owner${i}@customer.test`,
      (i + 1) * 8,
      r.state,
      r.leaseUntil ?? null,
    ),
  );
  for (let i = 0; i < stmts.length; i += 100)
    await db.batch(stmts.slice(i, i + 100));
}

type Behavior =
  | "ok"
  | "throw"
  | "hang"
  | "outcome"
  | "canceled"
  | "missing"
  | "scriptNotFound"
  | { result: unknown };

const n36 = (script: string) => Number.parseInt(script.slice(-11), 36);

function fakes(
  oaEnv: "staging" | "prod" = "staging",
  behave: (script: string) => Behavior = () => "ok",
  delayMs = 0,
  onCall: (script: string) => Promise<void> | void = () => {},
) {
  const scripts: string[] = [];
  const calls: { script: string; opts: unknown }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const env = {
    OA_ENV: oaEnv,
    PLATFORM_DB: db,
    DISPATCHER: {
      get(script: string) {
        // Lazy, like the real binding: a missing script fails on the call.
        scripts.push(script);
        const b = behave(script);
        return {
          async scheduled(opts: unknown) {
            calls.push({ script, opts });
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              await onCall(script);
              if (b === "missing")
                throw new Error(
                  `Worker not found: ${script} owner@customer.test`,
                );
              if (b === "scriptNotFound")
                return { outcome: "scriptNotFound", noRetry: true };
              if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
              if (b === "hang") await new Promise(() => {});
              if (b === "throw")
                throw new Error(
                  "boom for owner@customer.test at https://acme.open-artifacts.app/c/123.sig/x SECRET=x",
                );
              if (typeof b === "object") return b.result;
              if (b === "outcome")
                return { outcome: "exception", noRetry: false };
              if (b === "canceled")
                return { outcome: "canceled", noRetry: false };
              // Measured on staging: a handler that succeeds resolves to
              // undefined; one that throws rejects with its own error.
              return undefined;
            } finally {
              inFlight--;
            }
          },
        };
      },
    },
  } as unknown as Env;
  return {
    env,
    scripts,
    calls,
    max: () => maxInFlight,
    inFlight: () => inFlight,
  };
}

function captureLogs() {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(rec);
  vi.spyOn(console, "warn").mockImplementation(rec);
  vi.spyOn(console, "error").mockImplementation(rec);
  vi.spyOn(console, "info").mockImplementation(rec);
  return lines;
}

const NOW = Date.UTC(2026, 9, 24, 3, 17);

/** The whole log vocabulary: install ids, fixed categories and counts. */
const LOG_LINE =
  /^(?:nightly failed (?:timeout|not_found|canceled|exception) i[a-z0-9]{11}|nightly skipped (?:state|deadline|capped|recheck|db_error) i[a-z0-9]{11}|nightly db_error i[a-z0-9]{11}|nightly leaked i[a-z0-9]{11}|nightly summary active=\d+ ok=\d+ failed=\d+ skipped=\d+ capped=\d+ db_errors=\d+ leaked=\d+|nightly invalid ids=\d+|nightly scale active=\d+ over 300|nightly aborted (?:env|exception)|email-quota skipped (?:no_token|config)|email-quota failed (?:http|graphql|timeout|shape)|email-quota (?:ok|warn) sent=\d+ limit=\d+ pct=\d+|directory-revoke (?:done|unsupported|retry|failed|db_error) i[a-z0-9]{11}|directory-revoke invalid ids=\d+|directory-revoke aborted exception|owner-email purged count=\d+|owner-email failed db)$/;

const DAY = 86_400_000;
const GOLDEN = 0.3819660112501051;
const frac = (x: number) => x - Math.floor(x);
const NONE = { capped: [], dbErrors: [], leaked: [] };

/** PLATFORM_DB with the per-call re-check (only) replaced for some ids. */
function recheckDb(
  behave: (id: string) => "ok" | "throw" | "stall",
): D1Database {
  return new Proxy(db, {
    get(t, k) {
      if (k !== "prepare") return Reflect.get(t, k);
      return (sql: string) => {
        const st = t.prepare(sql);
        if (!sql.startsWith("SELECT 1 AS ok")) return st;
        return {
          bind: (id: string, ...rest: unknown[]) => {
            const b = behave(id);
            const real = st.bind(id, ...rest);
            return {
              first: () =>
                b === "throw"
                  ? Promise.reject(new Error(`D1_ERROR for ${id}`))
                  : b === "stall"
                    ? new Promise(() => {})
                    : real.first(),
            };
          },
        };
      };
    },
  }) as D1Database;
}

const ids = (n: number, state: State = "active") =>
  Array.from({ length: n }, (_, k) => ({ id: idOf(k), state }));

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tonight's call order for ids(n), as runNightly will use it. */
const night = (n: number, now: number) =>
  nightOrder(
    ids(n).map((x) => x.id),
    now,
  );
/** The install id of a script name (oa-s-<id>). */
const idIn = (script: string) => script.slice("oa-s-".length);

describe("runNightly", () => {
  it("runs every active install and skips creating, upgrading and deleting ones", async () => {
    const states: State[] = [
      "creating",
      "active",
      "upgrading",
      "active",
      "deleting",
      "deleted",
      "active",
    ];
    await seed(states.map((state, i) => ({ id: idOf(i), state })));
    const f = fakes();
    const r = await runNightly(f.env, NOW);
    const active = [idOf(1), idOf(3), idOf(6)];
    expect([...r.ok].sort()).toEqual(active);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect([...f.scripts].sort()).toEqual(active.map((id) => `oa-s-${id}`));
    for (const c of f.calls)
      expect(c.opts).toEqual({
        cron: "17 3 * * *",
        scheduledTime: new Date(NOW),
      });
    expect(CRON).toBe("17 3 * * *");
  });

  it("one install throwing or timing out doesn't stop the others; it's reported in failed", async () => {
    await seed(
      [0, 1, 2, 3, 4, 5].map((n) => ({ id: idOf(n), state: "active" })),
    );
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(1)}`]: "throw",
      [`oa-s-${idOf(2)}`]: "hang",
      [`oa-s-${idOf(3)}`]: "missing",
      [`oa-s-${idOf(4)}`]: "outcome",
    };
    const f = fakes("staging", (s) => by[s] ?? "ok");
    const r = await runNightly(f.env, NOW, { concurrency: 2, timeoutMs: 30 });
    expect([...r.ok].sort()).toEqual([idOf(0), idOf(5)]);
    expect(r.skipped).toEqual([]);
    expect([...r.failed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: idOf(1), reason: "exception" },
      { id: idOf(2), reason: "timeout" },
      { id: idOf(3), reason: "not_found" },
      { id: idOf(4), reason: "exception" },
    ]);
    // Reasons are fixed categories, never error text.
    for (const x of r.failed)
      expect(["timeout", "not_found", "exception"]).toContain(x.reason);
  });

  it('resolving is ok (undefined or outcome "ok"); any other result fails closed', async () => {
    const results: Behavior[] = [
      "ok",
      "outcome",
      "canceled",
      { result: { outcome: "ok", noRetry: false } },
      { result: null },
      { result: {} },
      { result: { outcome: "OK", noRetry: false } },
      { result: { outcome: 1, noRetry: false } },
      { result: "ok" },
      "scriptNotFound",
      { result: { outcome: "exceededCpu", noRetry: false } },
    ];
    await seed(results.map((_, n) => ({ id: idOf(n), state: "active" })));
    const f = fakes(
      "staging",
      (s) => results[Number.parseInt(s.slice(-11), 36)] as Behavior,
    );
    const r = await runNightly(f.env, NOW);
    expect([...r.ok].sort()).toEqual([idOf(0), idOf(3)]);
    expect([...r.failed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: idOf(1), reason: "exception" },
      { id: idOf(2), reason: "canceled" },
      ...[4, 5, 6, 7, 8].map((n) => ({ id: idOf(n), reason: "exception" })),
      { id: idOf(9), reason: "not_found" },
      { id: idOf(10), reason: "exception" },
    ]);
  });

  it("the timeout is real: a never-resolving install fails at timeoutMs (default 25 s)", async () => {
    await seed([{ id: idOf(0), state: "active" }]);
    const f = fakes("staging", () => "hang");
    vi.useFakeTimers();
    let done: Awaited<ReturnType<typeof runNightly>> | undefined;
    const p = runNightly(f.env, NOW).then((r) => {
      done = r;
    });
    // Let the D1 read and the call start before moving the clock (vi.waitFor
    // would advance the fake clock itself; a D1 round trip is real I/O).
    for (let k = 0; k < 100 && f.calls.length === 0; k++)
      await db.prepare("SELECT 1").first();
    expect(f.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toEqual({
      ok: [],
      failed: [{ id: idOf(0), reason: "timeout" }],
      skipped: [],
      capped: [],
      dbErrors: [],
      // Never settles: leaked when the run ends.
      leaked: [idOf(0)],
    });
  });

  it("respects the concurrency limit (default 6: the shared connection limit)", async () => {
    await seed(ids(35));
    const f = fakes("staging", () => "ok", 5);
    const r = await runNightly(f.env, NOW);
    expect(r.ok).toHaveLength(35);
    expect(f.max()).toBeLessThanOrEqual(6);
    expect(f.max()).toBe(6);
  });

  it("a timed-out call keeps its lane until it settles: never-settling installs can't over-subscribe", async () => {
    await seed(ids(10));
    const o = await night(10, NOW);
    const f = fakes("staging", () => "hang");
    const r = await runNightly(f.env, NOW, {
      concurrency: 3,
      timeoutMs: 20,
      deadlineMs: 300,
      recheckFloorMs: 1,
    });
    // Three calls hold the three lanes forever; nothing else is started.
    expect(f.calls).toHaveLength(3);
    expect(f.max()).toBe(3);
    expect(r.failed).toEqual(
      o.slice(0, 3).map((id) => ({ id, reason: "timeout" })),
    );
    expect(r.ok).toEqual([]);
    expect(r.skipped).toEqual(o.slice(3));
  });

  it("timed-out calls still count against the cap while the others run", async () => {
    await seed(ids(12));
    const f = fakes("staging", (s) => (n36(s) < 2 ? "hang" : "ok"), 5);
    const r = await runNightly(f.env, NOW, { concurrency: 3, timeoutMs: 20 });
    expect(f.max()).toBe(3);
    expect([...r.failed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: idOf(0), reason: "timeout" },
      { id: idOf(1), reason: "timeout" },
    ]);
    expect(r.ok).toHaveLength(10);
  });

  it("respects a concurrency limit of 3", async () => {
    await seed(
      Array.from({ length: 12 }, (_, n) => ({ id: idOf(n), state: "active" })),
    );
    const f = fakes("staging", () => "ok", 5);
    const r = await runNightly(f.env, NOW, { concurrency: 3 });
    expect(r.ok).toHaveLength(12);
    expect(f.max()).toBe(3);
  });

  it("zero installs is a no-op", async () => {
    await seed([{ id: idOf(0), state: "creating" }]);
    const f = fakes();
    expect(await runNightly(f.env, NOW)).toEqual({
      ok: [],
      failed: [],
      skipped: [],
      ...NONE,
    });
    expect(f.scripts).toEqual([]);
  });

  it("an invalid id in the DB is skipped with no call", async () => {
    await seed([
      { id: idOf(0), state: "active" },
      { id: "../oa-p-other", state: "active" },
      { id: "IABC123DEF45", state: "active" },
      { id: "iabc123def45x", state: "active" },
    ]);
    const lines = captureLogs();
    const f = fakes();
    const r = await runNightly(f.env, NOW);
    expect(r).toEqual({ ok: [idOf(0)], failed: [], skipped: [], ...NONE });
    // A count only: the bad value itself is never logged.
    expect(lines).toEqual(["nightly invalid ids=3"]);
    expect(f.scripts).toEqual([`oa-s-${idOf(0)}`]);
  });

  it("uses the env prefix of OA_ENV", async () => {
    await seed([{ id: idOf(7), state: "active" }]);
    const p = fakes("prod");
    await runNightly(p.env, NOW);
    expect(p.scripts).toEqual([`oa-p-${idOf(7)}`]);
    const s = fakes("staging");
    await runNightly(s.env, NOW);
    expect(s.scripts).toEqual([`oa-s-${idOf(7)}`]);
  });

  it("an unknown OA_ENV calls nothing", async () => {
    await seed([{ id: idOf(0), state: "active" }]);
    const f = fakes("dev" as "prod");
    await expect(runNightly(f.env, NOW)).rejects.toThrow();
    expect(f.scripts).toEqual([]);
  });

  it("pages through the installs table, each active install once", async () => {
    await seed(
      Array.from({ length: 23 }, (_, n) => ({
        id: idOf(n),
        state: n % 5 === 0 ? "upgrading" : "active",
      })),
    );
    const f = fakes();
    const r = await runNightly(f.env, NOW, { pageSize: 4 });
    const want = Array.from({ length: 23 }, (_, n) => n)
      .filter((n) => n % 5 !== 0)
      .map(idOf);
    expect([...r.ok].sort()).toEqual(want);
    expect(new Set(f.scripts).size).toBe(f.scripts.length);
  });

  it("pages through an exact multiple of the page size (empty last page)", async () => {
    await seed(ids(8));
    const f = fakes();
    const r = await runNightly(f.env, NOW, { pageSize: 4 });
    expect([...r.ok].sort()).toEqual(ids(8).map((x) => x.id));
    expect(f.scripts).toHaveLength(8);
  });

  it("re-checks each install right before its call: one that left active or took a lease is skipped", async () => {
    await seed(ids(5));
    const o = await night(5, NOW);
    // During the first call, the next three in tonight's order change.
    const flipped = async (script: string) => {
      if (idIn(script) !== o[0]) return;
      await db
        .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
        .bind(o[1])
        .run();
      await db
        .prepare("UPDATE installs SET state = 'deleting' WHERE id = ?")
        .bind(o[2])
        .run();
      await db
        .prepare("UPDATE installs SET lease_until = ? WHERE id = ?")
        .bind(Date.now() + 60_000, o[3])
        .run();
    };
    const lines = captureLogs();
    const f = fakes("staging", () => "ok", 0, flipped);
    const r = await runNightly(f.env, NOW, { concurrency: 1 });
    expect(r.ok).toEqual([o[0], o[4]]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([o[1], o[2], o[3]]);
    expect(f.calls.map((c) => idIn(c.script))).toEqual([o[0], o[4]]);
    expect(lines).toEqual(
      [1, 2, 3].map((k) => `nightly skipped state ${o[k]}`),
    );
  });

  it("an expired lease doesn't block the call", async () => {
    await seed([{ id: idOf(0), state: "active", leaseUntil: Date.now() - 1 }]);
    const f = fakes();
    expect((await runNightly(f.env, NOW)).ok).toEqual([idOf(0)]);
  });

  it("an install already leased at read time is skipped", async () => {
    await seed([
      { id: idOf(0), state: "active", leaseUntil: Date.now() + 60_000 },
      { id: idOf(1), state: "active" },
    ]);
    const f = fakes();
    const r = await runNightly(f.env, NOW);
    expect(r).toEqual({
      ok: [idOf(1)],
      failed: [],
      skipped: [idOf(0)],
      ...NONE,
    });
  });

  it("stops dispatching at deadlineMs; the rest is skipped and never called", async () => {
    await seed(ids(10));
    const f = fakes("staging", () => "ok", 40);
    const r = await runNightly(f.env, NOW, {
      concurrency: 1,
      deadlineMs: 100,
      recheckFloorMs: 1,
    });
    expect(r.failed).toEqual([]);
    expect(r.ok.length).toBeGreaterThanOrEqual(1);
    expect(r.skipped.length).toBeGreaterThanOrEqual(5);
    expect([...r.ok, ...r.skipped]).toEqual(await night(10, NOW));
    expect(f.calls).toHaveLength(r.ok.length);
  });

  it("past the re-check floor, the rest is skipped without recursing through every install", async () => {
    // Skipping each install in its own run() recursed synchronously
    // (finally -> release -> pump -> run), one stack level per install.
    await seed(ids(20_000));
    const f = fakes();
    const r = await runNightly(f.env, NOW, {
      concurrency: 6,
      deadlineMs: 1_000,
      recheckFloorMs: 5_000,
    });
    expect(f.calls).toHaveLength(0);
    expect(r.ok).toEqual([]);
    expect(r.skipped).toEqual(await night(20_000, NOW));
  }, 60_000);

  it("logs each skipped id with its reason", async () => {
    await seed(ids(6));
    const lines = captureLogs();
    const f = fakes("staging", () => "ok", 40);
    const r = await runNightly(f.env, 0, {
      concurrency: 1,
      deadlineMs: 60,
      recheckFloorMs: 1,
    });
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("nightly skipped"))).toEqual(
      r.skipped.map((id) => `nightly skipped deadline ${id}`),
    );
  });

  it("six hanging installs at the head no longer starve the rest: a stuck call frees its lane after leakMs and counts as leaked", async () => {
    await seed(ids(26));
    const lines = captureLogs();
    // The first six in tonight's order hang.
    const head = (await night(26, 0)).slice(0, 6);
    const f = fakes("staging", (s) => (head.includes(idIn(s)) ? "hang" : "ok"));
    const r = await runNightly(f.env, 0, {
      timeoutMs: 20,
      leakMs: 30,
      deadlineMs: 5_000,
    });
    expect(r.ok).toHaveLength(20);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toEqual(head.map((id) => ({ id, reason: "timeout" })));
    expect(r.leaked).toEqual(head);
    for (const id of head) expect(lines).toContain(`nightly leaked ${id}`);
  });

  it("within leakMs a stuck call still holds its lane (the cap holds)", async () => {
    await seed(ids(8));
    const head = (await night(8, 0)).slice(0, 2);
    const f = fakes(
      "staging",
      (s) => (head.includes(idIn(s)) ? "hang" : "ok"),
      5,
    );
    const r = await runNightly(f.env, 0, {
      concurrency: 2,
      timeoutMs: 20,
      leakMs: 200,
    });
    expect(r.ok).toHaveLength(6);
    // Nothing else started until the two stuck calls were given up as leaked.
    const firstOk = f.calls.findIndex((c) => !head.includes(idIn(c.script)));
    expect(firstOk).toBe(2);
    expect(r.leaked).toEqual(head);
  });

  it("caps unsettled calls (in-lane plus leaked) at 2 × concurrency", async () => {
    await seed(ids(30));
    const lines = captureLogs();
    const f = fakes("staging", () => "hang");
    const r = await runNightly(f.env, 0, {
      timeoutMs: 10,
      leakMs: 10,
      deadlineMs: 400,
      recheckFloorMs: 1,
    });
    // Every call hangs, so each one stays unsettled: the fake's max in flight
    // is the number of unsettled calls the scheduler ever allowed.
    expect(f.max()).toBe(12);
    expect(f.calls).toHaveLength(12);
    expect(r.failed).toHaveLength(12);
    expect(r.leaked).toHaveLength(12);
    expect(r.skipped).toHaveLength(18);
    // Held back by the unsettled cap, not by the deadline itself.
    expect(r.capped).toEqual(r.skipped);
    expect(
      lines.filter((l) => l.startsWith("nightly skipped capped")),
    ).toHaveLength(18);
    expect(lines.some((l) => l.startsWith("nightly skipped deadline"))).toBe(
      false,
    );
  });

  it("work still waiting on free lanes at the deadline is deadline, not capped", async () => {
    await seed(ids(6));
    captureLogs();
    const f = fakes("staging", () => "hang");
    const r = await runNightly(f.env, 0, {
      concurrency: 2,
      timeoutMs: 1_000,
      deadlineMs: 100,
      recheckFloorMs: 1,
    });
    expect(r.capped).toEqual([]);
    expect(r.skipped).toHaveLength(4);
  });

  it("caps unsettled calls at 2 × a custom concurrency, and resumes when one settles", async () => {
    await seed(ids(10));
    captureLogs();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const f = fakes(
      "staging",
      () => "ok",
      0,
      async () => {
        // The first four calls wait on the gate; the rest return at once.
        if (n++ < 4) await gate;
      },
    );
    const p = runNightly(f.env, 0, {
      concurrency: 2,
      timeoutMs: 10,
      leakMs: 10,
    });
    await realSleep(150);
    expect(f.calls).toHaveLength(4);
    release();
    const r = await p;
    expect(f.max()).toBeLessThanOrEqual(4);
    expect(r.skipped).toEqual([]);
    expect(f.calls).toHaveLength(10);
  });

  it("a hanging platform D1: stalled re-checks count toward the stop like db_errors", async () => {
    await seed(ids(10));
    const lines = captureLogs();
    const f = fakes();
    const env = { ...f.env, PLATFORM_DB: recheckDb(() => "stall") } as Env;
    const o = await night(10, 0);
    const t0 = Date.now();
    const r = await nightly(env, 0, { concurrency: 1, recheckMs: 20 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(f.calls).toEqual([]);
    expect(r.dbErrors).toEqual([]);
    expect(r.skipped).toEqual(o);
    expect(lines.filter((l) => l.startsWith("nightly skipped"))).toEqual([
      ...o.slice(0, 3).map((id) => `nightly skipped recheck ${id}`),
      ...o.slice(3).map((id) => `nightly skipped db_error ${id}`),
    ]);
  });

  it("a mix of stalls and D1 errors in a row trips the stop", async () => {
    await seed(ids(6));
    const o = await night(6, 0);
    const f = fakes();
    const by: Record<string, "stall" | "throw"> = {
      [o[0] as string]: "stall",
      [o[1] as string]: "throw",
      [o[2] as string]: "stall",
    };
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => by[id] ?? "ok"),
    } as Env;
    const r = await runNightly(env, 0, { concurrency: 1, recheckMs: 20 });
    expect(r.dbErrors).toEqual([o[1]]);
    expect(r.skipped).toEqual([o[0], o[2], ...o.slice(3)]);
    expect(f.calls).toEqual([]);
  });

  it("calls installs in nightOrder's order, which moves each UTC day", async () => {
    await seed(ids(5));
    const order = async (day: number) => {
      const f = fakes();
      await runNightly(f.env, day * DAY + 3_600_000, { concurrency: 1 });
      return f.calls.map((c) => idIn(c.script));
    };
    for (const day of [0, 1, 7])
      expect(await order(day)).toEqual(await night(5, day * DAY));
    expect(await order(1)).not.toEqual(await order(0));
  });

  it("a different day gives a starved tail its turn", async () => {
    await seed(ids(12));
    const ran = new Set<string>();
    for (const day of [0, 1, 2, 3, 4, 5]) {
      const f = fakes("staging", () => "ok", 30);
      const r = await runNightly(f.env, day * DAY, {
        concurrency: 1,
        deadlineMs: 70,
        recheckFloorMs: 1,
      });
      for (const id of r.ok) ran.add(id);
    }
    expect(ran.size).toBeGreaterThan(6);
  });

  it("a stalled re-check is skipped after recheckMs, not an unbounded wait", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes();
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => (id === idOf(1) ? "stall" : "ok")),
    } as Env;
    const r = await runNightly(env, 0, { recheckMs: 30 });
    expect([...r.ok].sort()).toEqual([idOf(0), idOf(2)]);
    expect(r.skipped).toEqual([idOf(1)]);
    expect(r.failed).toEqual([]);
    expect(lines).toEqual([`nightly skipped recheck ${idOf(1)}`]);
  });

  it("with less than recheckFloorMs (1 s) left, no re-check starts: skipped deadline", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes();
    let started = 0;
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb(() => {
        started++;
        return "ok";
      }),
    } as Env;
    const r = await runNightly(env, 0, { deadlineMs: 800 });
    expect(started).toBe(0);
    expect(f.calls).toEqual([]);
    expect(r.dbErrors).toEqual([]);
    expect([...r.skipped].sort()).toEqual(ids(3).map((x) => x.id));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/^nightly skipped deadline /);
  });

  it("a re-check cut short by the deadline is deadline, never a stall, and doesn't count toward the stop", async () => {
    await seed(ids(5));
    const lines = captureLogs();
    const f = fakes();
    const env = { ...f.env, PLATFORM_DB: recheckDb(() => "stall") } as Env;
    const t0 = Date.now();
    // 1.2 s left is over the 1 s floor but under recheckMs: the deadline bounds it.
    const r = await nightly(env, 0, { deadlineMs: 1_200, recheckMs: 5_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(f.calls).toEqual([]);
    expect(r.dbErrors).toEqual([]);
    expect(r.skipped).toHaveLength(5);
    const skips = lines.filter((l) => l.startsWith("nightly skipped"));
    expect(skips).toHaveLength(5);
    for (const l of skips) expect(l).toMatch(/^nightly skipped deadline /);
  });

  it("a D1 error on the re-check is db_error, never blamed on the install", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes();
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => (id === idOf(1) ? "throw" : "ok")),
    } as Env;
    const r = await runNightly(env, 0, { concurrency: 1 });
    expect(r.ok).toEqual([idOf(0), idOf(2)]);
    expect(r.failed).toEqual([]);
    expect(r.dbErrors).toEqual([idOf(1)]);
    expect(lines).toEqual([`nightly db_error ${idOf(1)}`]);
    expect(lines.join("\n")).not.toMatch(/D1_ERROR/);
  });

  it("three consecutive db_errors stop dispatching; the rest is skipped and the summary still lands", async () => {
    await seed(ids(10));
    const lines = captureLogs();
    const f = fakes();
    const env = { ...f.env, PLATFORM_DB: recheckDb(() => "throw") } as Env;
    const o = await night(10, 0);
    const r = await nightly(env, 0, { concurrency: 1 });
    expect(r.dbErrors).toEqual(o.slice(0, 3));
    expect(r.skipped).toEqual(o.slice(3));
    expect(f.calls).toEqual([]);
    expect(lines.at(-1)).toBe(
      "nightly summary active=10 ok=0 failed=0 skipped=7 capped=0 db_errors=3 leaked=0",
    );
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("a successful re-check resets the db_error streak", async () => {
    await seed(ids(7));
    const o = await night(7, 0);
    const f = fakes();
    const bad = new Set([0, 1, 3, 4, 6].map((k) => o[k] as string));
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => (bad.has(id) ? "throw" : "ok")),
    } as Env;
    const r = await runNightly(env, 0, { concurrency: 1 });
    expect(r.dbErrors).toEqual([...bad]);
    expect(r.ok).toEqual([o[2], o[5]]);
    expect(r.skipped).toEqual([]);
  });

  it("logs each failure when it happens, not at the end", async () => {
    await seed(ids(2));
    const lines = captureLogs();
    const f = fakes("staging", (s) => (n36(s) === 0 ? "throw" : "hang"));
    let done = false;
    const p = runNightly(f.env, NOW, { timeoutMs: 400 }).then((r) => {
      done = true;
      return r;
    });
    for (let k = 0; k < 50 && lines.length === 0; k++) await realSleep(5);
    expect(lines).toEqual([`nightly failed exception ${idOf(0)}`]);
    expect(done).toBe(false);
    await p;
    expect(lines).toEqual([
      `nightly failed exception ${idOf(0)}`,
      `nightly failed timeout ${idOf(1)}`,
      // Still unsettled when the run ended.
      `nightly leaked ${idOf(1)}`,
    ]);
  });

  it("refuses bad options before reading or calling anything", async () => {
    await seed(ids(1));
    const f = fakes();
    for (const o of [
      { concurrency: 0 },
      { concurrency: -1 },
      { concurrency: 1.5 },
      { concurrency: Number.NaN },
      { concurrency: Number.POSITIVE_INFINITY },
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { deadlineMs: 0 },
      { deadlineMs: Number.NaN },
      { pageSize: 0 },
      { pageSize: 2.5 },
      { leakMs: 0 },
      { leakMs: Number.NaN },
      { recheckMs: 0 },
      { recheckMs: Number.POSITIVE_INFINITY },
      { recheckFloorMs: 0 },
      { recheckFloorMs: Number.NaN },
    ])
      await expect(runNightly(f.env, NOW, o)).rejects.toThrow(RangeError);
    expect(f.scripts).toEqual([]);
  });

  it("a rejection carries the install's own error text: it never reaches logs or results", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes("staging", (s) =>
      n36(s) === 0 ? "throw" : n36(s) === 1 ? "missing" : "ok",
    );
    const r = await nightly(f.env, NOW);
    expect(r.ok).toEqual([idOf(2)]);
    expect(r.failed).toEqual([
      { id: idOf(0), reason: "exception" },
      { id: idOf(1), reason: "not_found" },
    ]);
    const out = `${lines.join("\n")}\n${JSON.stringify(r)}`;
    expect(out).not.toMatch(
      /@|https?:|open-artifacts\.app|\/c\/|SECRET|boom|Worker not found|oa-s-/,
    );
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("more than 300 active installs logs the scale warning", async () => {
    await seed(ids(301));
    const lines = captureLogs();
    const f = fakes();
    const r = await runNightly(f.env, NOW, { concurrency: 50 });
    expect(r.ok).toHaveLength(301);
    expect(lines.filter((l) => l.startsWith("nightly scale"))).toEqual([
      "nightly scale active=301 over 300",
    ]);
  });

  it("300 active installs log no scale warning (no 32-invocation cap: measured on staging)", async () => {
    await seed(ids(300));
    const lines = captureLogs();
    await runNightly(fakes().env, NOW, { concurrency: 50 });
    expect(lines.some((l) => l.startsWith("nightly scale"))).toBe(false);
  });
});

describe("nightOrder (golden-stride rotation over a fixed sha256(id) order)", () => {
  const D0 = Date.UTC(2026, 9, 24, 3, 17);
  const fixture = (n: number) =>
    Array.from(
      { length: n },
      (_, k) => `i${(k * 7919).toString(36).padStart(11, "0")}`,
    );

  /** The longest run of consecutive nights an id is outside the budget. */
  async function streaks(n: number, budget: number, nights: number) {
    const all = fixture(n);
    const run = new Map(all.map((id) => [id, 0]));
    const ranOn: Set<string>[] = [];
    let max = 0;
    for (let d = 0; d < nights; d++) {
      const covered = new Set(
        (await nightOrder(all, D0 + d * DAY)).slice(0, budget),
      );
      ranOn.push(covered);
      for (const id of all) {
        const k = covered.has(id) ? 0 : (run.get(id) ?? 0) + 1;
        run.set(id, k);
        max = Math.max(max, k);
      }
    }
    let threeInARow = 0;
    for (let d = 0; d + 2 < nights; d++)
      for (const id of all)
        if ([0, 1, 2].every((k) => !ranOn[d + k]?.has(id))) threeInARow++;
    return { max, threeInARow };
  }

  // Each night covers a window of `budget` positions starting at the night's
  // offset; the offset steps by about 0.382 × N a night (a golden-ratio
  // step, floor(frac(day × 0.382) × N)), so by the three-distance theorem
  // the uncovered gap (N - budget) moves on by more than its own width when
  // budget > N - 0.382 N: 300 - 190 = 110 < 114, so an id is skipped at most
  // about one night running; the test allows 2 for rounding at the edges.
  it("300 ids, budget 190, 30 nights: max skip streak <= 2, never 3 nights in a row", async () => {
    const r = await streaks(300, 190, 30);
    expect(r.max).toBeLessThanOrEqual(2);
    expect(r.threeInARow).toBe(0);
  });

  // Degraded: a budget of 100 (a third of N) can't cover everyone in two
  // nights; the stride still bounds the streak (measured: 4).
  it("300 ids, budget 100 (degraded): max skip streak <= 4", async () => {
    expect((await streaks(300, 100, 30)).max).toBeLessThanOrEqual(4);
  });

  it("N = 0 and N = 1", async () => {
    expect(await nightOrder([], D0)).toEqual([]);
    expect(await nightOrder([idOf(3)], D0)).toEqual([idOf(3)]);
    expect(await nightOrder([idOf(3)], D0 + 9 * DAY)).toEqual([idOf(3)]);
  });

  it("is a permutation, deterministic for a given day and N", async () => {
    const all = fixture(50);
    const a = await nightOrder(all, D0);
    expect([...a].sort()).toEqual([...all].sort());
    expect(await nightOrder([...all].reverse(), D0)).toEqual(a);
    // Any time within the same UTC day gives the same order.
    const day = Math.floor(D0 / DAY) * DAY;
    expect(await nightOrder(all, day)).toEqual(a);
    expect(await nightOrder(all, day + DAY - 1)).toEqual(a);
  });

  it("changes at the UTC day boundary by one stride", async () => {
    const all = fixture(50);
    const day = Math.floor(D0 / DAY) * DAY;
    const before = await nightOrder(all, day - 1);
    const after = await nightOrder(all, day);
    expect(after).not.toEqual(before);
    // Same fixed cycle; the start moves by the golden step scaled to N.
    const start = (d: number) => Math.floor(frac(d * GOLDEN) * 50);
    const d = Math.floor(D0 / DAY);
    const at = (o: string[]) => o.indexOf(after[0] as string);
    expect(at(before)).toBe((start(d) - start(d - 1) + 50) % 50);
  });

  // Churn (the normal case): +2 and -1 installs a night. The start is
  // frac(day × 0.382) × N, so a small change in N moves the window only
  // slightly and the golden step still carries the uncovered tail past
  // itself. (An integer start, day × round(0.382 N) mod N, jumps to an
  // unrelated place whenever N changes: max streak 7 in the review.)
  it("churn: 300 installs, +2 -1 a night, budget 190, 30 nights: max streak <= 2, never 3 in a row", async () => {
    let live = fixture(300);
    let born = 300;
    const run = new Map<string, number>();
    const ranOn: Map<string, boolean>[] = [];
    let max = 0;
    for (let d = 0; d < 30; d++) {
      const covered = new Set(
        (await nightOrder(live, D0 + d * DAY)).slice(0, 190),
      );
      const night = new Map<string, boolean>();
      for (const id of live) {
        const k = covered.has(id) ? 0 : (run.get(id) ?? 0) + 1;
        run.set(id, k);
        night.set(id, covered.has(id));
        max = Math.max(max, k);
      }
      ranOn.push(night);
      // Tomorrow: the oldest live install deleted, two created.
      live = [
        ...live.slice(1),
        ...[0, 1].map(
          () => `i${(born++ * 7919).toString(36).padStart(11, "0")}`,
        ),
      ];
    }
    let threeInARow = 0;
    for (let d = 0; d + 2 < 30; d++)
      for (const [id] of ranOn[d] as Map<string, boolean>)
        if ([0, 1, 2].every((k) => ranOn[d + k]?.get(id) === false))
          threeInARow++;
    // Measured with this fixture: max streak 2, three-in-a-row 0 (the
    // integer start gave 7 and 652).
    expect(max).toBeLessThanOrEqual(2);
    expect(threeInARow).toBe(0);
  });
});

describe("scheduled", () => {
  const controller = (scheduledTime: number) =>
    ({ scheduledTime, cron: CRON, noRetry() {} }) as ScheduledController;

  it("runs with event.scheduledTime and logs one line per failure and one summary, no error text or PII", async () => {
    await seed([
      { id: idOf(0), state: "active" },
      { id: idOf(1), state: "active" },
      { id: idOf(2), state: "active" },
      { id: "not-an-id", state: "active" },
      { id: idOf(3), state: "creating" },
    ]);
    const lines = captureLogs();
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(1)}`]: "throw",
      [`oa-s-${idOf(2)}`]: "missing",
    };
    const f = fakes("staging", (s) => by[s] ?? "ok");
    await scheduler.scheduled(
      controller(1234),
      f.env,
      createExecutionContext(),
    );
    // The binding is lazy: the missing script fails on its call.
    expect(f.calls.map((c) => c.opts)).toEqual([
      { cron: CRON, scheduledTime: new Date(1234) },
      { cron: CRON, scheduledTime: new Date(1234) },
      { cron: CRON, scheduledTime: new Date(1234) },
    ]);
    expect([...lines].sort()).toEqual(
      [
        `nightly failed exception ${idOf(1)}`,
        `nightly failed not_found ${idOf(2)}`,
        "nightly invalid ids=1",
        "nightly summary active=3 ok=1 failed=2 skipped=0 capped=0 db_errors=0 leaked=0",
        // No EMAIL_QUOTA_TOKEN in the test env: the quota alert skips.
        "email-quota skipped no_token",
        // H-DV: the owner-email purge runs last on the nightly cron.
        "owner-email purged count=0",
      ].sort(),
    );
    // Every line is ids, fixed categories and counts only.
    for (const l of lines) expect(l).toMatch(LOG_LINE);
    const all = lines.join("\n");
    expect(all).not.toMatch(/@|boom|SECRET|Worker not found|not-an-id|oa-s-/);
  });

  it("logs nothing but ids, categories and counts, whatever the installs do", async () => {
    const kinds: Behavior[] = [
      "ok",
      "throw",
      "hang",
      "outcome",
      "canceled",
      "missing",
      { result: { outcome: "ok", noRetry: false } },
    ];
    await seed([
      ...Array.from({ length: 301 }, (_, n) => ({
        id: idOf(n),
        state: "active" as State,
      })),
      { id: "x@customer.test", state: "active" },
    ]);
    const lines = captureLogs();
    const f = fakes("staging", (s) => kinds[n36(s) % kinds.length] as Behavior);
    // The real handler path (scheduled calls nightly with the defaults).
    const { ok, failed, skipped, capped, leaked } = await nightly(f.env, NOW, {
      concurrency: 50,
      timeoutMs: 20,
      deadlineMs: 500,
      recheckFloorMs: 1,
    });
    expect(ok.length + failed.length + skipped.length).toBe(301);
    for (const r of ["timeout", "exception", "canceled", "not_found"])
      expect(failed.some((x) => x.reason === r)).toBe(true);
    expect(lines.filter((l) => l.startsWith("nightly failed"))).toHaveLength(
      failed.length,
    );
    expect(lines.filter((l) => l.startsWith("nightly summary"))).toEqual([
      `nightly summary active=301 ok=${ok.length} failed=${failed.length} skipped=${skipped.length} capped=${capped.length} db_errors=0 leaked=${leaked.length}`,
    ]);
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("zero installs logs only the summary", async () => {
    const lines = captureLogs();
    const f = fakes();
    await scheduler.scheduled(controller(NOW), f.env, createExecutionContext());
    expect(lines).toEqual([
      "nightly summary active=0 ok=0 failed=0 skipped=0 capped=0 db_errors=0 leaked=0",
      "email-quota skipped no_token",
      "owner-email purged count=0",
    ]);
    expect(f.scripts).toEqual([]);
  });

  it("an aborted run logs a fixed line and still fails the invocation", async () => {
    await seed(ids(1));
    const lines = captureLogs();
    const bad = fakes("dev" as "prod");
    await expect(
      scheduler.scheduled(controller(NOW), bad.env, createExecutionContext()),
    ).rejects.toThrow();
    expect(lines).toEqual(["nightly aborted env"]);
    expect(bad.scripts).toEqual([]);
  });
});

describe("scheduled: the email-quota alert", () => {
  const controller = (scheduledTime: number) =>
    ({ scheduledTime, cron: CRON, noRetry() {} }) as ScheduledController;
  const Z = "a".repeat(32);
  const quotaEnv = (f: ReturnType<typeof fakes>, o: Partial<Env> = {}) =>
    ({
      ...f.env,
      EMAIL_QUOTA_TOKEN: "tok_SECRET_0123456789abcdef",
      EMAIL_QUOTA_ZONES: Z,
      EMAIL_DAILY_LIMIT: "100",
      ...o,
    }) as Env;
  const reply = (count: number) =>
    new Response(
      JSON.stringify({
        data: {
          viewer: { zones: [{ emailSendingAdaptiveGroups: [{ count }] }] },
        },
        errors: null,
      }),
    );

  it("runs after the nightly job, from the scheduled time, and logs one line", async () => {
    await seed(ids(2));
    const lines = captureLogs();
    const fetchMock = vi.fn(async () => reply(85));
    vi.stubGlobal("fetch", fetchMock);
    const f = fakes();
    await scheduler.scheduled(
      controller(NOW),
      quotaEnv(f),
      createExecutionContext(),
    );
    vi.unstubAllGlobals();
    expect(f.calls).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "nightly summary active=2 ok=2 failed=0 skipped=0 capped=0 db_errors=0 leaked=0",
      "email-quota warn sent=85 limit=100 pct=85",
      "owner-email purged count=0",
    ]);
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("a quota failure leaves the nightly result and summary intact", async () => {
    await seed(ids(2));
    const lines = captureLogs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom owner@customer.test tok_SECRET");
      }),
    );
    const f = fakes("staging", (s) => (s.endsWith(idOf(1)) ? "throw" : "ok"));
    await expect(
      scheduler.scheduled(
        controller(NOW),
        quotaEnv(f),
        createExecutionContext(),
      ),
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
    expect(f.calls).toHaveLength(2);
    expect([...lines].sort()).toEqual(
      [
        `nightly failed exception ${idOf(1)}`,
        "nightly summary active=2 ok=1 failed=1 skipped=0 capped=0 db_errors=0 leaked=0",
        "email-quota failed http",
        "owner-email purged count=0",
      ].sort(),
    );
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("an aborted nightly run does not call the quota API", async () => {
    await seed(ids(1));
    captureLogs();
    const fetchMock = vi.fn(async () => reply(1));
    vi.stubGlobal("fetch", fetchMock);
    const bad = fakes("dev" as "prod");
    await expect(
      scheduler.scheduled(
        controller(NOW),
        quotaEnv(bad),
        createExecutionContext(),
      ),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
