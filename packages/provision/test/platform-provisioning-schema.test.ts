// Provisioning API C2: 0006_platform_state, 0007_signups (amended) and
// 0008_provisioning (design v7 section 8).
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  apply,
  insert,
  install,
  job,
  lifecycle,
  migrationFiles,
  migrationSql,
  platformDb,
  signup,
} from "./platform-db.js";

const NEW = [
  "0006_platform_state.sql",
  "0007_signups.sql",
  "0008_provisioning.sql",
];

const cols = (db: DatabaseSync, t: string) =>
  (
    db.prepare(`PRAGMA table_info(${t})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[]
  ).map(
    (c) => `${c.name} ${c.type}${c.notnull ? " NN" : ""}${c.pk ? " PK" : ""}`,
  );
const indexCols = (db: DatabaseSync, i: string) =>
  (db.prepare(`PRAGMA index_info(${i})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
const count = (db: DatabaseSync, t: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const status = (db: DatabaseSync, id: string) =>
  db.prepare("SELECT * FROM install_status WHERE install_id = ?").get(id) as
    | Record<string, unknown>
    | undefined;

describe("0006-0008 rules (8.1)", () => {
  it("follow 0005, in order", () => {
    expect(migrationFiles.slice(5, 8)).toEqual(NEW);
  });

  it("are additive: no DROP, RENAME or ALTER, and every CREATE is IF NOT EXISTS", () => {
    for (const f of NEW) {
      const sql = migrationSql(f).replace(/--[^\n]*/g, "");
      expect(sql, f).not.toMatch(/\b(?:DROP|RENAME|ALTER)\b/i);
      const creates = sql.match(/\bCREATE\s+(?:UNIQUE\s+)?\w+\b[^\n]*/gi) ?? [];
      expect(creates.length, f).toBeGreaterThan(0);
      for (const c of creates)
        expect(c, f).toMatch(
          /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+IF NOT EXISTS\b/i,
        );
    }
  });

  it("re-run as a no-op over data", () => {
    const db = platformDb();
    install(db, "i1");
    lifecycle(db, "i1");
    insert(db, "platform_state", {
      key: "job_failed_opened_at",
      value: 5,
      updated_at: 5,
    });
    apply(db, NEW);
    expect(count(db, "install_lifecycle")).toBe(1);
    expect(count(db, "platform_state")).toBe(1);
  });

  it("never name an owner email column outside signup_secret and sessions", () => {
    const db = platformDb();
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('platform_state','signups','jobs','install_lifecycle','admin_audit','audit_refusals','rate_counters','signup_accounts','prodclean_reports','platform_migrations','oauth_clients','install_status')",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toHaveLength(12);
    for (const t of tables)
      expect(cols(db, t).join(","), t).not.toMatch(/email\b/);
  });
});

describe("0006_platform_state", () => {
  it("has #849's shape, and its comment names alert keys only", () => {
    const db = platformDb();
    expect(cols(db, "platform_state")).toEqual([
      "key TEXT PK",
      "value INTEGER NN",
      "updated_at INTEGER NN",
    ]);
    const sql = migrationSql("0006_platform_state.sql");
    expect(sql).toMatch(/ALERT_KEYS/);
    expect(sql).not.toMatch(/billing/i);
  });
});

// #859's 0007 signups shape (origin/pl/ss3-provisioner), before the amendment.
const SIGNUPS_859 = `CREATE TABLE signups (
  signup_id TEXT NOT NULL PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  slug TEXT NOT NULL,
  install_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','waiting_cap','creating','ready','failed')),
  admitted_at INTEGER,
  welcome_claimed_at INTEGER,
  welcome_sent_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE signup_secret (signup_id TEXT NOT NULL PRIMARY KEY, owner_email TEXT NOT NULL);
CREATE INDEX signups_admitted_at ON signups (admitted_at);`;

describe("0007_signups (amended)", () => {
  it("aborts on #859's older signups shape, before 0008", () => {
    const db = platformDb(migrationFiles.slice(0, 6));
    db.exec(SIGNUPS_859);
    expect(() => apply(db, ["0007_signups.sql"])).toThrow(
      /no such column: source/,
    );
  });

  it("passes on a fresh database, and on a re-run", () => {
    const db = platformDb(migrationFiles.slice(0, 6));
    expect(() => apply(db, ["0007_signups.sql"])).not.toThrow();
    expect(() => apply(db, ["0007_signups.sql"])).not.toThrow();
  });

  it("self-serve rows need an owner sub; admin rows do not", () => {
    const db = platformDb();
    signup(db, { source: "admin" });
    expect(() => signup(db, { source: "self-serve" })).toThrow(/CHECK/);
    signup(db, { source: "self-serve", owner_sub: "u1" });
    expect(() => signup(db, { source: "other" })).toThrow(/CHECK/);
  });

  it("holds a live slug once; a failed row frees it", () => {
    const db = platformDb();
    signup(db, { slug: "acme", status: "failed" });
    signup(db, { slug: "acme", status: "pending" });
    expect(() => signup(db, { slug: "acme", status: "queued" })).toThrow(
      /UNIQUE/,
    );
  });

  it("checks flags and status, and install_id is unique", () => {
    const db = platformDb();
    expect(() => signup(db, { test_hooks: 2 })).toThrow(/CHECK/);
    expect(() => signup(db, { send_welcome: 2 })).toThrow(/CHECK/);
    expect(() => signup(db, { status: "ready2" })).toThrow(/CHECK/);
    signup(db, { install_id: "i1" });
    expect(() => signup(db, { install_id: "i1" })).toThrow(/UNIQUE/);
  });

  it("the cap index leads with source, and serves the self-serve cap query", () => {
    const db = platformDb();
    expect(indexCols(db, "signups_admitted_at")).toEqual([
      "source",
      "admitted_at",
    ]);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM signups WHERE source = 'self-serve' AND admitted_at >= ?",
      )
      .all(0) as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toMatch(
      /USING (?:COVERING )?INDEX signups_admitted_at/,
    );
    expect(cols(db, "signup_secret")).toEqual([
      "signup_id TEXT NN PK",
      "owner_email TEXT NN",
    ]);
  });
});

describe("0008_provisioning: jobs", () => {
  it("one (actor_key, request_id); one active job per install; a settle frees the slot", () => {
    const db = platformDb();
    const a = job(db, "i1", { request_id: "r1" });
    expect(() => job(db, "i2", { request_id: "r1" })).toThrow(/UNIQUE/);
    job(db, "i2", { request_id: "r1", actor_key: "token:t1" });
    expect(() => job(db, "i1", { status: "running" })).toThrow(/UNIQUE/);
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(a);
    job(db, "i1", { kind: "purge", workflow: "manage_install" });
  });

  it("checks kind, workflow, actor kind and status", () => {
    const db = platformDb();
    job(db, "i1", { kind: "update", status: "done" });
    for (const bad of [
      { kind: "explode" },
      { workflow: "other" },
      { actor_kind: "robot" },
      { status: "canceled" },
    ] as Record<string, string>[])
      expect(() => job(db, "i9", bad)).toThrow(/CHECK/);
  });
});

describe("0009_job_fail_point (#995)", () => {
  it("follows 0008 and only adds columns", () => {
    expect(migrationFiles.slice(8)).toEqual(["0009_job_fail_point.sql"]);
    const sql = migrationSql("0009_job_fail_point.sql").replace(
      /--[^\n]*/g,
      "",
    );
    expect(sql).not.toMatch(/\b(?:DROP|RENAME|UPDATE|DELETE)\b/i);
    const stmts = sql
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    expect(stmts).toHaveLength(3);
    for (const x of stmts) expect(x).toMatch(/^ALTER TABLE jobs ADD COLUMN /);
  });

  it("adds fail_at, fail_status (an HTTP status or NULL) and fail_reason", () => {
    const db = platformDb();
    expect(cols(db, "jobs")).toEqual(
      expect.arrayContaining([
        "fail_at TEXT",
        "fail_status INTEGER",
        "fail_reason TEXT",
      ]),
    );
    const id = job(db, "i1");
    const set = (v: unknown) =>
      db
        .prepare("UPDATE jobs SET fail_status = ? WHERE id = ?")
        .run(v as never, id);
    for (const ok of [null, 100, 404, 599]) set(ok);
    for (const bad of [99, 600, 0]) expect(() => set(bad)).toThrow(/CHECK/);
  });
});

describe("0008_provisioning: audit", () => {
  it("admin_audit is append-only", () => {
    const db = platformDb();
    insert(db, "admin_audit", {
      at: 1,
      actor_kind: "admin",
      action: "signin.ok",
      outcome: "ok",
    });
    expect(() => db.exec("UPDATE admin_audit SET code = 'x'")).toThrow(
      /append-only/,
    );
    expect(() => db.exec("DELETE FROM admin_audit")).toThrow(/append-only/);
    expect(() =>
      insert(db, "admin_audit", {
        at: 1,
        actor_kind: "admin",
        action: "x",
        outcome: "maybe",
      }),
    ).toThrow(/CHECK/);
  });

  it("audit_refusals aggregates one row per (bucket, code, ip, window) and is prunable", () => {
    const db = platformDb();
    const row = {
      bucket: "signin",
      code: "auth.refused",
      ip_hmac: "ab",
      window_start: 0,
      count: 1,
      updated_at: 0,
    };
    insert(db, "audit_refusals", row);
    expect(() => insert(db, "audit_refusals", row)).toThrow(/UNIQUE/);
    db.exec("DELETE FROM audit_refusals");
    expect(count(db, "audit_refusals")).toBe(0);
  });
});

describe("0008_provisioning: tokens and clients", () => {
  const base = {
    session_hash: "s",
    admin_email: "a@example.test",
    label: "l",
    scopes: "[]",
    created_at: 1,
    expires_at: 2,
  };

  it("an oat token has a hash and no client; an oauth token has a client and user and no hash", () => {
    const db = platformDb();
    insert(db, "agent_tokens", {
      ...base,
      id: "t1",
      kind: "oat",
      token_hash: "h1",
    });
    insert(db, "agent_tokens", {
      ...base,
      id: "t2",
      kind: "oauth",
      client_id: "c",
      client_name: "n",
      oauth_user: "adm_1",
    });
    for (const bad of [
      { kind: "oat" },
      { kind: "oauth", token_hash: "h2", client_id: "c", oauth_user: "adm_1" },
      { kind: "oauth", client_id: "c" },
      { kind: "oat", token_hash: "h4", client_id: "c" },
      { kind: "oat", token_hash: "h5", grant_id: "g" },
      { kind: "pat", token_hash: "h3" },
    ] as Record<string, string>[])
      expect(() =>
        insert(db, "agent_tokens", { ...base, id: "tx", ...bad }),
      ).toThrow(/CHECK/);
    expect(() =>
      insert(db, "agent_tokens", {
        ...base,
        id: "t3",
        kind: "oat",
        token_hash: "h1",
      }),
    ).toThrow(/UNIQUE/);
  });

  it("the client index covers live oauth grants only; unclaimed clients are indexed for the sweep", () => {
    const db = platformDb();
    const sql = (n: string) =>
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(n) as {
          sql: string;
        }
      ).sql;
    expect(sql("agent_tokens_client")).toMatch(
      /WHERE kind = 'oauth' AND revoked_at IS NULL/,
    );
    expect(sql("oauth_clients_unclaimed")).toMatch(
      /WHERE first_grant_at IS NULL/,
    );
    expect(cols(db, "oauth_clients")).toEqual([
      "client_id TEXT NN PK",
      "client_name TEXT NN",
      "redirect_hosts TEXT NN",
      "ip_hmac TEXT NN",
      "registered_at INTEGER NN",
      "first_grant_at INTEGER",
    ]);
  });
});

describe("0008_provisioning: install_lifecycle", () => {
  it("deleted_at and purge_at are set together; enums are checked", () => {
    const db = platformDb();
    expect(() => lifecycle(db, "i1", { deleted_at: 1 })).toThrow(/CHECK/);
    lifecycle(db, "i1", { deleted_at: 1, purge_at: 2 });
    for (const bad of [
      { source: "x" },
      { tier: "gold" },
      { serving_mode: "x" },
      { health: "x" },
    ] as Record<string, string>[])
      expect(() => lifecycle(db, "i2", bad)).toThrow(/CHECK/);
  });

  it("0008 gives every existing install an admin lifecycle row", () => {
    const db = platformDb(migrationFiles.slice(0, 5));
    install(db, "ijzbmraouh5r", {
      state: "active",
      created_at: 10,
      updated_at: 11,
    });
    install(db, "i42fdk7ahvs2", { state: "upgrading" });
    install(db, "idel", { state: "deleted" });
    install(db, "idelg", { state: "deleting", updated_at: 7 });
    install(db, "icre", { state: "creating" });
    const before = Math.floor(Date.now() / 1000) * 1000;
    apply(db, NEW);
    const after = Date.now();
    const rows = db
      .prepare(
        "SELECT install_id, source, serving_mode, health, created_at, updated_at FROM install_lifecycle ORDER BY install_id",
      )
      .all();
    expect(rows).toEqual([
      {
        install_id: "i42fdk7ahvs2",
        source: "admin",
        serving_mode: "serving",
        health: "unknown",
        created_at: 1,
        updated_at: 1,
      },
      {
        install_id: "icre",
        source: "admin",
        serving_mode: null,
        health: "unknown",
        created_at: 1,
        updated_at: 1,
      },
      {
        install_id: "idel",
        source: "admin",
        serving_mode: "unmapped",
        health: "unknown",
        created_at: 1,
        updated_at: 1,
      },
      {
        install_id: "idelg",
        source: "admin",
        serving_mode: "closed",
        health: "unknown",
        created_at: 1,
        updated_at: 7,
      },
      {
        install_id: "ijzbmraouh5r",
        source: "admin",
        serving_mode: "serving",
        health: "unknown",
        created_at: 10,
        updated_at: 11,
      },
    ]);
    expect(status(db, "ijzbmraouh5r")?.state).toBe("active");
    // A deleting install's grace is over: purge is due at migration time.
    const g = status(db, "idelg");
    expect(g?.state).toBe("deleting");
    expect(g?.deleted_at).toBe(7);
    expect(g?.purge_at).toBeGreaterThanOrEqual(before);
    expect(g?.purge_at).toBeLessThanOrEqual(after);
    // A creating install with no signup and no job is failed, unmapped.
    const c = status(db, "icre");
    expect(c?.state).toBe("failed");
    expect(c?.serving_mode).toBeNull();
    expect(c?.deleted_at).toBeNull();
    expect(c?.purge_at).toBeNull();
    for (const id of ["ijzbmraouh5r", "i42fdk7ahvs2", "idel"])
      expect(status(db, id)?.purge_at, id).toBeNull();
  });
});

describe("0008_provisioning: install_status (5.1 precedence)", () => {
  it("first match wins", () => {
    const db = platformDb();
    // 1 deleted: installs.state deleted, or lifecycle discarded.
    install(db, "d1", { state: "deleted" });
    lifecycle(db, "d1", { suspended_at: 1 });
    lifecycle(db, "d2", { discarded_at: 1, deleted_at: 1, purge_at: 1 });
    signup(db, { install_id: "d2", status: "failed" });
    // 2 deleting: installs.state deleting, or deleted_at set.
    install(db, "g1", { state: "deleting" });
    lifecycle(db, "g1", { suspended_at: 1 });
    install(db, "g2", { state: "active" });
    lifecycle(db, "g2", { deleted_at: 1, purge_at: 2, suspended_at: 1 });
    // 3 suspended.
    install(db, "s1", { state: "active" });
    lifecycle(db, "s1", { suspended_at: 1 });
    // 4 active: active or upgrading.
    install(db, "a1", { state: "upgrading" });
    lifecycle(db, "a1");
    signup(db, { install_id: "a1", status: "failed" });
    // 5 failed: the signup failed (the installs row stays creating).
    install(db, "f1", { state: "creating" });
    lifecycle(db, "f1");
    signup(db, { install_id: "f1", status: "failed" });
    // 6 provisioning: the signup is in flight, found through its job before
    // reserve writes signups.install_id.
    lifecycle(db, "p1");
    const sg = signup(db, { status: "waiting_cap" });
    job(db, "p1", { signup_id: sg });
    expect(
      Object.fromEntries(
        ["d1", "d2", "g1", "g2", "s1", "a1", "f1", "p1"].map((id) => [
          id,
          status(db, id)?.state,
        ]),
      ),
    ).toEqual({
      d1: "deleted",
      d2: "deleted",
      g1: "deleting",
      g2: "deleting",
      s1: "suspended",
      a1: "active",
      f1: "failed",
      p1: "provisioning",
    });
  });

  it("with no signup: provisioning while a job is active, failed otherwise", () => {
    const db = platformDb();
    lifecycle(db, "x1");
    job(db, "x1", { status: "running" });
    install(db, "x2", { state: "creating" });
    lifecycle(db, "x2");
    job(db, "x2", { status: "failed" });
    expect(status(db, "x1")?.state).toBe("provisioning");
    expect(status(db, "x2")?.state).toBe("failed");
  });

  it("a ready signup whose install never reached active, with no open job, is failed", () => {
    const db = platformDb();
    install(db, "r1", { state: "creating" });
    lifecycle(db, "r1");
    signup(db, { install_id: "r1", status: "ready" });
    job(db, "r1", { status: "done" });
    lifecycle(db, "r2");
    signup(db, { install_id: "r2", status: "ready" });
    expect(status(db, "r1")?.state).toBe("failed");
    expect(status(db, "r2")?.state).toBe("failed");
  });

  it("carries the installs columns InstallDetail needs; test_hooks falls back to the signup's", () => {
    const db = platformDb();
    install(db, "v1", {
      version: "1.2.0",
      previous_version: "1.1.0",
      test_hooks: 1,
      lease_until: 9,
      directory_revoke: "pending",
    });
    lifecycle(db, "v1");
    lifecycle(db, "v2");
    signup(db, { install_id: "v2", status: "creating", test_hooks: 1 });
    expect(status(db, "v1")).toMatchObject({
      version: "1.2.0",
      previous_version: "1.1.0",
      test_hooks: 1,
      lease_until: 9,
      directory_revoke: "pending",
    });
    expect(status(db, "v2")).toMatchObject({
      previous_version: null,
      test_hooks: 1,
      lease_until: null,
      directory_revoke: null,
    });
  });

  it("carries slug, hosts, owner sub, serving mode and the active job; never an email", () => {
    const db = platformDb();
    install(db, "i1", {
      slug: "acme",
      app_host: "acme.example.test",
      content_host: "acme-c.example.test",
    });
    lifecycle(db, "i1", {
      source: "self-serve",
      owner_sub: "u1",
      tier: "trial",
      serving_mode: "serving",
      health: "ok",
    });
    signup(db, {
      install_id: "i1",
      source: "self-serve",
      owner_sub: "u1",
      slug: "acme",
      status: "ready",
    });
    job(db, "i1", { status: "done" });
    const active = job(db, "i1", {
      kind: "upgrade",
      workflow: "manage_install",
      status: "running",
    });
    expect(status(db, "i1")).toMatchObject({
      install_id: "i1",
      state: "active",
      source: "self-serve",
      slug: "acme",
      app_host: "acme.example.test",
      content_host: "acme-c.example.test",
      owner_sub: "u1",
      tier: "trial",
      serving_mode: "serving",
      health: "ok",
      active_job_id: active,
      active_job_kind: "upgrade",
    });
    expect(Object.keys(status(db, "i1") ?? {}).join(",")).not.toMatch(/email/);
  });

  it("is one row per lifecycle row", () => {
    const db = platformDb();
    lifecycle(db, "i1");
    const sg = signup(db, { install_id: "i1", status: "failed" });
    job(db, "i1", { signup_id: sg, status: "failed" });
    job(db, "i1", { signup_id: sg, kind: "retry", status: "failed" });
    expect(count(db, "install_status")).toBe(1);
  });
});
