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
  OWNER_EMAIL_RETENTION_MS,
  purgeOwnerEmails,
  REVOKE_CRON,
  REVOKE_JOB,
  REVOKE_MAX_ATTEMPTS,
  REVOKE_SQL,
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
        r.version === undefined ? "0.54.0" : r.version,
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

type Behavior = "ok" | "throw" | "hang" | "missing";
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
            if (b === "missing")
              throw new Error(
                `Worker not found: ${script} owner@customer.test`,
              );
            if (b === "throw")
              throw new Error("D1_ERROR owner@customer.test SECRET=x");
            if (b === "hang") await new Promise(() => {});
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
  /^(?:directory-revoke (?:done|unsupported|retry|failed|invalid) i[a-z0-9]{11}|directory-revoke invalid ids=\d+|owner-email purged count=\d+)$/;

const controller = (cron: string, scheduledTime = NOW) =>
  ({ scheduledTime, cron, noRetry() {} }) as ScheduledController;

describe("the */2 revoke tick", () => {
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

  it("resolve is done (with directory_revoked_at), below 0.54.0 and Worker not found are unsupported, a rejection retries", async () => {
    await seed([
      { id: idOf(0) },
      { id: idOf(1), version: "0.53.9" },
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
        `directory-revoke retry ${idOf(3)}`,
        `directory-revoke unsupported ${idOf(4)}`,
      ].sort(),
    );
    for (const l of lines) expect(l).toMatch(REVOKE_LINE);
    expect(lines.join("\n")).not.toMatch(
      /@|SECRET|D1_ERROR|Worker not found|oa-s-/,
    );
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
        /WHERE id = \?\d AND state = 'deleting'(?: RETURNING directory_revoke)?$/,
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
    expect((await rowOf(idOf(2))).owner_email).not.toBeNull();
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
    expect((await rowOf(idOf(2))).owner_email).toBeNull();
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
  it("nulls owner_email only on deleted installs older than 30 days; idempotent; the id stays", async () => {
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
        email: null,
      },
    ]);
    expect(OWNER_EMAIL_RETENTION_MS).toBe(30 * DAY);
    const lines = captureLogs();
    expect(await purgeOwnerEmails(db, NOW)).toBe(1);
    expect((await rowOf(idOf(0))).owner_email).toBeNull();
    expect((await rowOf(idOf(1))).owner_email).not.toBeNull();
    expect((await rowOf(idOf(2))).owner_email).not.toBeNull();
    expect((await rowOf(idOf(3))).owner_email).not.toBeNull();
    expect((await rowOf(idOf(4))).owner_email).not.toBeNull();
    expect(await purgeOwnerEmails(db, NOW)).toBe(0);
    expect(lines).toEqual([
      "owner-email purged count=1",
      "owner-email purged count=0",
    ]);
    expect(await rowOf(idOf(0))).toMatchObject({ state: "deleted" });
  });
});
