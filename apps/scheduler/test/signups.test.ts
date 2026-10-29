import { applyD1Migrations } from "cloudflare:test";
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
import {
  requeueWaiting,
  SIGNUP_STALE_MS,
  type SignupsEnv,
  SWEEP_LIMIT,
  signupTick,
  sweepStale,
} from "../src/signups.js";

// The scheduler's half of SS3: the waiting_cap re-enqueue, the stale-row
// sweep, and the three signup alerts. The provisioner's consumer does every
// admission, so nothing here changes a signups row. Every clock is pinned.

const db = (testEnv as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM platform_state"),
    db.prepare("DELETE FROM signups"),
    db.prepare("DELETE FROM signup_secret"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 9, 29, 12, 0);
const D0 = Date.UTC(2026, 9, 29);
const EMAIL = "Owner+Tag@Example.COM";

// ULIDs: the shape SS4 mints.
const id = (n: number) => `01JB${String(n).padStart(22, "0")}`;

type Row = {
  status: string;
  created?: number;
  updated?: number;
  admitted?: number | null;
  claimed?: number | null;
  sent?: number | null;
};

async function seed(rows: Record<number, Row>) {
  await db.batch(
    Object.entries(rows).flatMap(([n, r]) => [
      db
        .prepare(
          `INSERT INTO signups (signup_id, owner_sub, slug, status, admitted_at,
             welcome_claimed_at, welcome_sent_at, created_at, updated_at)
           VALUES (?1, 'sub', ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          id(Number(n)),
          `slug-${n}`,
          r.status,
          r.admitted ?? null,
          r.claimed ?? null,
          r.sent ?? null,
          r.created ?? r.updated ?? T0,
          r.updated ?? r.created ?? T0,
        ),
      db
        .prepare(
          "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?1, ?2)",
        )
        .bind(id(Number(n)), EMAIL),
    ]),
  );
}

const snapshot = async () =>
  (await db.prepare("SELECT * FROM signups ORDER BY signup_id").all()).results;

type Sent = { from: string; to: string; subject: string; text: string };

function fakes(o: {
  cap?: string;
  /** Instances that exist: id to status (default running). */
  instances?: string[] | Record<string, string>;
  getError?: string;
}) {
  const queued: unknown[] = [];
  const gets: string[] = [];
  const mail: Sent[] = [];
  const instances = new Map<string, string>(
    Array.isArray(o.instances)
      ? o.instances.map((i) => [i, "running"])
      : Object.entries(o.instances ?? {}),
  );
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    SIGNUP_DAILY_CAP: o.cap ?? "3",
    ALERT_TO: "ops@example.test",
    ALERT_FROM: "alerts@example.test",
    ALERT_EMAIL: {
      send: async (m: Sent) => {
        mail.push(m);
        return { messageId: "m1" };
      },
    },
    SIGNUPS: {
      send: async (body: unknown) => {
        queued.push(body);
      },
      sendBatch: async (msgs: { body: unknown }[]) => {
        for (const m of msgs) queued.push(m.body);
      },
    },
    PROVISION_INSTALL: {
      get: async (iid: string) => {
        gets.push(iid);
        if (o.getError) throw new Error(o.getError);
        const status = instances.get(iid);
        if (status === undefined) throw new Error("instance.not_found");
        return { id: iid, status: async () => ({ status }) };
      },
    },
  } as unknown as SignupsEnv;
  return {
    env,
    queued,
    gets,
    mail,
    subjects: () => mail.map((m) => m.subject),
  };
}

function logs() {
  const lines: string[] = [];
  for (const k of ["log", "warn", "error"] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  return lines;
}

describe("requeueWaiting", () => {
  it("requeue sends ids only, in order, within the cap", async () => {
    await seed({
      // Admitted today: uses one of the 3.
      1: { status: "creating", admitted: D0 + H, created: D0 - DAY },
      // Admitted yesterday: doesn't count.
      2: { status: "ready", admitted: D0 - H, created: D0 - DAY },
      // Waiting, seeded out of order.
      5: { status: "waiting_cap", created: D0 - 3 * H },
      3: { status: "waiting_cap", created: D0 - 5 * H },
      4: { status: "waiting_cap", created: D0 - 4 * H },
      6: { status: "pending", created: D0 - 6 * H },
    });
    const before = await snapshot();
    const f = fakes({ cap: "3" });
    expect(await requeueWaiting(f.env, T0)).toBe(2);
    expect(f.queued).toEqual([{ signupId: id(3) }, { signupId: id(4) }]);
    for (const b of f.queued)
      expect(Object.keys(b as object)).toEqual(["signupId"]);
    expect(await snapshot()).toEqual(before);
  });

  it("sends nothing once the day's cap is used", async () => {
    await seed({
      1: { status: "ready", admitted: D0 + 1 },
      2: { status: "waiting_cap", created: D0 - H },
    });
    const f = fakes({ cap: "1" });
    expect(await requeueWaiting(f.env, T0)).toBe(0);
    expect(f.queued).toEqual([]);
  });

  it("an invalid cap logs and skips, never throws", async () => {
    await seed({ 1: { status: "waiting_cap", created: D0 - H } });
    for (const cap of ["0", "abc", "10000", "", " 5", "05"]) {
      const lines = logs();
      const f = fakes({ cap });
      expect(await requeueWaiting(f.env, T0)).toBe(0);
      expect(f.queued).toEqual([]);
      expect(lines).toEqual(["signups requeue skipped cap_config"]);
      vi.restoreAllMocks();
    }
  });
});

describe("sweepStale", () => {
  const stale = T0 - SIGNUP_STALE_MS - 1;
  const fresh = T0 - SIGNUP_STALE_MS + MIN;

  it("sweep re-sends a stale pending row and a queued row with no instance, but not a fresh one", async () => {
    await seed({
      1: { status: "pending", created: stale },
      2: { status: "pending", created: fresh },
      3: { status: "queued", created: stale, admitted: stale },
      4: { status: "queued", created: stale, admitted: stale },
      5: { status: "queued", created: fresh, admitted: fresh },
      6: { status: "creating", created: stale },
      7: { status: "waiting_cap", created: stale },
      8: { status: "failed", created: stale },
    });
    const before = await snapshot();
    const f = fakes({ instances: [id(4)] });
    expect(await sweepStale(f.env, T0)).toEqual({
      sent: 2,
      stuck: { count: 0, ids: [] },
    });
    expect(f.queued).toEqual([{ signupId: id(1) }, { signupId: id(3) }]);
    // Only stale queued rows are looked up.
    expect(f.gets.sort()).toEqual([id(3), id(4)]);
    expect(await snapshot()).toEqual(before);
  });

  it("any get error re-sends", async () => {
    await seed({ 1: { status: "queued", created: T0 - H, admitted: T0 - H } });
    for (const text of [
      "internal error for x@example.test",
      "network connection lost",
    ]) {
      const lines = logs();
      const f = fakes({ getError: text });
      expect((await sweepStale(f.env, T0)).sent).toBe(1);
      expect(f.queued).toEqual([{ signupId: id(1) }]);
      expect(lines.join("\n")).not.toContain("@");
      vi.restoreAllMocks();
    }
  });

  it("a dead instance is stuck: counted, never re-sent", async () => {
    await seed({
      1: { status: "queued", created: stale, admitted: stale },
      2: { status: "queued", created: stale, admitted: stale },
      3: { status: "queued", created: stale, admitted: stale },
      4: { status: "queued", created: stale, admitted: stale },
      5: { status: "queued", created: stale, admitted: stale },
    });
    const f = fakes({
      instances: {
        [id(1)]: "errored",
        [id(2)]: "terminated",
        [id(3)]: "complete",
        [id(4)]: "running",
        [id(5)]: "waiting",
      },
    });
    expect(await sweepStale(f.env, T0)).toEqual({
      sent: 0,
      stuck: { count: 3, ids: [id(1), id(2), id(3)] },
    });
    expect(f.queued).toEqual([]);
  });

  it("50 stuck queued rows still let a stale pending row through", async () => {
    const rows: Record<number, Row> = {};
    const dead: Record<string, string> = {};
    for (let n = 1; n <= SWEEP_LIMIT; n++) {
      rows[n] = { status: "queued", created: stale - H, admitted: stale - H };
      dead[id(n)] = "errored";
    }
    rows[100] = { status: "pending", created: stale };
    await seed(rows);
    const f = fakes({ instances: dead });
    const r = await sweepStale(f.env, T0);
    expect(f.queued).toEqual([{ signupId: id(100) }]);
    expect(r.sent).toBe(1);
    expect(r.stuck?.count).toBe(SWEEP_LIMIT - 1);
  });

  it("a sweep with no room for queued rows leaves the stuck alert unknown", async () => {
    const rows: Record<number, Row> = {};
    for (let n = 1; n <= SWEEP_LIMIT; n++)
      rows[n] = { status: "pending", created: stale };
    await seed(rows);
    const f = fakes({});
    expect(await sweepStale(f.env, T0)).toEqual({
      sent: SWEEP_LIMIT,
      stuck: null,
    });
  });
});

describe("signup alerts", () => {
  const CAP_OPEN = "Open Artifacts staging: signup cap reached";
  const CAP_CLEAR = "Open Artifacts staging: signup cap no longer reached";
  const FAIL_OPEN = "Open Artifacts staging: signups failed";
  const FAIL_CLEAR = "Open Artifacts staging: no failed signups";
  const WELCOME_OPEN = "Open Artifacts staging: welcome email unsent";
  const WELCOME_CLEAR = "Open Artifacts staging: welcome emails sent";
  const STUCK_OPEN = "Open Artifacts staging: signups stuck";
  const STUCK_CLEAR = "Open Artifacts staging: no stuck signups";

  it("stuck alert opens on a dead instance and clears once redriven", async () => {
    const f = fakes({ instances: { [id(1)]: "errored" } });
    await seed({ 1: { status: "queued", created: T0 - H, admitted: T0 - H } });
    await signupTick(f.env, T0);
    expect(f.subjects()).toEqual([STUCK_OPEN]);
    expect(f.mail[0]?.text).toContain(id(1));
    expect(f.mail[0]?.text).toContain("1 signup");
    expect(f.queued).toEqual([]);
    await setStatus(1, "ready", T0 + MIN);
    await signupTick(f.env, T0 + 2 * MIN);
    expect(f.subjects()).toEqual([STUCK_OPEN, STUCK_CLEAR]);
  });

  const setStatus = (n: number, status: string, at: number) =>
    db
      .prepare(
        "UPDATE signups SET status = ?2, updated_at = ?3 WHERE signup_id = ?1",
      )
      .bind(id(n), status, at)
      .run();

  it("cap alert opens once a day", async () => {
    const f = fakes({ cap: "100" });
    await seed({ 1: { status: "waiting_cap", updated: T0 } });
    await signupTick(f.env, T0);
    await signupTick(f.env, T0 + 2 * MIN);
    expect(f.subjects()).toEqual([CAP_OPEN]);
    // The cap is raised and the row admitted: the alert clears.
    await setStatus(1, "queued", T0 + 3 * MIN);
    await signupTick(f.env, T0 + 4 * MIN);
    expect(f.subjects()).toEqual([CAP_OPEN, CAP_CLEAR]);
    // The cap is hit again the same UTC day: no second alert today.
    await seed({ 2: { status: "waiting_cap", updated: T0 + 5 * MIN } });
    await signupTick(f.env, T0 + 6 * MIN);
    await signupTick(f.env, T0 + 8 * MIN);
    expect(f.subjects()).toEqual([CAP_OPEN, CAP_CLEAR]);
    // The next UTC day's first hit alerts again.
    await setStatus(2, "waiting_cap", D0 + DAY + MIN);
    await signupTick(f.env, D0 + DAY + 2 * MIN);
    expect(f.subjects()).toEqual([CAP_OPEN, CAP_CLEAR, CAP_OPEN]);
  });

  it("a waiting row from an earlier day isn't today's cap hit", async () => {
    const f = fakes({ cap: "0" });
    await seed({ 1: { status: "waiting_cap", updated: D0 - H } });
    await signupTick(f.env, T0);
    expect(f.subjects()).toEqual([]);
  });

  it("failed alert opens on a failed row in the last 24 h and clears after", async () => {
    const f = fakes({});
    await seed({ 1: { status: "failed", updated: T0 - H } });
    await signupTick(f.env, T0);
    expect(f.subjects()).toEqual([FAIL_OPEN]);
    expect(f.mail[0]?.text).toContain(id(1));
    expect(f.mail[0]?.text).toContain("1 signup");
    await signupTick(f.env, T0 + 22 * H);
    expect(f.subjects()).toEqual([FAIL_OPEN]);
    await signupTick(f.env, T0 + 23 * H + MIN);
    expect(f.subjects()).toEqual([FAIL_OPEN, FAIL_CLEAR]);
  });

  it("welcome unsent alert: claimed over 10 minutes ago and never sent", async () => {
    const f = fakes({});
    await seed({
      1: { status: "ready", claimed: T0 - 11 * MIN, sent: null },
      2: { status: "ready", claimed: T0 - 5 * MIN, sent: null },
      3: { status: "ready", claimed: T0 - H, sent: T0 - H },
    });
    await signupTick(f.env, T0);
    expect(f.subjects()).toEqual([WELCOME_OPEN]);
    expect(f.mail[0]?.text).toContain(id(1));
    expect(f.mail[0]?.text).not.toContain(id(2));
    expect(f.mail[0]?.text).not.toContain(id(3));
    await db
      .prepare("UPDATE signups SET welcome_sent_at = ?2 WHERE signup_id = ?1")
      .bind(id(1), T0 + MIN)
      .run();
    // Row 2 is over 10 minutes old by now: still open.
    await signupTick(f.env, T0 + 6 * MIN);
    expect(f.subjects()).toEqual([WELCOME_OPEN]);
    await db
      .prepare("UPDATE signups SET welcome_sent_at = ?2 WHERE signup_id = ?1")
      .bind(id(2), T0 + 7 * MIN)
      .run();
    await signupTick(f.env, T0 + 8 * MIN);
    expect(f.subjects()).toEqual([WELCOME_OPEN, WELCOME_CLEAR]);
  });

  it("a welcome claimed under 10 minutes ago doesn't alert", async () => {
    const f = fakes({});
    await seed({ 1: { status: "creating", claimed: T0 - 9 * MIN } });
    await signupTick(f.env, T0);
    expect(f.subjects()).toEqual([]);
  });

  it("alert text has no email", async () => {
    const lines = logs();
    const f = fakes({ cap: "1", instances: { [id(4)]: "errored" } });
    await seed({
      1: { status: "waiting_cap", updated: T0 },
      2: { status: "failed", updated: T0 - H },
      3: { status: "ready", claimed: T0 - H },
      4: { status: "queued", updated: T0 - H, admitted: T0 - H },
    });
    await signupTick(f.env, T0);
    expect(f.subjects().sort()).toEqual(
      [CAP_OPEN, FAIL_OPEN, STUCK_OPEN, WELCOME_OPEN].sort(),
    );
    await db.prepare("DELETE FROM signups").run();
    await signupTick(f.env, T0 + 2 * MIN);
    expect(f.mail).toHaveLength(8);
    for (const m of f.mail) {
      expect(`${m.subject}\n${m.text}`).not.toMatch(/@/);
    }
    expect(f.mail.find((m) => m.subject === CAP_OPEN)?.text).toContain(
      "1 signup",
    );
    const all = lines.join("\n").toLowerCase();
    expect(all).not.toContain(EMAIL.toLowerCase());
    expect(all).not.toContain("example.com");
  });

  it("the tick never throws, even with D1 and the queue failing", async () => {
    const boom = () => {
      throw new Error(`d1 down ${EMAIL}`);
    };
    const lines = logs();
    const f = fakes({});
    const env = {
      ...f.env,
      PLATFORM_DB: { prepare: boom, batch: boom },
      SIGNUPS: { send: boom, sendBatch: boom },
    } as unknown as SignupsEnv;
    await expect(signupTick(env, T0)).resolves.toBeUndefined();
    expect(lines.join("\n").toLowerCase()).not.toContain("example.com");
  });
});
