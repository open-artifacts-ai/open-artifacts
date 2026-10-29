import { env as testEnv } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { splitSql } from "../../../packages/provision/test/fake-cf.js";
import { admit, type ConsumerEnv, handleSignup } from "../src/consumer.js";
import { type ProvisionParams, parseSignup } from "../src/message.js";

// The signups consumer against the real platform schema (Miniflare D1) and a
// fake PROVISION_INSTALL that refuses a second create of the same id, as
// Workflows does. SS4 writes each row as pending, with its secret, before it
// enqueues { signupId }; the tests seed rows the same way.

const E = testEnv as unknown as {
  SIGNUPS_DB: D1Database;
  FIXTURE_PLATFORM_SQL: string;
};
const db = E.SIGNUPS_DB;
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");
// Uppercase and "+": redaction must not depend on the address's case.
const EMAIL = "Owner+Tag@Example.COM";
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const id = (n: number) =>
  `01JBQ4ZKXW5V9R3M2N8P6T7Y${B32[n >> 5]}${B32[n & 31]}`;
const slug = (n: number) => `team-${n}`;
const sub = (n: number) => `10000000000000000000${n}`;

/** What SS4 does: the pending row and its secret in one batch. */
const seed = (n: number, at = NOW) =>
  db.batch([
    db
      .prepare(
        "INSERT INTO signups (signup_id, owner_sub, slug, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)",
      )
      .bind(id(n), sub(n), slug(n), at),
    db
      .prepare(
        "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?, ?)",
      )
      .bind(id(n), EMAIL),
  ]);
const setStatus = (n: number, status: string) =>
  db
    .prepare("UPDATE signups SET status = ? WHERE signup_id = ?")
    .bind(status, id(n))
    .run();

class FakeWorkflow {
  instances = new Map<string, ProvisionParams>();
  creates: { id?: string; params?: ProvisionParams }[] = [];
  async create(o: { id?: string; params?: ProvisionParams } = {}) {
    this.creates.push(o);
    const iid = o.id ?? crypto.randomUUID();
    if (this.instances.has(iid))
      throw new Error(
        "instance.already_exists: an instance with this id exists",
      );
    this.instances.set(iid, o.params as ProvisionParams);
    return { id: iid };
  }
  async get(iid: string) {
    if (!this.instances.has(iid)) throw new Error("instance.not_found");
    return { id: iid };
  }
}

const message = (body: unknown, attempts = 1) => ({
  id: crypto.randomUUID(),
  timestamp: new Date(NOW),
  body,
  attempts,
  ack: vi.fn(),
  retry: vi.fn(),
});
const msg = (n: number, attempts = 1) => message({ signupId: id(n) }, attempts);

let wf: FakeWorkflow;
let logs: string[];
let env: ConsumerEnv;
const mkEnv = (
  cap = "20",
  platformDb: D1Database = db,
  enabled = "true",
): ConsumerEnv => ({
  PLATFORM_DB: platformDb,
  PROVISION_INSTALL: wf as unknown as Workflow<ProvisionParams>,
  SIGNUP_DAILY_CAP: cap,
  SIGNUPS_ENABLED: enabled,
});
const outcomes = () =>
  logs.map((l) => (JSON.parse(l) as { outcome: string }).outcome);

const rows = async () =>
  (
    await db
      .prepare(
        "SELECT signup_id, owner_sub, slug, install_id, status, admitted_at, created_at, updated_at FROM signups ORDER BY signup_id",
      )
      .all()
  ).results;
const secrets = async () =>
  (await db.prepare("SELECT * FROM signup_secret ORDER BY signup_id").all())
    .results;

beforeAll(async () => {
  for (const s of splitSql(E.FIXTURE_PLATFORM_SQL)) await db.prepare(s).run();
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM signups"),
    db.prepare("DELETE FROM signup_secret"),
  ]);
  wf = new FakeWorkflow();
  logs = [];
  env = mkEnv();
  vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  // Nothing the consumer wrote or said holds the email.
  const out = JSON.stringify({ logs, creates: wf.creates }).toLowerCase();
  expect(out).not.toContain("example.com");
  expect(out).not.toContain("owner+tag");
});

describe("parseSignup", () => {
  it("accepts exactly { signupId: <ULID> }", () => {
    expect(parseSignup({ signupId: id(1) })).toEqual({ signupId: id(1) });
    for (const bad of [
      null,
      "x",
      [],
      {},
      { signupId: id(1), slug: "x" },
      { signupId: id(1).toLowerCase() },
      { signupId: `8${id(1).slice(1)}` },
      { signupId: `${id(1)}0` },
      { signupId: id(1).slice(0, 25) },
      { signupId: `${id(1).slice(0, 25)}I` },
      { signupId: 1 },
    ])
      expect(parseSignup(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("handleSignup", () => {
  it("bad shapes are acked, never retried", async () => {
    await seed(1);
    for (const body of [
      { signupId: id(1), extra: 1 },
      { signupId: id(1).toLowerCase() },
      { signupId: id(1), ownerEmail: EMAIL },
    ]) {
      const m = message(body);
      await handleSignup(m, env, NOW);
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(outcomes()).toEqual(["bad_shape", "bad_shape", "bad_shape"]);
    expect(await rows()).toMatchObject([{ status: "pending" }]);
    expect(wf.creates).toEqual([]);
  });

  it("pending under the cap: queued, admitted_at set, one workflow start from the stored row, then ack", async () => {
    await seed(1, NOW - 5000);
    const m = msg(1);
    await handleSignup(m, env, NOW);
    expect(await rows()).toEqual([
      {
        signup_id: id(1),
        owner_sub: sub(1),
        slug: slug(1),
        install_id: null,
        status: "queued",
        admitted_at: NOW,
        created_at: NOW - 5000,
        updated_at: NOW,
      },
    ]);
    expect(wf.creates).toEqual([
      {
        id: id(1),
        params: { signupId: id(1), slug: slug(1), ownerSub: sub(1) },
      },
    ]);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    // The secret is SS4's: the consumer neither writes nor removes it.
    expect(await secrets()).toEqual([{ signup_id: id(1), owner_email: EMAIL }]);
  });

  it("signups disabled: acked, logged disabled, the row stays pending and nothing starts", async () => {
    for (const [n, enabled] of [
      [1, "false"],
      [2, ""],
      [3, "TRUE"],
      [4, "true "],
    ] as const) {
      await seed(n, NOW - 5000);
      const before = await rows();
      const m = msg(n);
      logs = [];
      await handleSignup(m, mkEnv("20", db, enabled), NOW);
      expect(outcomes(), enabled).toEqual(["disabled"]);
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
      expect(await rows()).toEqual(before);
    }
    expect(wf.creates).toEqual([]);
  });

  it("redelivery during create: running, the start returns 'already exists', ack", async () => {
    await seed(1);
    await handleSignup(msg(1), env, NOW);
    await setStatus(1, "creating");
    expect(await admit(db, id(1), 20, NOW + 1000)).toBe("running");
    const again = msg(1, 2);
    await handleSignup(again, env, NOW + 2000);
    expect(wf.creates).toHaveLength(2);
    expect(wf.instances.size).toBe(1);
    expect(again.ack).toHaveBeenCalledOnce();
    expect(again.retry).not.toHaveBeenCalled();
    // admitted_at stays the first admission's.
    expect(await rows()).toMatchObject([
      { status: "creating", admitted_at: NOW },
    ]);
  });

  it("a redelivery of a queued row whose start was lost starts it", async () => {
    await seed(1);
    expect(await admit(db, id(1), 20, NOW)).toBe("queued");
    const m = msg(1, 2);
    await handleSignup(m, env, NOW);
    expect([...wf.instances.keys()]).toEqual([id(1)]);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("a settled row is acked and never restarted", async () => {
    for (const [n, st] of [
      [1, "ready"],
      [2, "failed"],
    ] as const) {
      await seed(n);
      await setStatus(n, st);
      expect(await admit(db, id(n), 20, NOW)).toBe("settled");
      const m = msg(n, 2);
      await handleSignup(m, env, NOW);
      expect(m.ack).toHaveBeenCalledOnce();
    }
    expect(wf.creates).toEqual([]);
    expect(outcomes()).toEqual(["settled", "settled"]);
  });

  it("a missing row retries", async () => {
    const m = msg(1);
    await handleSignup(m, env, NOW);
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(wf.creates).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(outcomes()).toEqual(["missing"]);
  });

  it("over the cap: waiting_cap, no start, ack", async () => {
    env = mkEnv("1");
    await seed(1);
    await seed(2);
    await handleSignup(msg(1), env, NOW);
    const over = msg(2);
    await handleSignup(over, env, NOW);
    expect(
      (await rows()).map((r) => [r.signup_id, r.status, r.admitted_at]),
    ).toEqual([
      [id(1), "queued", NOW],
      [id(2), "waiting_cap", null],
    ]);
    expect([...wf.instances.keys()]).toEqual([id(1)]);
    expect(over.ack).toHaveBeenCalledOnce();
    expect(over.retry).not.toHaveBeenCalled();
    // A redelivery the same day stays deferred.
    await handleSignup(msg(2, 2), env, NOW + 1000);
    expect([...wf.instances.keys()]).toEqual([id(1)]);
  });

  it("concurrent at the boundary", async () => {
    for (const n of [1, 2, 3, 4, 5]) await seed(n);
    env = mkEnv("2");
    const ms = [1, 2, 3, 4, 5].map((n) => msg(n));
    await Promise.all(ms.map((m) => handleSignup(m, env, NOW)));
    const st = (await rows()).map((r) => r.status);
    expect(st.filter((s) => s === "queued")).toHaveLength(2);
    expect(st.filter((s) => s === "waiting_cap")).toHaveLength(3);
    expect(wf.instances.size).toBe(2);
    for (const m of ms) expect(m.ack).toHaveBeenCalledOnce();
  });

  it("a promoted waiting_cap row counts toward the day it's admitted into", async () => {
    env = mkEnv("1");
    await seed(1);
    await seed(2);
    await handleSignup(msg(1), env, NOW);
    await handleSignup(msg(2), env, NOW);
    expect(await admit(db, id(2), 1, NOW)).toBe("waiting_cap");
    // The next UTC day: the scheduler re-enqueues it; it takes that day's slot.
    const tomorrow = NOW + DAY;
    await handleSignup(msg(2, 1), env, tomorrow);
    await seed(3, tomorrow);
    await handleSignup(msg(3), env, tomorrow);
    expect(
      (await rows()).map((r) => [r.signup_id, r.status, r.admitted_at]),
    ).toEqual([
      [id(1), "queued", NOW],
      [id(2), "queued", tomorrow],
      [id(3), "waiting_cap", null],
    ]);
    expect([...wf.instances.keys()]).toEqual([id(1), id(2)]);
  });

  it("the day starts at 00:00 UTC, and a failed admitted row still counts", async () => {
    const lateYesterday = Date.parse("2026-10-28T23:59:59Z");
    await seed(1, lateYesterday);
    await seed(2);
    await seed(3);
    expect(await admit(db, id(1), 1, lateYesterday)).toBe("queued");
    expect(await admit(db, id(2), 1, NOW)).toBe("queued");
    await setStatus(2, "failed");
    expect(await admit(db, id(3), 1, NOW)).toBe("waiting_cap");
  });

  it("an invalid cap retries and logs cap_config", async () => {
    await seed(1);
    const caps = [
      "{{SIGNUP_DAILY_CAP_STAGING}}",
      "",
      "0",
      "-1",
      "1.5",
      "020",
      "10000",
    ];
    for (const cap of caps) {
      const m = msg(1);
      await handleSignup(m, mkEnv(cap), NOW);
      expect(m.retry, cap).toHaveBeenCalledOnce();
      expect(m.ack, cap).not.toHaveBeenCalled();
    }
    expect(outcomes()).toEqual(caps.map(() => "cap_config"));
    expect(await rows()).toMatchObject([{ status: "pending" }]);
    expect(wf.creates).toEqual([]);
    // The bounds themselves are fine.
    for (const cap of ["1", "9999"]) {
      await db.prepare("DELETE FROM signups").run();
      await db.prepare("DELETE FROM signup_secret").run();
      await seed(1);
      const m = msg(1);
      await handleSignup(m, mkEnv(cap), NOW);
      expect(m.ack, cap).toHaveBeenCalledOnce();
    }
  });

  it("workflow params carry no email, and come from the row, not the message", async () => {
    for (const n of [1, 2, 3]) await seed(n);
    // A body with more than the id is refused before anything runs.
    await handleSignup(
      message({ signupId: id(1), slug: "evil", ownerSub: "1" }),
      env,
      NOW,
    );
    expect(wf.creates).toEqual([]);
    await Promise.all([1, 2, 3].map((n) => handleSignup(msg(n), env, NOW)));
    expect(wf.creates).toHaveLength(3);
    for (const c of wf.creates) {
      const n = [1, 2, 3].find((k) => id(k) === c.id) ?? 0;
      expect(c.params).toEqual({
        signupId: id(n),
        slug: slug(n),
        ownerSub: sub(n),
      });
      expect(JSON.stringify(c)).not.toMatch(/@/);
    }
  });

  it("a D1 or Workflows error retries, logging no error text", async () => {
    await seed(1);
    const broken = mkEnv("20", {
      prepare: () => {
        throw new Error(`D1_ERROR: boom ${EMAIL}`);
      },
    } as unknown as D1Database);
    const a = msg(1);
    await handleSignup(a, broken, NOW);
    expect(a.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(a.ack).not.toHaveBeenCalled();
    wf.create = async () => {
      throw new Error(`workflows unavailable ${EMAIL}`);
    };
    const b = msg(1);
    await handleSignup(b, env, NOW);
    expect(b.retry).toHaveBeenCalledOnce();
    expect(b.ack).not.toHaveBeenCalled();
    // Admitted, so the redelivery starts it.
    expect(await rows()).toMatchObject([{ status: "queued" }]);
    expect(outcomes()).toEqual(["retry", "retry"]);
  });
});
