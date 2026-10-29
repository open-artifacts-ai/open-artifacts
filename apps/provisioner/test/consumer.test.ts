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
import {
  type ConsumerEnv,
  type DlqPayload,
  handleSignup,
  MAX_RETRIES,
  recordSignup,
} from "../src/consumer.js";
import {
  type ProvisionParams,
  parseSignup,
  type SignupMessage,
} from "../src/message.js";

// The signups consumer against the real platform schema (Miniflare D1) and a
// fake PROVISION_INSTALL that refuses a second create of the same id, as
// Workflows does.

const E = testEnv as unknown as {
  SIGNUPS_DB: D1Database;
  FIXTURE_PLATFORM_SQL: string;
};
const db = E.SIGNUPS_DB;
const NOW = Date.parse("2026-10-29T12:00:00Z");
// Uppercase and "+": redaction must not depend on the address's case.
const EMAIL = "Owner+Tag@Example.COM";
const id = (n: number) =>
  `01JBQ4ZKXW5V9R3M2N8P6T7Y${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[n >> 5]}${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[n & 31]}`;
const signup = (n: number, over: Partial<SignupMessage> = {}) => ({
  signupId: id(n),
  slug: `team-${n}`,
  ownerSub: `10000000000000000000${n}`,
  ownerEmail: EMAIL,
  tier: "free" as const,
  ...over,
});

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

let wf: FakeWorkflow;
let dlq: DlqPayload[];
let logs: string[];
let env: ConsumerEnv;
const mkEnv = (cap = "20", platformDb: D1Database = db): ConsumerEnv => ({
  PLATFORM_DB: platformDb,
  PROVISION_INSTALL: wf as unknown as Workflow<ProvisionParams>,
  SIGNUPS_DLQ: {
    send: async (p: DlqPayload) => {
      dlq.push(p);
    },
  } as unknown as Queue<DlqPayload>,
  SIGNUP_DAILY_CAP: cap,
});

const rows = async () =>
  (
    await db
      .prepare(
        "SELECT signup_id, owner_sub, slug, install_id, status, error, created_at FROM signups ORDER BY signup_id",
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
  dlq = [];
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
  // Nothing any test wrote outside signup_secret holds the email.
  const out = JSON.stringify({ logs, dlq, creates: wf.creates });
  expect(out.toLowerCase()).not.toContain("example.com");
  expect(out.toLowerCase()).not.toContain("owner+tag");
});

describe("parseSignup", () => {
  it("accepts the message and nothing else", () => {
    expect(parseSignup(signup(1))).toEqual(signup(1));
    // 254 characters is the longest address accepted; 255 is refused (below).
    const longest = `${"a".repeat(248)}@b.com`;
    expect(longest).toHaveLength(254);
    expect(parseSignup(signup(1, { ownerEmail: longest }))).not.toBeNull();
    for (const bad of [
      null,
      "x",
      [],
      { ...signup(1), extra: 1 },
      { ...signup(1), tier: "pro" },
      { ...signup(1), signupId: "not-a-ulid" },
      { ...signup(1), signupId: id(1).toLowerCase() },
      { ...signup(1), slug: "Bad_Slug" },
      { ...signup(1), slug: "admin" },
      { ...signup(1), slug: "ab--cd" },
      { ...signup(1), ownerSub: "abc" },
      { ...signup(1), ownerSub: "1".repeat(256) },
      { ...signup(1), ownerEmail: "no-at-sign" },
      { ...signup(1), ownerEmail: `${"a".repeat(250)}@b.co` },
      { ...signup(1), ownerEmail: `${"a".repeat(249)}@b.com` },
      { ...signup(1), ownerEmail: "a@b.co\r\nBcc: x@y.z" },
      { ...signup(1), ownerEmail: "a@b.co\r\n" },
      { ...signup(1), ownerEmail: "a\n@b.co" },
      { ...signup(1), ownerEmail: 7 },
    ])
      expect(parseSignup(bad)).toBeNull();
  });
});

describe("handleSignup", () => {
  it("bad shapes go to the DLQ with the signup id only", async () => {
    const withId = message({ ...signup(1), tier: "pro" });
    const noId = message({ ownerEmail: EMAIL, signupId: 42 });
    await handleSignup(withId, env, NOW);
    await handleSignup(noId, env, NOW);
    expect(dlq).toEqual([{ signupId: id(1) }, { signupId: null }]);
    // Dead-lettered by us (so the runtime never DLQs the body), then acked.
    for (const m of [withId, noId]) {
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(await rows()).toEqual([]);
    expect(await secrets()).toEqual([]);
    expect(wf.creates).toEqual([]);
  });

  it("queued: one row, one secret row, one workflow start, then ack", async () => {
    const m = message(signup(1));
    await handleSignup(m, env, NOW);
    expect(await rows()).toEqual([
      {
        signup_id: id(1),
        owner_sub: signup(1).ownerSub,
        slug: "team-1",
        install_id: null,
        status: "queued",
        error: null,
        created_at: NOW,
      },
    ]);
    expect(await secrets()).toEqual([{ signup_id: id(1), owner_email: EMAIL }]);
    expect(wf.creates).toEqual([
      {
        id: id(1),
        params: {
          signupId: id(1),
          slug: "team-1",
          ownerSub: signup(1).ownerSub,
        },
      },
    ]);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it("redelivery during create: recordSignup says exists, the start returns 'already exists', ack, still one row", async () => {
    await handleSignup(message(signup(1)), env, NOW);
    // The Workflow's reserve step has moved the row on.
    await db
      .prepare("UPDATE signups SET status = 'creating' WHERE signup_id = ?")
      .bind(id(1))
      .run();
    expect(await recordSignup(db, signup(1), 20, NOW + 1000)).toBe("exists");
    const again = message(signup(1), 2);
    await handleSignup(again, env, NOW + 2000);
    expect(wf.creates).toHaveLength(2);
    expect(wf.instances.size).toBe(1);
    expect(again.ack).toHaveBeenCalledOnce();
    expect(again.retry).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([
      { signup_id: id(1), status: "creating", created_at: NOW },
    ]);
    expect(await secrets()).toHaveLength(1);
  });

  it("a redelivery after the first start was lost starts it", async () => {
    // Recorded, then the consumer died before create.
    expect(await recordSignup(db, signup(1), 20, NOW)).toBe("queued");
    const m = message(signup(1), 2);
    await handleSignup(m, env, NOW);
    expect([...wf.instances.keys()]).toEqual([id(1)]);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("a redelivery after done neither restarts nor rewrites the secret", async () => {
    await handleSignup(message(signup(1)), env, NOW);
    await db.batch([
      db
        .prepare("UPDATE signups SET status = 'ready' WHERE signup_id = ?")
        .bind(id(1)),
      db.prepare("DELETE FROM signup_secret WHERE signup_id = ?").bind(id(1)),
    ]);
    const m = message(signup(1), 2);
    await handleSignup(m, env, NOW);
    expect(wf.creates).toHaveLength(1);
    expect(await secrets()).toEqual([]);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("over the cap: waiting_cap, no workflow start, ack", async () => {
    env = mkEnv("1");
    await handleSignup(message(signup(1)), env, NOW);
    const over = message(signup(2));
    await handleSignup(over, env, NOW);
    expect((await rows()).map((r) => [r.signup_id, r.status])).toEqual([
      [id(1), "queued"],
      [id(2), "waiting_cap"],
    ]);
    // Kept for the scheduler's re-enqueue after 00:00 UTC.
    expect(await secrets()).toHaveLength(2);
    expect([...wf.instances.keys()]).toEqual([id(1)]);
    expect(over.ack).toHaveBeenCalledOnce();
    expect(over.retry).not.toHaveBeenCalled();
    // A redelivery of the deferred one starts nothing either.
    await handleSignup(message(signup(2), 2), env, NOW);
    expect([...wf.instances.keys()]).toEqual([id(1)]);
  });

  it("the cap counts today's (UTC) non-failed rows only", async () => {
    const yesterday = Date.parse("2026-10-28T23:59:59Z");
    expect(await recordSignup(db, signup(1), 1, yesterday)).toBe("queued");
    expect(await recordSignup(db, signup(2), 1, NOW)).toBe("queued");
    await db
      .prepare("UPDATE signups SET status = 'failed' WHERE signup_id = ?")
      .bind(id(2))
      .run();
    expect(await recordSignup(db, signup(3), 1, NOW)).toBe("queued");
    expect(await recordSignup(db, signup(4), 1, NOW)).toBe("waiting_cap");
  });

  it("a bad cap is a config error: logged and retried, never deferred", async () => {
    for (const cap of [
      "{{SIGNUP_DAILY_CAP_STAGING}}",
      "",
      "0",
      "-1",
      "1.5",
      "020",
      "10000",
    ]) {
      const m = message(signup(1));
      await handleSignup(m, mkEnv(cap), NOW);
      expect(m.retry, cap).toHaveBeenCalledOnce();
      expect(m.ack, cap).not.toHaveBeenCalled();
    }
    expect(await rows()).toEqual([]);
    expect(wf.creates).toEqual([]);
    expect(logs.filter((l) => l.includes('"cap_config"'))).toHaveLength(7);
    // The bounds themselves are fine.
    for (const cap of ["1", "9999"]) {
      const m = message(signup(cap.length));
      await handleSignup(m, mkEnv(cap), NOW);
      expect(m.ack).toHaveBeenCalledOnce();
    }
  });

  it("a redelivery with another slug or sub is dead-lettered, never started", async () => {
    await handleSignup(message(signup(1)), env, NOW);
    for (const over of [{ slug: "other" }, { ownerSub: "999" }]) {
      const m = message(signup(1, over), 2);
      await handleSignup(m, env, NOW);
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(dlq).toEqual([{ signupId: id(1) }, { signupId: id(1) }]);
    expect(logs.filter((l) => l.includes('"mismatch"'))).toHaveLength(2);
    // Only the first delivery started, with the stored values.
    expect(wf.creates).toEqual([
      {
        id: id(1),
        params: {
          signupId: id(1),
          slug: "team-1",
          ownerSub: signup(1).ownerSub,
        },
      },
    ]);
    expect(await rows()).toMatchObject([{ slug: "team-1", status: "queued" }]);
  });

  it("a DLQ send failure retries; the last delivery is acked and dropped", async () => {
    const down = {
      ...mkEnv(),
      SIGNUPS_DLQ: {
        send: async () => {
          throw new Error("queue unavailable");
        },
      } as unknown as Queue<DlqPayload>,
    };
    const bad = { ...signup(1), tier: "pro" };
    const first = message(bad, 1);
    await handleSignup(first, down, NOW);
    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    const last = message(bad, MAX_RETRIES + 1);
    await handleSignup(last, down, NOW);
    expect(last.retry).not.toHaveBeenCalled();
    expect(last.ack).toHaveBeenCalledOnce();
    expect(dlq).toEqual([]);
    expect(logs.filter((l) => l.includes('"dropped"'))).toEqual([
      JSON.stringify({ event: "signup", signupId: id(1), outcome: "dropped" }),
    ]);
    // A body with no parseable id is dropped with a null id.
    const anon = message({ ownerEmail: EMAIL }, MAX_RETRIES + 1);
    await handleSignup(anon, down, NOW);
    expect(anon.ack).toHaveBeenCalledOnce();
    expect(logs.at(-1)).toBe(
      JSON.stringify({ event: "signup", signupId: null, outcome: "dropped" }),
    );
    expect(await rows()).toEqual([]);
    expect(await secrets()).toEqual([]);
  });

  it("concurrent at the boundary", async () => {
    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => recordSignup(db, signup(n), 2, NOW)),
    );
    expect(out.filter((o) => o === "queued")).toHaveLength(2);
    expect(out.filter((o) => o === "waiting_cap")).toHaveLength(3);
    const st = (await rows()).map((r) => r.status);
    expect(st.filter((s) => s === "queued")).toHaveLength(2);
    expect(st.filter((s) => s === "waiting_cap")).toHaveLength(3);
  });

  it("workflow params carry no email", async () => {
    await Promise.all(
      [1, 2, 3].map((n) => handleSignup(message(signup(n)), env, NOW)),
    );
    expect(wf.creates).toHaveLength(3);
    for (const c of wf.creates) {
      expect(Object.keys(c.params ?? {}).sort()).toEqual([
        "ownerSub",
        "signupId",
        "slug",
      ]);
      expect(JSON.stringify(c)).not.toMatch(/@/);
    }
    // The email is in signup_secret and in no other row.
    expect(JSON.stringify(await rows())).not.toMatch(/@/);
  });

  it("a failure retries with backoff; the last delivery dead-letters the id only", async () => {
    const broken = mkEnv("20", {
      prepare: (sql: string) => db.prepare(sql),
      batch: async () => {
        throw new Error(`D1_ERROR: boom ${EMAIL}`);
      },
    } as unknown as D1Database);
    const first = message(signup(1), 1);
    await handleSignup(first, broken, NOW);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(first.ack).not.toHaveBeenCalled();
    const last = message(signup(1), MAX_RETRIES + 1);
    await handleSignup(last, broken, NOW);
    expect(last.retry).not.toHaveBeenCalled();
    expect(last.ack).toHaveBeenCalledOnce();
    expect(dlq).toEqual([{ signupId: id(1) }]);
  });

  it("a workflow create that fails without an instance retries", async () => {
    wf.create = async () => {
      throw new Error("workflows unavailable");
    };
    const m = message(signup(1));
    await handleSignup(m, env, NOW);
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledOnce();
    // The row stays queued, so the redelivery starts it.
    expect(await rows()).toMatchObject([{ status: "queued" }]);
  });
});
