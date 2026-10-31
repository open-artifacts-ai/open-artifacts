import { AUDIT_REFUSAL_WINDOW_MS } from "@oa/shared/provisioning";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ProvapiEnv } from "../src/provapi/env.js";
import {
  AUDIT_REFUSAL_RETENTION_MS,
  FAILED_SECRET_RETENTION_MS,
  OAUTH_CLIENT_UNCLAIMED_MS,
  PRUNE_BATCH,
  prune,
  RATE_COUNTER_RETENTION_MS,
} from "../src/provapi/prune.js";
import {
  captureLogs,
  db,
  insert,
  migrate,
  reset,
  rows,
  signup,
} from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const env = { PLATFORM_DB: db, OA_ENV: "staging" } as unknown as ProvapiEnv;
const ids = async (sql: string) =>
  (await rows(sql)).map((r) => Object.values(r)[0]);

let n = 0;
const session = (expires: number, revoked: number | null = null) =>
  insert("sessions", {
    id_hash: `s${++n}`,
    kind: "admin",
    host: "admin.test",
    email: "a@x.test",
    sub: "sub",
    auth_at: 0,
    created_at: 0,
    expires_at: expires,
    revoked_at: revoked,
  });
const token = (
  kind: "oat" | "oauth",
  expires: number,
  revoked: number | null = null,
) =>
  insert("agent_tokens", {
    id: `t${++n}`,
    kind,
    token_hash: kind === "oat" ? `h${n}` : null,
    client_id: kind === "oauth" ? "c" : null,
    oauth_user: kind === "oauth" ? "adm_1" : null,
    session_hash: "s",
    admin_email: "a@x.test",
    label: "l",
    scopes: "[]",
    created_at: 0,
    expires_at: expires,
    revoked_at: revoked,
  });

describe("prune", () => {
  it("each table: rows on each side of its boundary", async () => {
    await session(NOW); // expired at now: pruned
    await session(NOW + 1); // live
    await session(NOW + 1, NOW - 1); // revoked, not expired: kept
    await session(NOW, NOW - 1); // revoked and expired: pruned
    await token("oat", NOW);
    await token("oauth", NOW + 1);
    await token("oauth", NOW + 1, NOW - 1); // revoked, not expired: kept
    await token("oat", NOW, NOW - 1);
    await token("oat", NOW + 1);
    const rc = (w: number) =>
      insert("rate_counters", { key: `k${++n}`, window_start: w, count: 1 });
    await rc(NOW - RATE_COUNTER_RETENTION_MS);
    await rc(NOW - RATE_COUNTER_RETENTION_MS + 1);
    const ar = (w: number) =>
      insert("audit_refusals", {
        bucket: "signin",
        code: "c",
        ip_hmac: `ip${++n}`,
        window_start: w,
        count: 1,
        updated_at: w,
      });
    await ar(NOW - AUDIT_REFUSAL_RETENTION_MS);
    await ar(NOW - AUDIT_REFUSAL_RETENTION_MS + AUDIT_REFUSAL_WINDOW_MS);
    const audit = await rows("SELECT COUNT(*) AS n FROM admin_audit");
    await insert("admin_audit", {
      at: 0,
      actor_kind: "admin",
      action: "old",
      outcome: "ok",
    });

    const lines = captureLogs(vi.spyOn);
    await prune(env, NOW);
    expect(lines).toEqual([
      "provapi prune sessions=2 agent_tokens=2 rate_counters=1 audit_refusals=1 signup_secret=0 oauth_clients=0",
    ]);
    expect(
      await rows(
        "SELECT expires_at, revoked_at FROM sessions ORDER BY revoked_at",
      ),
    ).toEqual([
      { expires_at: NOW + 1, revoked_at: null },
      { expires_at: NOW + 1, revoked_at: NOW - 1 },
    ]);
    expect(
      await rows(
        "SELECT kind, expires_at, revoked_at FROM agent_tokens ORDER BY kind, revoked_at",
      ),
    ).toEqual([
      { kind: "oat", expires_at: NOW + 1, revoked_at: null },
      { kind: "oauth", expires_at: NOW + 1, revoked_at: null },
      { kind: "oauth", expires_at: NOW + 1, revoked_at: NOW - 1 },
    ]);
    expect(await ids("SELECT window_start FROM rate_counters")).toEqual([
      NOW - RATE_COUNTER_RETENTION_MS + 1,
    ]);
    expect(await ids("SELECT window_start FROM audit_refusals")).toEqual([
      NOW - AUDIT_REFUSAL_RETENTION_MS + AUDIT_REFUSAL_WINDOW_MS,
    ]);
    // admin_audit is never touched.
    expect((await rows("SELECT COUNT(*) AS n FROM admin_audit"))[0]?.n).toBe(
      Number(audit[0]?.n) + 1,
    );
  });

  it("a failed signup's owner email goes once it is past the redrive window; others stay", async () => {
    const at = NOW - FAILED_SECRET_RETENTION_MS;
    const gone = await signup({ status: "failed", updated_at: at });
    const recent = await signup({ status: "failed", updated_at: at + 1 });
    const live = await signup({ status: "pending", updated_at: at - 1 });
    for (const id of [gone, recent, live])
      await insert("signup_secret", {
        signup_id: id,
        owner_email: "o@customer.test",
      });
    captureLogs(vi.spyOn);
    await prune(env, NOW);
    expect(
      await ids("SELECT signup_id FROM signup_secret ORDER BY signup_id"),
    ).toEqual([recent, live].sort());
  });

  it("an unclaimed OAuth client goes after a day; a claimed one stays", async () => {
    const client = (registered: number, grant: number | null) =>
      insert("oauth_clients", {
        client_id: `c${++n}`,
        client_name: "n",
        redirect_hosts: "[]",
        ip_hmac: "ip",
        registered_at: registered,
        first_grant_at: grant,
      });
    await client(NOW - OAUTH_CLIENT_UNCLAIMED_MS, null); // pruned
    await client(NOW - OAUTH_CLIENT_UNCLAIMED_MS + 1, null);
    await client(NOW - 2 * OAUTH_CLIENT_UNCLAIMED_MS, NOW - OAUTH_CLIENT_UNCLAIMED_MS);
    captureLogs(vi.spyOn);
    await prune(env, NOW);
    expect(
      await rows(
        "SELECT registered_at, first_grant_at FROM oauth_clients ORDER BY registered_at",
      ),
    ).toEqual([
      {
        registered_at: NOW - 2 * OAUTH_CLIENT_UNCLAIMED_MS,
        first_grant_at: NOW - OAUTH_CLIENT_UNCLAIMED_MS,
      },
      { registered_at: NOW - OAUTH_CLIENT_UNCLAIMED_MS + 1, first_grant_at: null },
    ]);
  });

  it("90 days of audit_refusals; counters past the longest window (a day)", () => {
    expect(AUDIT_REFUSAL_RETENTION_MS).toBe(90 * 24 * 60 * 60_000);
    expect(RATE_COUNTER_RETENTION_MS).toBe(24 * 60 * 60_000);
  });

  it(`bounded: at most ${PRUNE_BATCH} rows per table per tick`, async () => {
    const ins = db.prepare(
      "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, 0, 1)",
    );
    await db.batch(
      Array.from({ length: PRUNE_BATCH + 5 }, (_, i) => ins.bind(`k${i}`)),
    );
    captureLogs(vi.spyOn);
    await prune(env, NOW);
    expect((await rows("SELECT COUNT(*) AS n FROM rate_counters"))[0]?.n).toBe(
      5,
    );
    await prune(env, NOW);
    expect((await rows("SELECT COUNT(*) AS n FROM rate_counters"))[0]?.n).toBe(
      0,
    );
  });
});
