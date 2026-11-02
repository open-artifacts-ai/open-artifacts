// The C2 alert-condition queries (@oa/shared provisioning/alerts.ts) on the
// real platform schema: each opens on its fixture and stays shut on a near
// miss. The scheduler (W7) and R27 run these same queries.
import type { DatabaseSync } from "node:sqlite";
import {
  ALERT_CONDITIONS,
  type AlertRow,
  alertParams,
  SIGNIN_REFUSAL_BUCKET,
  SQL_ALERT_KEYS,
  type SqlAlertKey,
} from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import { insert, job, lifecycle, platformDb, signup } from "./platform-db.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = Date.parse("2026-10-31T00:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = 3;

const run = (db: DatabaseSync, key: SqlAlertKey, now = NOW): AlertRow[] =>
  db
    .prepare(ALERT_CONDITIONS[key].sql)
    .all(
      ...alertParams(key, { now, signupDailyCap: CAP }),
    ) as unknown as AlertRow[];
const refused = (db: DatabaseSync, at: number, code = "not_listed") =>
  insert(db, "admin_audit", {
    at,
    actor_kind: "admin",
    action: "signin.refused",
    outcome: "refused",
    code,
  });

describe("alert conditions", () => {
  it("every query runs on the real schema and is shut on an empty database", () => {
    const db = platformDb();
    for (const k of SQL_ALERT_KEYS) expect(run(db, k), k).toEqual([]);
  });

  it("rows have one shape: install, job, kind, code, message, since", () => {
    const db = platformDb();
    job(db, "i1", {
      status: "failed",
      error_code: "health",
      error_message: "x".repeat(300),
      finished_at: NOW - MIN,
    });
    const [row] = run(db, "job_failed");
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "code",
      "install_id",
      "job_id",
      "job_kind",
      "message",
      "since",
    ]);
    expect(row?.message).toHaveLength(200);
  });

  it("signin_refused_burst: 5 refusals in 10 minutes, audit rows plus sign-in aggregates", () => {
    const db = platformDb();
    for (const at of [NOW - 11 * MIN, NOW - 9 * MIN, NOW - MIN])
      refused(db, at);
    insert(db, "audit_refusals", {
      bucket: "signin",
      code: "signin.bad_flow",
      ip_hmac: "a",
      window_start: NOW - 5 * MIN,
      count: 1,
      updated_at: NOW,
    });
    insert(db, "audit_refusals", {
      bucket: "write",
      code: "csrf.refused",
      ip_hmac: "a",
      window_start: NOW - 5 * MIN,
      count: 9,
      updated_at: NOW,
    });
    expect(run(db, "signin_refused_burst")).toEqual([]);
    insert(db, "audit_refusals", {
      bucket: "signin",
      code: "rate_limited",
      ip_hmac: "b",
      window_start: NOW - 5 * MIN,
      count: 2,
      updated_at: NOW,
    });
    expect(run(db, "signin_refused_burst")).toEqual([
      {
        install_id: null,
        job_id: null,
        job_kind: null,
        code: null,
        message: null,
        since: NOW - 9 * MIN,
      },
    ]);
  });

  it("signin_refused_burst: counts the aggregate window that overlaps the window's start", () => {
    const db = platformDb();
    // 4 refusals in the window that ended at DAY + 10 min, 4 in the next;
    // the tick at DAY + 11 min looks back to DAY + 1 min.
    const now = DAY + 11 * MIN;
    const agg = (window_start: number, ip_hmac: string, count: number) =>
      insert(db, "audit_refusals", {
        bucket: SIGNIN_REFUSAL_BUCKET,
        code: "signin.bad_flow",
        ip_hmac,
        window_start,
        count,
        updated_at: now,
      });
    agg(DAY - 10 * MIN, "old", 9);
    agg(DAY, "a", 4);
    expect(run(db, "signin_refused_burst", now)).toEqual([]);
    agg(DAY + 10 * MIN, "b", 4);
    expect(run(db, "signin_refused_burst", now)).toMatchObject([
      { since: DAY },
    ]);
  });

  it("admin_unknown_sub: an unknown_sub refusal in the last day", () => {
    const db = platformDb();
    refused(db, NOW - 25 * HOUR, "unknown_sub");
    refused(db, NOW - MIN, "not_listed");
    expect(run(db, "admin_unknown_sub")).toEqual([]);
    refused(db, NOW - 2 * MIN, "unknown_sub");
    expect(run(db, "admin_unknown_sub")).toMatchObject([
      { code: "unknown_sub", since: NOW - 2 * MIN },
    ]);
  });

  it("job_failed: failed in the last day, not fixed since, not one with its own alert", () => {
    const db = platformDb();
    job(db, "old", { status: "failed", finished_at: NOW - 25 * HOUR });
    job(db, "pd", {
      status: "failed",
      error_code: "prod_dirty",
      finished_at: NOW - MIN,
    });
    job(db, "ui", {
      status: "failed",
      error_code: "upgrade_incomplete",
      finished_at: NOW - MIN,
    });
    job(db, "fixed", {
      status: "failed",
      created_at: 1,
      finished_at: NOW - HOUR,
    });
    job(db, "fixed", {
      kind: "retry",
      status: "done",
      created_at: 2,
      finished_at: NOW - MIN,
    });
    const stuck = {
      kind: "purge",
      workflow: "manage_install",
      status: "failed",
      finished_at: NOW - MIN,
    };
    for (let i = 0; i < 3; i++) job(db, "ps", stuck);
    expect(run(db, "job_failed")).toEqual([]);
    // The cleanup the sweep or a cancel inserts, and jobs that leave the
    // install's state alone, do not fix a failure.
    const failed = job(db, "cl", {
      status: "failed",
      error_code: "canceled",
      created_at: 1,
      finished_at: NOW - HOUR,
    });
    for (const kind of ["cleanup", "release_lease", "redline_creds", "update"])
      job(db, "cl", {
        kind,
        workflow: "manage_install",
        status: "done",
        parent_job_id: failed,
        created_at: 2,
        finished_at: NOW - MIN,
      });
    expect(run(db, "job_failed")).toMatchObject([
      { install_id: "cl", job_id: failed, code: "canceled" },
    ]);
    db.prepare("DELETE FROM jobs WHERE install_id = 'cl'").run();
    const id = job(db, "i1", {
      kind: "upgrade",
      workflow: "manage_install",
      status: "failed",
      error_code: "health",
      error_message: "boom",
      finished_at: NOW - MIN,
    });
    expect(run(db, "job_failed")).toEqual([
      {
        install_id: "i1",
        job_id: id,
        job_kind: "upgrade",
        code: "health",
        message: "boom",
        since: NOW - MIN,
      },
    ]);
  });

  it("job_failed: a failed job with no finished_at falls back to updated_at", () => {
    const db = platformDb();
    job(db, "old", { status: "failed", updated_at: NOW - 25 * HOUR });
    expect(run(db, "job_failed")).toEqual([]);
    const id = job(db, "i1", { status: "failed", updated_at: NOW - MIN });
    expect(run(db, "job_failed")).toMatchObject([
      { install_id: "i1", job_id: id, since: NOW - MIN },
    ]);
  });

  it("job_retrying: an open job on its 3rd attempt (2 failed), not yet stuck", () => {
    const db = platformDb();
    job(db, "i1", { status: "running", attempt: 1, updated_at: NOW });
    job(db, "i2", {
      status: "running",
      attempt: 2,
      updated_at: NOW - 3 * HOUR,
    });
    expect(run(db, "job_retrying")).toEqual([]);
    const id = job(db, "i3", {
      status: "running",
      attempt: 2,
      last_error_code: "cf_5xx",
      updated_at: NOW - MIN,
    });
    expect(run(db, "job_retrying")).toMatchObject([
      { install_id: "i3", job_id: id, code: "cf_5xx", since: NOW - MIN },
    ]);
  });

  it("job_stuck: open, unchanged for 2 h, and no future retry", () => {
    const db = platformDb();
    job(db, "i1", { status: "running", updated_at: NOW - HOUR });
    job(db, "i2", {
      status: "running",
      updated_at: NOW - 3 * HOUR,
      retry_at: NOW + MIN,
    });
    job(db, "i3", { status: "done", updated_at: NOW - 3 * HOUR });
    expect(run(db, "job_stuck")).toEqual([]);
    const a = job(db, "i4", { status: "queued", updated_at: NOW - 2 * HOUR });
    const b = job(db, "i5", {
      status: "running",
      updated_at: NOW - 3 * HOUR,
      retry_at: NOW - HOUR,
    });
    expect(
      run(db, "job_stuck")
        .map((r) => r.job_id)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it("prod_dirty: a prod_dirty job until a later purge or discard is done", () => {
    const db = platformDb();
    job(db, "i1", {
      status: "failed",
      error_code: "prod_dirty",
      created_at: 1,
      finished_at: 2,
    });
    job(db, "i1", {
      kind: "purge",
      workflow: "manage_install",
      status: "done",
      created_at: 3,
    });
    const id = job(db, "i2", {
      status: "failed",
      error_code: "prod_dirty",
      created_at: 1,
      finished_at: 2,
    });
    job(db, "i2", {
      kind: "purge",
      workflow: "manage_install",
      status: "running",
      created_at: 3,
    });
    expect(run(db, "prod_dirty")).toMatchObject([
      { install_id: "i2", job_id: id, code: "prod_dirty", since: 2 },
    ]);
    // since is never NULL: a failed row with no finished_at uses updated_at.
    const unfinished = job(db, "i3", {
      status: "failed",
      error_code: "prod_dirty",
      updated_at: 5,
    });
    expect(run(db, "prod_dirty")).toMatchObject([
      { job_id: id, since: 2 },
      { job_id: unfinished, since: 5 },
    ]);
  });

  it("prodclean_failed: the latest report failed; no install id", () => {
    const db = platformDb();
    insert(db, "prodclean_reports", {
      at: 1,
      ok: 0,
      code: "secret_present",
      install_id: "i1",
    });
    insert(db, "prodclean_reports", { at: 2, ok: 1, code: "pass" });
    expect(run(db, "prodclean_failed")).toEqual([]);
    insert(db, "prodclean_reports", {
      at: 3,
      ok: 0,
      code: "hook_open",
      install_id: "i1",
      detail: "x",
    });
    expect(run(db, "prodclean_failed")).toEqual([
      {
        install_id: null,
        job_id: null,
        job_kind: null,
        code: "hook_open",
        message: null,
        since: 3,
      },
    ]);
  });

  it("upgrade_incomplete: until a later upgrade, rollback or purge is done", () => {
    const db = platformDb();
    const up = {
      kind: "upgrade",
      workflow: "manage_install",
      status: "failed",
      error_code: "upgrade_incomplete",
      created_at: 1,
      finished_at: 2,
    };
    job(db, "i1", up);
    job(db, "i1", {
      kind: "rollback",
      workflow: "manage_install",
      status: "done",
      created_at: 3,
    });
    const id = job(db, "i2", up);
    job(db, "i2", {
      kind: "suspend",
      workflow: "manage_install",
      status: "done",
      created_at: 3,
    });
    expect(run(db, "upgrade_incomplete")).toMatchObject([
      { install_id: "i2", job_id: id, job_kind: "upgrade" },
    ]);
  });

  it("unreachable_after_route: health failing right after a done create or retry", () => {
    const db = platformDb();
    lifecycle(db, "i1", { health: "failing", health_at: 5 });
    job(db, "i1", { status: "done", created_at: 1 });
    job(db, "i1", {
      kind: "upgrade",
      workflow: "manage_install",
      status: "done",
      created_at: 2,
    });
    lifecycle(db, "i2", { health: "ok", health_at: 5 });
    job(db, "i2", { status: "done", created_at: 1 });
    expect(run(db, "unreachable_after_route")).toEqual([]);
    lifecycle(db, "i3", { health: "failing", health_at: 7 });
    const id = job(db, "i3", { kind: "retry", status: "done", created_at: 1 });
    expect(run(db, "unreachable_after_route")).toEqual([
      {
        install_id: "i3",
        job_id: id,
        job_kind: "retry",
        code: "health_failing",
        message: null,
        since: 7,
      },
    ]);
  });

  it("purge_stuck: 3 failed purges and none open or done", () => {
    const db = platformDb();
    const p = { kind: "purge", workflow: "manage_install", status: "failed" };
    for (let i = 0; i < 2; i++) job(db, "i1", { ...p, finished_at: i });
    for (let i = 0; i < 3; i++) job(db, "i2", { ...p, finished_at: i });
    job(db, "i2", { ...p, status: "running" });
    expect(run(db, "purge_stuck")).toEqual([]);
    for (let i = 0; i < 3; i++)
      job(db, "i3", { ...p, error_code: `c${i}`, finished_at: 10 + i });
    expect(run(db, "purge_stuck")).toEqual([
      {
        install_id: "i3",
        job_id: null,
        job_kind: "purge",
        code: "c2",
        message: null,
        since: 12,
      },
    ]);
  });

  it("welcome_unsent: owed and not sent once ready, or a claim older than 15 minutes", () => {
    const db = platformDb();
    signup(db, { send_welcome: 0, status: "ready" });
    signup(db, { send_welcome: 1, status: "ready", welcome_sent_at: 5 });
    signup(db, {
      send_welcome: 1,
      status: "creating",
      welcome_claimed_at: NOW - MIN,
    });
    expect(run(db, "welcome_unsent")).toEqual([]);
    const a = signup(db, {
      send_welcome: 1,
      status: "ready",
      install_id: "i1",
      updated_at: 9,
    });
    signup(db, {
      send_welcome: 1,
      status: "creating",
      install_id: "i2",
      welcome_claimed_at: NOW - 20 * MIN,
    });
    expect(
      run(db, "welcome_unsent").map((r) => [r.install_id, r.job_id]),
    ).toEqual([
      ["i1", a],
      ["i2", expect.any(String)],
    ]);
  });

  it("signup_cap: today's self-serve admissions reached the cap", () => {
    const db = platformDb();
    const ss = { source: "self-serve", owner_sub: "u", status: "creating" };
    signup(db, { ...ss, admitted_at: DAY - 1 });
    signup(db, { source: "admin", admitted_at: DAY + 1 });
    signup(db, { ...ss, admitted_at: DAY + 1 });
    signup(db, { ...ss, admitted_at: DAY + 2 });
    expect(run(db, "signup_cap")).toEqual([]);
    signup(db, { ...ss, admitted_at: DAY + 3 });
    expect(run(db, "signup_cap")).toEqual([
      {
        install_id: null,
        job_id: null,
        job_kind: null,
        code: null,
        message: null,
        since: DAY,
      },
    ]);
  });

  it("oauth_register_flood: over 500 client registrations in the UTC day", () => {
    const db = platformDb();
    const reg = (i: number, at: number) =>
      insert(db, "oauth_clients", {
        client_id: `c${i}`,
        client_name: "n",
        redirect_hosts: "[]",
        ip_hmac: "a",
        registered_at: at,
      });
    reg(0, DAY - 1);
    for (let i = 1; i <= 500; i++) reg(i, DAY + i);
    expect(run(db, "oauth_register_flood")).toEqual([]);
    reg(501, DAY + 501);
    expect(run(db, "oauth_register_flood")).toMatchObject([{ since: DAY + 1 }]);
  });
});
