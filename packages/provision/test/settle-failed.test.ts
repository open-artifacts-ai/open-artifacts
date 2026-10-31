// settleFailed (design v7 3.6) on the real platform schema: the job, its
// signup and a never-created self-serve install's account claim, in one D1
// batch; idempotent, never over a stored code.
import { describe, expect, it } from "vitest";
import {
  type SettleDb,
  settleFailed,
  settleFailedStatements,
} from "../src/jobs.js";
import { nodeD1 } from "./d1-node.js";
import {
  insert,
  install,
  job,
  lifecycle,
  platformDb,
  signup,
} from "./platform-db.js";

const NOW = 1_800_000_000_000;

function world(
  o: { source?: "admin" | "self-serve"; installRow?: boolean } = {},
) {
  const db = platformDb();
  const source = o.source ?? "self-serve";
  const iid = "isettleaaaa1";
  lifecycle(db, iid, {
    source,
    owner_sub: source === "self-serve" ? "sub-1" : null,
  });
  const jid = job(db, iid, { status: "running", step: "create" });
  const sid = jid;
  signup(db, {
    signup_id: jid,
    job_id: jid,
    source,
    owner_sub: source === "self-serve" ? "sub-1" : null,
    slug: "settleco",
    status: "creating",
    install_id: iid,
  });
  db.prepare("UPDATE jobs SET signup_id = ? WHERE id = ?").run(sid, jid);
  if (source === "self-serve")
    insert(db, "signup_accounts", {
      owner_sub: "sub-1",
      signup_id: sid,
      created_at: 1,
    });
  if (o.installRow) install(db, iid, { slug: "settleco", state: "creating" });
  return { db, d1: nodeD1(db), iid, jid, sid };
}

const row = (
  w: ReturnType<typeof world>,
  table: string,
  col: string,
  id: string,
) =>
  w.db.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).get(id) as Record<
    string,
    unknown
  >;

describe("settleFailed (3.6)", () => {
  it("fails the job and its signup and frees a never-created self-serve claim, in one batch", async () => {
    const w = world();
    const batches: number[] = [];
    const db: SettleDb = {
      prepare: (s) => w.d1.prepare(s),
      batch: async (st) => {
        batches.push(st.length);
        return w.d1.batch(st);
      },
    };
    await settleFailed(db, w.jid, "release_unverified", NOW);
    expect(batches).toHaveLength(1);
    expect(row(w, "jobs", "id", w.jid)).toMatchObject({
      status: "failed",
      error_code: "release_unverified",
      finished_at: NOW,
      updated_at: NOW,
      retry_at: null,
    });
    expect(row(w, "signups", "signup_id", w.sid)).toMatchObject({
      status: "failed",
      error: "release_unverified",
    });
    expect(row(w, "signup_accounts", "owner_sub", "sub-1").freed_at).toBe(NOW);
  });

  it("keeps the claim of a self-serve install whose installs row exists", async () => {
    const w = world({ installRow: true });
    await settleFailed(w.d1, w.jid, "prod_dirty", NOW);
    expect(row(w, "signup_accounts", "owner_sub", "sub-1").freed_at).toBeNull();
    expect(row(w, "signups", "signup_id", w.sid).status).toBe("failed");
  });

  it("an admin create has no claim; the signup is failed", async () => {
    const w = world({ source: "admin" });
    await settleFailed(w.d1, w.jid, "internal", NOW);
    expect(row(w, "signups", "signup_id", w.sid).status).toBe("failed");
  });

  it("never overwrites a stored code; a job already failed (an R25 cancel) still settles its signup", async () => {
    const w = world();
    w.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled', error_message = 'canceled by an admin', finished_at = 5 WHERE id = ?",
      )
      .run(w.jid);
    await settleFailed(w.d1, w.jid, "internal", NOW);
    expect(row(w, "jobs", "id", w.jid)).toMatchObject({
      status: "failed",
      error_code: "canceled",
      error_message: "canceled by an admin",
      finished_at: 5,
    });
    expect(row(w, "signups", "signup_id", w.sid)).toMatchObject({
      status: "failed",
      error: "canceled",
    });
    expect(row(w, "signup_accounts", "owner_sub", "sub-1").freed_at).toBe(NOW);
  });

  it("a done job, a ready signup and another job's signup are left alone", async () => {
    const w = world();
    w.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(w.jid);
    w.db
      .prepare("UPDATE signups SET status = 'ready' WHERE signup_id = ?")
      .run(w.sid);
    await settleFailed(w.d1, w.jid, "internal", NOW);
    expect(row(w, "jobs", "id", w.jid).status).toBe("done");
    expect(row(w, "signups", "signup_id", w.sid).status).toBe("ready");
    expect(row(w, "signup_accounts", "owner_sub", "sub-1").freed_at).toBeNull();

    // A retry moved signups.job_id on: the earlier job's settle leaves it.
    const v = world();
    const retry = job(v.db, v.iid, {
      kind: "retry",
      status: "done",
      signup_id: v.sid,
    });
    v.db
      .prepare("UPDATE signups SET job_id = ? WHERE signup_id = ?")
      .run(retry, v.sid);
    await settleFailed(v.d1, v.jid, "internal", NOW);
    expect(row(v, "jobs", "id", v.jid).status).toBe("failed");
    expect(row(v, "signups", "signup_id", v.sid).status).toBe("creating");
  });

  it("is idempotent", async () => {
    const w = world();
    await settleFailed(w.d1, w.jid, "cf_error", NOW);
    const snap = () => ({
      j: row(w, "jobs", "id", w.jid),
      s: row(w, "signups", "signup_id", w.sid),
      a: row(w, "signup_accounts", "owner_sub", "sub-1"),
    });
    const before = snap();
    await settleFailed(w.d1, w.jid, "internal", NOW + 1);
    expect(snap()).toEqual(before);
  });

  it("the job's settle comes first, so a queued job for the install fits jobs_one_active in the same batch", async () => {
    const w = world();
    const st = settleFailedStatements(w.d1, w.jid, "prod_dirty", NOW);
    const purge = w.d1
      .prepare(
        "INSERT INTO jobs (id, kind, workflow, install_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at) VALUES ('jpurge', 'purge', 'manage_install', ?1, 'system', 'system:provisioner', 'provisioner', 'r', 'h', '{}', 'queued', 1, 1)",
      )
      .bind(w.iid);
    await w.d1.batch([...st, purge]);
    expect(row(w, "jobs", "id", "jpurge").status).toBe("queued");
    // The other order is refused by the real partial index.
    const v = world();
    const p2 = v.d1
      .prepare(
        "INSERT INTO jobs (id, kind, workflow, install_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at) VALUES ('jpurge', 'purge', 'manage_install', ?1, 'system', 'system:provisioner', 'provisioner', 'r', 'h', '{}', 'queued', 1, 1)",
      )
      .bind(v.iid);
    await expect(
      v.d1.batch([
        p2,
        ...settleFailedStatements(v.d1, v.jid, "prod_dirty", NOW),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(row(v, "jobs", "id", v.jid).status).toBe("running");
  });

  it("refuses an unknown code before any write", async () => {
    const w = world();
    await expect(settleFailed(w.d1, w.jid, "nope" as never)).rejects.toThrow(
      /unknown provision error code/,
    );
    expect(row(w, "jobs", "id", w.jid).status).toBe("running");
  });
});
