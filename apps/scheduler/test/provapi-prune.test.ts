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
  PRUNE_BATCH,
  prune,
  RATE_COUNTER_RETENTION_MS,
} from "../src/provapi/prune.js";
import { captureLogs, db, insert, migrate, reset, rows } from "./provapi/db.js";

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
    await session(NOW + 1, NOW - 1); // revoked: pruned
    await token("oat", NOW);
    await token("oauth", NOW + 1);
    await token("oauth", NOW + 1, NOW - 1);
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
      "provapi prune sessions=2 agent_tokens=2 rate_counters=1 audit_refusals=1",
    ]);
    expect(await rows("SELECT expires_at, revoked_at FROM sessions")).toEqual([
      { expires_at: NOW + 1, revoked_at: null },
    ]);
    expect(
      await rows(
        "SELECT kind, expires_at, revoked_at FROM agent_tokens ORDER BY kind",
      ),
    ).toEqual([
      { kind: "oat", expires_at: NOW + 1, revoked_at: null },
      { kind: "oauth", expires_at: NOW + 1, revoked_at: null },
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
