import {
  ALERT_KEYS,
  ALERT_LOOKBACK_MS,
  type AlertKey,
  AUDIT_REFUSAL_WINDOW_MS,
  JOB_RETRYING_ATTEMPT,
  JOB_STUCK_MS,
  OAUTH_REGISTER_FLOOD,
  PURGE_STUCK_FAILURES,
  RPC_ALERT_KEYS,
  SIGNIN_BURST_MIN,
  SIGNIN_BURST_WINDOW_MS,
  SIGNIN_REFUSAL_BUCKET,
  SQL_ALERT_KEYS,
  TOKEN_EXPIRING_DAYS,
  type TokenStatus,
  WELCOME_CLAIM_MS,
} from "@oa/shared/provisioning";
import { fakeProvisionerRpc } from "@oa/shared/provisioning/fakes";
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
  alertConditions,
  signupDailyCap,
  sqlConditions,
  tokenConditions,
} from "../src/provapi/conditions.js";
import {
  captureLogs,
  db,
  insert,
  install,
  installId,
  job,
  lifecycle,
  migrate,
  reset,
  signup,
} from "./provapi/db.js";

// Data-driven over ALERT_KEYS: every key has a fixture that opens it, then a
// change (rows or the clock) that clears it. The queries are C2's, run as
// exported; windows come from C2's constants and the clock is pinned.

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const DAY_MS = 24 * 60 * 60_000;
const MIN = 60_000;
const CAP = 3;
// admin_audit is append-only (never reset), so each key's fixture runs at
// its own day, far from the others' windows.
const base = (k: AlertKey) =>
  Date.UTC(2026, 10, 1, 12, 0) + (ALERT_KEYS.indexOf(k) + 1) * 10 * DAY_MS;
const today = (now: number) => now - (now % DAY_MS);

type Ctx = { now: number; install: string };
interface Fixture {
  /** Seeds rows that open the key at ctx.now. */
  open(c: Ctx): Promise<TokenStatus | undefined>;
  /** Changes rows; returns the time to evaluate at (default ctx.now). */
  clear(c: Ctx): Promise<number | TokenStatus | undefined>;
}

const failedJob = (c: Ctx, over: Record<string, string | number | null>) =>
  job(c.install, {
    status: "failed",
    created_at: c.now - 2 * MIN,
    updated_at: c.now - MIN,
    finished_at: c.now - MIN,
    ...over,
  });
const doneJob = (c: Ctx, kind: string) =>
  job(c.install, {
    kind,
    workflow: "manage_install",
    status: "done",
    created_at: c.now,
    updated_at: c.now,
    finished_at: c.now,
  });
const set = (sql: string, ...b: unknown[]) =>
  db
    .prepare(sql)
    .bind(...b)
    .run();

const FIXTURES: Record<AlertKey, Fixture> = {
  signin_refused_burst: {
    async open(c) {
      await insert("audit_refusals", {
        bucket: SIGNIN_REFUSAL_BUCKET,
        code: "signin.bad_flow",
        ip_hmac: "a",
        window_start: c.now - MIN,
        count: SIGNIN_BURST_MIN,
        updated_at: c.now,
      });
      return undefined;
    },
    clear: async (c) =>
      c.now + SIGNIN_BURST_WINDOW_MS + AUDIT_REFUSAL_WINDOW_MS,
  },
  admin_unknown_sub: {
    async open(c) {
      await insert("admin_audit", {
        at: c.now - MIN,
        actor_kind: "admin",
        action: "signin.refused",
        outcome: "refused",
        code: "unknown_sub",
      });
      return undefined;
    },
    clear: async (c) => c.now + ALERT_LOOKBACK_MS,
  },
  job_failed: {
    async open(c) {
      await failedJob(c, { error_code: "cf_error" });
      return undefined;
    },
    async clear(c) {
      await doneJob(c, "retry");
      return undefined;
    },
  },
  job_retrying: {
    async open(c) {
      await job(c.install, {
        status: "running",
        attempt: JOB_RETRYING_ATTEMPT,
        updated_at: c.now - MIN,
      });
      return undefined;
    },
    async clear() {
      await set("UPDATE jobs SET status = 'done'");
      return undefined;
    },
  },
  job_stuck: {
    async open(c) {
      await job(c.install, {
        status: "running",
        updated_at: c.now - JOB_STUCK_MS,
      });
      return undefined;
    },
    async clear(c) {
      await set("UPDATE jobs SET updated_at = ?1", c.now);
      return undefined;
    },
  },
  prod_dirty: {
    async open(c) {
      await failedJob(c, { error_code: "prod_dirty" });
      return undefined;
    },
    async clear(c) {
      await doneJob(c, "discard");
      return undefined;
    },
  },
  prodclean_failed: {
    async open(c) {
      await insert("prodclean_reports", { at: c.now, ok: 0, code: "dirty" });
      return undefined;
    },
    async clear(c) {
      await insert("prodclean_reports", {
        at: c.now + MIN,
        ok: 1,
        code: "pass",
      });
      return undefined;
    },
  },
  upgrade_incomplete: {
    async open(c) {
      await failedJob(c, {
        kind: "upgrade",
        workflow: "manage_install",
        error_code: "upgrade_incomplete",
      });
      return undefined;
    },
    async clear(c) {
      await doneJob(c, "rollback");
      return undefined;
    },
  },
  unreachable_after_route: {
    async open(c) {
      await lifecycle(c.install, {
        serving_mode: "serving",
        health: "failing",
        health_at: c.now,
      });
      await job(c.install, { status: "done", finished_at: c.now - MIN });
      return undefined;
    },
    async clear(c) {
      await set(
        "UPDATE install_lifecycle SET health = 'ok', health_at = ?1",
        c.now,
      );
      return undefined;
    },
  },
  purge_stuck: {
    async open(c) {
      for (let n = 1; n <= PURGE_STUCK_FAILURES; n++)
        await failedJob(c, {
          kind: "purge",
          workflow: "manage_install",
          error_code: "cf_error",
        });
      return undefined;
    },
    async clear(c) {
      await doneJob(c, "purge");
      return undefined;
    },
  },
  welcome_unsent: {
    async open(c) {
      await signup({
        status: "creating",
        send_welcome: 1,
        welcome_claimed_at: c.now - WELCOME_CLAIM_MS,
      });
      return undefined;
    },
    async clear(c) {
      await set("UPDATE signups SET welcome_sent_at = ?1", c.now);
      return undefined;
    },
  },
  signup_cap: {
    async open(c) {
      for (let n = 0; n < CAP; n++)
        await signup({
          source: "self-serve",
          owner_sub: `sub${n}`,
          status: "queued",
          admitted_at: today(c.now) + n,
        });
      return undefined;
    },
    // The next UTC day starts a fresh count.
    clear: async (c) => today(c.now) + DAY_MS,
  },
  oauth_register_flood: {
    async open(c) {
      const ins = db.prepare(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_hosts, ip_hmac, registered_at) VALUES (?1, 'c', '[]', 'h', ?2)",
      );
      await db.batch(
        Array.from({ length: OAUTH_REGISTER_FLOOD + 1 }, (_, n) =>
          ins.bind(`c${n}`, today(c.now) + n),
        ),
      );
      return undefined;
    },
    clear: async (c) => today(c.now) + DAY_MS,
  },
  token_expiring: {
    open: async (c) => ({
      status: "expiring",
      expiresAt: c.now + TOKEN_EXPIRING_DAYS * DAY_MS,
      daysLeft: TOKEN_EXPIRING_DAYS,
    }),
    clear: async (c) => ({
      status: "active",
      expiresAt: c.now + (TOKEN_EXPIRING_DAYS + 1) * DAY_MS,
      daysLeft: TOKEN_EXPIRING_DAYS + 1,
    }),
  },
  token_invalid: {
    open: async () => ({ status: "invalid", expiresAt: null, daysLeft: null }),
    clear: async (c) => ({
      status: "active",
      expiresAt: c.now + 100 * DAY_MS,
      daysLeft: 100,
    }),
  },
};

const ACTIVE: TokenStatus = {
  status: "active",
  expiresAt: 0,
  daysLeft: 100,
};

async function evaluate(now: number, token: TokenStatus = ACTIVE) {
  return alertConditions(db, fakeProvisionerRpc({ tokenStatus: token }), {
    now,
    signupDailyCap: CAP,
  });
}

describe("alert conditions", () => {
  it("every key has a fixture, and SQL plus RPC keys are every key", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...ALERT_KEYS].sort());
    expect([...SQL_ALERT_KEYS, ...RPC_ALERT_KEYS].sort()).toEqual(
      [...ALERT_KEYS].sort(),
    );
  });

  it("an empty database and an active token: every key is clear", async () => {
    const r = await evaluate(Date.UTC(2030, 0, 1));
    for (const k of ALERT_KEYS) expect(r[k].open, k).toBe(false);
  });

  for (const k of ALERT_KEYS)
    it(`${k}: its fixture opens it, a change clears it`, async () => {
      const id = installId();
      await install(id);
      const c = { now: base(k), install: id };
      const token = await FIXTURES[k].open(c);
      const opened = await evaluate(c.now, token);
      expect(opened[k].open, k).toBe(true);
      const after = await FIXTURES[k].clear(c);
      const at = typeof after === "number" ? after : c.now;
      const tok = typeof after === "object" ? after : undefined;
      const cleared = await evaluate(at, tok);
      expect(cleared[k].open, k).toBe(false);
      expect(cleared[k].rows).toEqual([]);
    });
});

describe("unknown conditions are null", () => {
  it("a failing query is null for its key and logs a fixed line", async () => {
    const lines = captureLogs(vi.spyOn);
    const broken = new Proxy(db, {
      get(t, p) {
        if (p === "prepare")
          return (sql: string) => {
            if (sql.includes("prodclean_reports"))
              throw new Error("D1_ERROR owner@customer.test");
            return t.prepare(sql);
          };
        return Reflect.get(t, p);
      },
    });
    const r = await sqlConditions(broken, {
      now: Date.UTC(2030, 0, 1),
      signupDailyCap: CAP,
    });
    expect(r.prodclean_failed.open).toBeNull();
    expect(r.job_failed.open).toBe(false);
    expect(lines).toEqual(["provapi alert prodclean_failed query_error"]);
  });

  it("an RPC throw, a bad shape, a hang or no binding: both token keys null", async () => {
    const lines = captureLogs(vi.spyOn);
    const throws = {
      ...fakeProvisionerRpc(),
      tokenStatus: async () => {
        throw new Error("cf token SECRET");
      },
    };
    const bad = {
      ...fakeProvisionerRpc(),
      tokenStatus: async () =>
        ({ status: "expiring", expiresAt: 1, daysLeft: 300 }) as TokenStatus,
    };
    const hang = {
      ...fakeProvisionerRpc(),
      tokenStatus: () => new Promise<TokenStatus>(() => {}),
    };
    for (const rpc of [throws, bad, hang, undefined]) {
      const r = await tokenConditions(rpc, 10);
      expect(r).toEqual({
        token_expiring: { open: null, rows: [] },
        token_invalid: { open: null, rows: [] },
      });
    }
    expect(lines).toEqual([
      "provapi alert token_status rpc_error",
      "provapi alert token_status parse_error",
      "provapi alert token_status rpc_error",
      "provapi alert token_status unbound",
    ]);
  });

  it("expiring carries whole days left", async () => {
    const r = await tokenConditions(
      fakeProvisionerRpc({
        tokenStatus: { status: "expiring", expiresAt: 1, daysLeft: 3.7 },
      }),
    );
    expect(r.token_expiring).toEqual({ open: true, rows: [], daysLeft: 3 });
  });

  it("SIGNUP_DAILY_CAP: a positive integer, else 0 (the cap alert is off)", () => {
    expect(signupDailyCap("25")).toBe(25);
    for (const v of [
      undefined,
      "",
      "0",
      "-1",
      "2.5",
      "{{SIGNUP_DAILY_CAP_PROD}}",
    ])
      expect(signupDailyCap(v)).toBe(0);
  });
});
