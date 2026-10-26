import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { isPurgedEmail } from "@oa/provision/names";
import { REVOKE_MIN_VERSION } from "@oa/provision/versions";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import STORED from "../../../packages/provision/test/fixtures/stored-install.json";
import scheduler, {
  CRON,
  type Env,
  OWNER_EMAIL_RETENTION_MS,
  PURGE_SQL,
  purgeOwnerEmails,
  REVOKE_CONCURRENCY,
  REVOKE_CRON,
  REVOKE_JOB,
  REVOKE_MAX_ATTEMPTS,
  REVOKE_SQL,
  revokeCategory,
  revokeTick,
} from "../src/index.js";

// H-DV: the */2 cron moves `deleting` installs' directory_revoke from
// pending to done / unsupported / failed, by calling the install's
// oa:directory-disconnect job through the dispatch namespace; the nightly
// cron purges owner emails of installs deleted more than 30 days ago.

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

const idOf = (n: number) => `i${n.toString(36).padStart(11, "0")}`;
const NOW = Date.UTC(2026, 9, 26, 12, 0);
const DAY = 86_400_000;

type Row = {
  id: string;
  state?: string;
  version?: string | null;
  revoke?: string | null;
  attempts?: number;
  updatedAt?: number;
  email?: string | null;
};

async function seed(rows: Row[]) {
  const ins = db.prepare(
    `INSERT INTO installs (id, slug, app_host, content_host, owner_email, rl_ns,
       inputs_hash, state, created_at, updated_at, version, directory_revoke, directory_revoke_attempts)
     VALUES (?1, ?2, ?2 || '.app.test', ?2 || '.content.test', ?3, ?4, 'h', ?5, 0, ?6, ?7, ?8, ?9)`,
  );
  await db.batch(
    rows.map((r, i) =>
      ins.bind(
        r.id,
        `s${i}`,
        r.email === undefined ? `owner${i}@customer.test` : r.email,
        (i + 1) * 8,
        r.state ?? "deleting",
        r.updatedAt ?? 0,
        r.version === undefined ? REVOKE_MIN_VERSION : r.version,
        r.revoke === undefined ? "pending" : r.revoke,
        r.attempts ?? 0,
      ),
    ),
  );
}

const rowOf = async (id: string) =>
  (await db
    .prepare(
      "SELECT state, owner_email, directory_revoke, directory_revoked_at, directory_revoke_attempts FROM installs WHERE id = ?1",
    )
    .bind(id)
    .first()) as Record<string, unknown>;

type Behavior =
  | "ok"
  | "throw"
  | "hang"
  | "missing"
  | "missingThrows"
  | "nonOk"
  | "okObject"
  | "weird";
function fakes(
  behave: (script: string) => Behavior = () => "ok",
  onCall?: (script: string) => Promise<void>,
) {
  const calls: { script: string; opts: unknown }[] = [];
  const env = {
    OA_ENV: "staging",
    PLATFORM_DB: db,
    DISPATCHER: {
      get(script: string) {
        const b = behave(script);
        return {
          async scheduled(opts: unknown) {
            calls.push({ script, opts });
            await onCall?.(script);
            if (b === "missing") return { outcome: "scriptNotFound" };
            if (b === "nonOk") return { outcome: "exception" };
            if (b === "okObject") return { outcome: "ok" };
            if (b === "weird")
              return { outcome: "exception owner@customer.test" };
            if (b === "missingThrows")
              throw new Error(
                `Worker not found: ${script} owner@customer.test`,
              );
            if (b === "throw")
              throw new Error("D1_ERROR owner@customer.test SECRET=x");
            if (b === "hang") await new Promise(() => {});
            // What a dispatch namespace really returns for a handler that
            // succeeded (measured on staging, ScheduledFetcher).
            return undefined;
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
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

const REVOKE_LINE =
  /^(?:directory-revoke (?:done|unsupported|db_error) i[a-z0-9]{11}|directory-revoke (?:retry|failed) i[a-z0-9]{11} (?:exception|exceededCpu|exceededMemory|canceled|unknown|throw|timeout)|directory-revoke invalid ids=\d+|directory-revoke aborted exception|owner-email purged count=\d+)$/;

const controller = (cron: string, scheduledTime = NOW) =>
  ({ scheduledTime, cron, noRetry() {} }) as ScheduledController;

describe("the */2 revoke tick", () => {
  it("the purge SQL empties the email, never NULL (owner_email stays NOT NULL)", () => {
    // inputs_hash is an unsalted sha256 over the email (M3): blanked too.
    expect(PURGE_SQL).toBe(
      "UPDATE installs SET owner_email = '', inputs_hash = '' WHERE state='deleted' AND updated_at < ?1 AND owner_email <> '' RETURNING id",
    );
  });

  it("the crons and the job name", () => {
    expect(REVOKE_CRON).toBe("*/2 * * * *");
    expect(CRON).toBe("17 3 * * *");
    expect(REVOKE_JOB).toBe("oa:directory-disconnect");
    expect(REVOKE_MAX_ATTEMPTS).toBe(5);
    expect(REVOKE_SQL).toBe(
      "SELECT id, version FROM installs WHERE state='deleting' AND directory_revoke='pending' LIMIT 10",
    );
  });

  it("reads through the partial index, never a table scan", async () => {
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${REVOKE_SQL}`)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/USING (?:COVERING )?INDEX installs_revoke_pending/);
    expect(plan).not.toMatch(/^SCAN installs$/m);
  });

  it("an empty result is a no-op", async () => {
    await seed([{ id: idOf(0), state: "active", revoke: null }]);
    const lines = captureLogs();
    const f = fakes();
    await revokeTick(f.env, NOW);
    expect(f.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("resolve is done (with directory_revoked_at), below REVOKE_MIN_VERSION and a scriptNotFound outcome are unsupported, a rejection retries", async () => {
    await seed([
      { id: idOf(0) },
      { id: idOf(1), version: "0.55.9" },
      { id: idOf(2) },
      { id: idOf(3) },
      { id: idOf(4), version: null },
    ]);
    const lines = captureLogs();
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(2)}`]: "missing",
      [`oa-s-${idOf(3)}`]: "throw",
    };
    const f = fakes((s) => by[s] ?? "ok");
    await revokeTick(f.env, NOW);
    expect(f.calls.map((c) => c.script).sort()).toEqual(
      [`oa-s-${idOf(0)}`, `oa-s-${idOf(2)}`, `oa-s-${idOf(3)}`].sort(),
    );
    for (const c of f.calls)
      expect(c.opts).toEqual({
        cron: REVOKE_JOB,
        scheduledTime: new Date(NOW),
      });
    expect(await rowOf(idOf(0))).toMatchObject({
      directory_revoke: "done",
      directory_revoked_at: NOW,
      directory_revoke_attempts: 0,
    });
    expect((await rowOf(idOf(1))).directory_revoke).toBe("unsupported");
    expect((await rowOf(idOf(2))).directory_revoke).toBe("unsupported");
    expect(await rowOf(idOf(3))).toMatchObject({
      directory_revoke: "pending",
      directory_revoke_attempts: 1,
    });
    expect((await rowOf(idOf(4))).directory_revoke).toBe("unsupported");
    expect([...lines].sort()).toEqual(
      [
        `directory-revoke done ${idOf(0)}`,
        `directory-revoke unsupported ${idOf(1)}`,
        `directory-revoke unsupported ${idOf(2)}`,
        `directory-revoke retry ${idOf(3)} throw`,
        `directory-revoke unsupported ${idOf(4)}`,
      ].sort(),
    );
    for (const l of lines) expect(l).toMatch(REVOKE_LINE);
    expect(lines.join("\n")).not.toMatch(
      /@|SECRET|D1_ERROR|Worker not found|oa-s-/,
    );
  });

  it("L1: a thrown Worker not found is an attempt, never unsupported; a non-ok or unknown result is too", async () => {
    await seed([{ id: idOf(0) }, { id: idOf(1) }, { id: idOf(2) }]);
    const lines = captureLogs();
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(0)}`]: "missingThrows",
      [`oa-s-${idOf(1)}`]: "nonOk",
      [`oa-s-${idOf(2)}`]: "weird",
    };
    const f = fakes((s) => by[s] ?? "ok");
    await revokeTick(f.env, NOW);
    for (const k of [0, 1, 2])
      expect(await rowOf(idOf(k))).toMatchObject({
        directory_revoke: "pending",
        directory_revoke_attempts: 1,
      });
    expect([...lines].sort()).toEqual(
      [
        `directory-revoke retry ${idOf(0)} throw`,
        `directory-revoke retry ${idOf(1)} exception`,
        `directory-revoke retry ${idOf(2)} unknown`,
      ].sort(),
    );
    for (const l of lines) expect(l).toMatch(REVOKE_LINE);
    expect(lines.join("\n")).not.toMatch(/@|Worker not found|oa-s-/);
  });

  it("a resolve to undefined (what a dispatch namespace returns) and outcome ok are both done", async () => {
    await seed([{ id: idOf(0) }, { id: idOf(1) }]);
    const by: Record<string, Behavior> = { [`oa-s-${idOf(1)}`]: "okObject" };
    await revokeTick(fakes((s) => by[s] ?? "ok").env, NOW);
    for (const k of [0, 1])
      expect(await rowOf(idOf(k))).toMatchObject({
        directory_revoke: "done",
        directory_revoked_at: NOW,
        directory_revoke_attempts: 0,
      });
  });

  it("revokeCategory keeps only the fixed vocabulary; anything else is unknown", () => {
    expect(revokeCategory(undefined)).toBe("ok");
    for (const o of [
      "ok",
      "scriptNotFound",
      "exception",
      "exceededCpu",
      "exceededMemory",
      "canceled",
    ])
      expect(revokeCategory({ outcome: o })).toBe(o);
    for (const r of [
      null,
      "ok",
      5,
      {},
      { outcome: 5 },
      { outcome: "OK" },
      { outcome: "exception owner@customer.test" },
      { outcome: "timeout" },
      { outcome: "throw" },
    ])
      expect(revokeCategory(r)).toBe("unknown");
  });

  it("M1b: done never predates this attempt's start", async () => {
    await seed([{ id: idOf(0) }]);
    await db
      .prepare(
        "UPDATE installs SET directory_revoke_requested_at = ?1 WHERE id = ?2",
      )
      .bind(NOW + 5000, idOf(0))
      .run();
    await revokeTick(fakes().env, NOW);
    expect((await rowOf(idOf(0))).directory_revoked_at).toBe(NOW + 5000);
  });

  it("the fifth failure, a rejection or a timeout, is failed", async () => {
    await seed([
      { id: idOf(0), attempts: 4 },
      { id: idOf(1), attempts: 4 },
      { id: idOf(2), attempts: 3 },
    ]);
    const lines = captureLogs();
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(0)}`]: "throw",
      [`oa-s-${idOf(1)}`]: "hang",
      [`oa-s-${idOf(2)}`]: "hang",
    };
    const f = fakes((s) => by[s] ?? "ok");
    await revokeTick(f.env, NOW, { timeoutMs: 20 });
    expect(await rowOf(idOf(0))).toMatchObject({
      directory_revoke: "failed",
      directory_revoke_attempts: 5,
    });
    expect(await rowOf(idOf(1))).toMatchObject({
      directory_revoke: "failed",
      directory_revoke_attempts: 5,
    });
    expect(await rowOf(idOf(2))).toMatchObject({
      directory_revoke: "pending",
      directory_revoke_attempts: 4,
    });
    expect(
      lines.filter((l) => l.startsWith("directory-revoke failed")),
    ).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(REVOKE_LINE);
  });

  it("an invalid id is skipped and never called", async () => {
    await seed([{ id: "not-an-id" }, { id: idOf(1) }]);
    const lines = captureLogs();
    const f = fakes();
    await revokeTick(f.env, NOW);
    expect(f.calls.map((c) => c.script)).toEqual([`oa-s-${idOf(1)}`]);
    expect((await rowOf("not-an-id")).directory_revoke).toBe("pending");
    expect(lines).toContain("directory-revoke invalid ids=1");
  });

  it("at most 10 rows a tick", async () => {
    await seed(Array.from({ length: 12 }, (_, i) => ({ id: idOf(i) })));
    const f = fakes();
    await revokeTick(f.env, NOW);
    expect(f.calls).toHaveLength(10);
  });

  it("writes only the revoke columns, only on rows still deleting", async () => {
    await seed([{ id: idOf(0) }, { id: idOf(1) }]);
    // Between the select and the write, the row leaves deleting.
    const f = fakes(
      () => "ok",
      async (script) => {
        if (script === `oa-s-${idOf(1)}`)
          await db
            .prepare("UPDATE installs SET state = 'deleted' WHERE id = ?1")
            .bind(idOf(1))
            .run();
      },
    );
    const spy = vi.spyOn(db, "prepare");
    await revokeTick(f.env, NOW);
    const writes = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /^\s*(?:UPDATE|INSERT|DELETE)/i.test(s))
      // The test's own write (the row leaving deleting) is not the scheduler's.
      .filter((s) => !s.includes("SET state = 'deleted'"));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).toMatch(
        /^UPDATE installs SET (?:directory_revoke|directory_revoked_at|directory_revoke_attempts)\b/,
      );
      expect(w).toMatch(
        /WHERE id = \?\d AND state = 'deleting' AND directory_revoke = 'pending'(?: RETURNING directory_revoke)?$/,
      );
      const set = w.slice(w.indexOf("SET") + 3, w.indexOf("WHERE"));
      for (const col of set.split(",").map((x) => x.trim().split(/\s|=/)[0]))
        expect([
          "directory_revoke",
          "directory_revoked_at",
          "directory_revoke_attempts",
        ]).toContain(col);
    }
    expect((await rowOf(idOf(0))).directory_revoke).toBe("done");
    expect(await rowOf(idOf(1))).toMatchObject({
      state: "deleted",
      directory_revoke: "pending",
    });
  });
});

describe("scheduled() branches on event.cron", () => {
  it("the */2 cron runs only the revoke tick: no nightly call, no purge", async () => {
    await seed([
      { id: idOf(0) },
      { id: idOf(1), state: "active", revoke: null },
      {
        id: idOf(2),
        state: "deleted",
        revoke: "done",
        updatedAt: NOW - 40 * DAY,
      },
    ]);
    const lines = captureLogs();
    const f = fakes();
    await scheduler.scheduled(
      controller(REVOKE_CRON),
      f.env,
      createExecutionContext(),
    );
    expect(f.calls).toEqual([
      {
        script: `oa-s-${idOf(0)}`,
        opts: { cron: REVOKE_JOB, scheduledTime: new Date(NOW) },
      },
    ]);
    expect(
      lines.some(
        (l) =>
          l.startsWith("nightly") ||
          l.startsWith("email-quota") ||
          l.startsWith("owner-email"),
      ),
    ).toBe(false);
    expect((await rowOf(idOf(2))).owner_email).toBe("owner2@customer.test");
  });

  it("the nightly cron never runs the revoke tick, and purges owner emails", async () => {
    await seed([
      { id: idOf(0) },
      { id: idOf(1), state: "active", revoke: null },
      {
        id: idOf(2),
        state: "deleted",
        revoke: "done",
        updatedAt: NOW - 40 * DAY,
      },
    ]);
    const lines = captureLogs();
    const f = fakes();
    await scheduler.scheduled(
      controller(CRON),
      f.env,
      createExecutionContext(),
    );
    expect(f.calls.map((c) => c.opts)).toEqual([
      { cron: CRON, scheduledTime: new Date(NOW) },
    ]);
    expect((await rowOf(idOf(0))).directory_revoke).toBe("pending");
    expect(lines.some((l) => l.startsWith("directory-revoke"))).toBe(false);
    expect(lines).toContain("owner-email purged count=1");
    expect((await rowOf(idOf(2))).owner_email).toBe("");
  });

  it("an unknown cron runs nothing", async () => {
    await seed([{ id: idOf(0) }]);
    const f = fakes();
    await scheduler.scheduled(
      controller("0 0 * * *"),
      f.env,
      createExecutionContext(),
    );
    expect(f.calls).toEqual([]);
  });
});

describe("owner-email purge", () => {
  it("empties owner_email ('') only on deleted installs older than 30 days; idempotent; the id stays", async () => {
    const edge = NOW - OWNER_EMAIL_RETENTION_MS;
    await seed([
      { id: idOf(0), state: "deleted", revoke: "done", updatedAt: edge - 1 },
      { id: idOf(1), state: "deleted", revoke: "done", updatedAt: edge },
      { id: idOf(2), state: "deleted", revoke: "done", updatedAt: edge + 1 },
      { id: idOf(3), state: "active", revoke: null, updatedAt: 0 },
      { id: idOf(4), state: "deleting", updatedAt: 0 },
      {
        id: idOf(5),
        state: "deleted",
        revoke: "done",
        updatedAt: 0,
        // Already purged.
        email: "",
      },
    ]);
    expect(OWNER_EMAIL_RETENTION_MS).toBe(30 * DAY);
    const lines = captureLogs();
    expect(await purgeOwnerEmails(db, NOW)).toBe(1);
    expect((await rowOf(idOf(0))).owner_email).toBe("");
    expect(isPurgedEmail((await rowOf(idOf(0))).owner_email)).toBe(true);
    for (const k of [1, 2, 3, 4])
      expect((await rowOf(idOf(k))).owner_email).toBe(
        `owner${k}@customer.test`,
      );
    expect((await rowOf(idOf(5))).owner_email).toBe("");
    expect(await purgeOwnerEmails(db, NOW)).toBe(0);
    expect(lines).toEqual([
      "owner-email purged count=1",
      "owner-email purged count=0",
    ]);
    expect(await rowOf(idOf(0))).toMatchObject({ state: "deleted" });
  });
});

describe("H-DV review fixes", () => {
  /** PLATFORM_DB whose writes for one id throw (a D1 error with raw text). */
  const failingWrites = (badId: string): D1Database =>
    new Proxy(db, {
      get(t, k) {
        if (k !== "prepare") return Reflect.get(t, k);
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!/^UPDATE installs SET directory_revoke/.test(sql)) return st;
          return new Proxy(st, {
            get(s2, k2) {
              if (k2 !== "bind") return Reflect.get(s2, k2);
              return (...args: unknown[]) => {
                const b = s2.bind(...args);
                if (args[0] !== badId) return b;
                const boom = async () => {
                  throw new Error("D1_ERROR owner@customer.test SECRET");
                };
                return { ...b, run: boom, first: boom, all: boom };
              };
            },
          });
        };
      },
    }) as D1Database;

  it("M2: one row's D1 error never stops the others; a fixed db_error line, no error text", async () => {
    await seed([{ id: idOf(1) }, { id: idOf(2) }, { id: idOf(3) }]);
    const lines = captureLogs();
    const f = fakes();
    const env = { ...f.env, PLATFORM_DB: failingWrites(idOf(2)) } as Env;
    await expect(revokeTick(env, NOW)).resolves.toBeUndefined();
    expect((await rowOf(idOf(1))).directory_revoke).toBe("done");
    expect((await rowOf(idOf(3))).directory_revoke).toBe("done");
    expect((await rowOf(idOf(2))).directory_revoke).toBe("pending");
    expect(lines).toContain(`directory-revoke db_error ${idOf(2)}`);
    for (const l of lines) expect(l).toMatch(REVOKE_LINE);
    expect(lines.join("\n")).not.toMatch(/@|SECRET|D1_ERROR/);
  });

  it("M2: a failing select aborts the tick with a fixed line, and scheduled() does not throw raw text", async () => {
    const lines = captureLogs();
    const f = fakes();
    const env = {
      ...f.env,
      PLATFORM_DB: new Proxy(db, {
        get(t, k) {
          if (k === "prepare")
            return () => {
              throw new Error("D1_ERROR no such column owner@customer.test");
            };
          return Reflect.get(t, k);
        },
      }),
    } as Env;
    await expect(
      scheduler.scheduled(
        controller(REVOKE_CRON),
        env,
        createExecutionContext(),
      ),
    ).resolves.toBeUndefined();
    expect(lines).toEqual(["directory-revoke aborted exception"]);
  });

  it("L2: a late result never overwrites a revoke the operator settled meanwhile", async () => {
    await seed([{ id: idOf(0), attempts: 4 }, { id: idOf(1) }]);
    const f = fakes(
      (s) => (s.endsWith(idOf(0)) ? "throw" : "ok"),
      async () => {
        await db
          .prepare("UPDATE installs SET directory_revoke = 'skipped'")
          .run();
      },
    );
    await revokeTick(f.env, NOW);
    expect(await rowOf(idOf(0))).toMatchObject({
      directory_revoke: "skipped",
      directory_revoke_attempts: 4,
    });
    expect(await rowOf(idOf(1))).toMatchObject({
      directory_revoke: "skipped",
      directory_revoked_at: null,
    });
  });

  it("L4: at most 3 revoke calls in flight", async () => {
    await seed(Array.from({ length: 10 }, (_, i) => ({ id: idOf(i) })));
    let inFlight = 0;
    let max = 0;
    const f = fakes(
      () => "ok",
      async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    );
    await revokeTick(f.env, NOW);
    expect(f.calls).toHaveLength(10);
    expect(max).toBe(3);
    expect(REVOKE_CONCURRENCY).toBe(3);
  });

  it("L6: a prerelease of REVOKE_MIN_VERSION or a malformed version is unsupported, with no call", async () => {
    // A prerelease of the next patch sits above the minimum, so it is called.
    const [maj, min, pat] = REVOKE_MIN_VERSION.split(".").map(Number);
    await seed([
      { id: idOf(0), version: `${REVOKE_MIN_VERSION}-rc.1` },
      { id: idOf(1), version: `v${REVOKE_MIN_VERSION}` },
      { id: idOf(2), version: `${maj}.${min}` },
      { id: idOf(3), version: `${maj}.${min}.${pat + 1}-rc.1` },
    ]);
    const f = fakes();
    await revokeTick(f.env, NOW);
    expect(f.calls.map((c) => c.script)).toEqual([`oa-s-${idOf(3)}`]);
    for (const k of [0, 1, 2])
      expect((await rowOf(idOf(k))).directory_revoke).toBe("unsupported");
  });

  it("M3: after the purge no column of a deleted install holds the email or anything derived from it", async () => {
    // What create really stores (provision's fixture, pinned there against
    // a fresh create): the owner email, its inputs_hash, vars and metadata.
    const fx = STORED;
    const email = fx.ownerEmail;
    const hex = async (s: string) =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
        ),
      ]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const inputsHash = fx.inputsHash;
    const real = (v: unknown) =>
      JSON.stringify(v)
        .split("{{INSTALL_ID}}")
        .join(idOf(0))
        .split("{{D1_ID}}")
        .join("00000000-0000-4000-8000-000000000000")
        .split("{{KV_ID}}")
        .join("0".repeat(32));
    await seed([
      { id: idOf(0), state: "deleted", revoke: "done", updatedAt: 0, email },
      // An active install keeps its email and hash.
      {
        id: idOf(9),
        state: "active",
        revoke: null,
        updatedAt: 0,
        email: "keep@customer.test",
      },
    ]);
    await db
      .prepare("UPDATE installs SET inputs_hash = ?1 WHERE id = ?2")
      .bind(inputsHash, idOf(0))
      .run();
    await db
      .prepare(
        "INSERT INTO install_versions (install_id, version, vars, metadata, updated_at) VALUES (?1, ?2, ?3, ?4, 0)",
      )
      .bind(idOf(0), fx.version, real(fx.vars), real(fx.metadata))
      .run();
    // The seeded copy is the real one (bindings, tags, the broker URL).
    expect(real(fx.metadata)).toContain(`"INSTALL_ID"`);
    expect(real(fx.metadata)).toContain(idOf(0));
    captureLogs();
    expect(await purgeOwnerEmails(db, NOW)).toBe(1);
    const needles = [email, await hex(email), inputsHash];
    for (const t of ["installs", "install_versions", "hosts", "hosted_audit"]) {
      const col = t === "installs" ? "id" : "install_id";
      const { results } = await db
        .prepare(`SELECT * FROM ${t} WHERE ${col} = ?1`)
        .bind(idOf(0))
        .all();
      const dump = JSON.stringify(results);
      for (const n of needles) expect(dump, `${t} holds ${n}`).not.toContain(n);
    }
    const kept = (await db
      .prepare("SELECT owner_email, inputs_hash FROM installs WHERE id = ?1")
      .bind(idOf(9))
      .first()) as { owner_email: string; inputs_hash: string };
    expect(kept).toEqual({
      owner_email: "keep@customer.test",
      inputs_hash: "h",
    });
  });
});
