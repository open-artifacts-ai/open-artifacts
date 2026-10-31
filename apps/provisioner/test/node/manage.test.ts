// ManageInstall (design v7 5.4-5.7, 3.6, 10.1) on fake-cf: every kind, the
// rechecks and purge preconditions, replays, upgrade outcome mapping, the
// fail and cleanup compensation, redline_creds sealing. Each install is made
// by ProvisionInstall first, as in production.
import { HOSTED_DOMAINS, NAMESPACES } from "@oa/provision";
import { REDLINE_SCOPE_FIXTURE } from "@oa/shared/provisioning/fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { GRACE_MS, NEVER_ROUTED, runManage } from "../../src/manage.js";
import { openSealed } from "../../src/seal.js";
import { runCreate } from "../../src/workflow.js";
import {
  type CreateSeed,
  ENV,
  event,
  seedCreate,
  seedJob,
  stepRunner,
  V1,
  V2,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

let w: World;
beforeEach(async () => {
  w = await world();
});

async function active(o: CreateSeed) {
  const s = seedCreate(w, o);
  await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
  expect(w.job(s.jobId)?.status).toBe("done");
  return s;
}

async function manage(
  kind: string,
  installId: string,
  o: Omit<Parameters<typeof seedJob>[1], "kind" | "installId"> & {
    twice?: boolean;
  } = {},
) {
  const id = seedJob(w, { kind, installId, ...o });
  const r = stepRunner(w.clock, { twice: o.twice });
  const error = await runManage(w.ctx, event(id), r.step).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { id, error, log: r.log, job: w.job(id) };
}

const plain = (id: string, name: string) =>
  (
    w.fake
      .script(NAMESPACES[ENV], `oa-s-${id}`)
      ?.metadata.bindings.find((b: { name: string }) => b.name === name) as
      | { text?: string }
      | undefined
  )?.text;

/** The install's own D1 (its tokens table). */
const installDb = (installId: string) =>
  (
    [...w.fake.d1.values()].find((d) => d.name === `oa-s-${installId}`) as {
      db: import("node:sqlite").DatabaseSync;
    }
  ).db;

/** NOT NULL columns with no default, filled; foreign keys to a real row. */
function fill(
  db: import("node:sqlite").DatabaseSync,
  table: string,
  id: string,
): Record<string, unknown> {
  const row: Record<string, unknown> = Object.fromEntries(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    )
      .filter((c) => c.notnull === 1 && c.dflt_value === null)
      .map((c) => [c.name, /INT/i.test(c.type) ? 1 : `x-${id}`]),
  );
  for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
    table: string;
    from: string;
    to: string;
  }[]) {
    const have = db
      .prepare(`SELECT ${fk.to} AS v FROM ${fk.table} LIMIT 1`)
      .get() as { v: unknown } | undefined;
    row[fk.from] = have
      ? have.v
      : insert(
          db,
          fk.table,
          `${id}-${fk.table}`,
          fk.table === "users" ? { role: "owner" } : {},
        );
  }
  return row;
}

function insert(
  db: import("node:sqlite").DatabaseSync,
  table: string,
  id: string,
  extra: Record<string, unknown> = {},
): unknown {
  const row = { ...fill(db, table, id), id, ...extra };
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...(Object.values(row) as never[]));
  return id;
}

/** A live owner PAT under `label` in the install's D1 (a crashed run's). */
function liveToken(installId: string, label: string, id: string) {
  const db = installDb(installId);
  insert(db, "tokens", id, { label, token_hash: `h-${id}` });
  return () =>
    db
      .prepare("SELECT 1 FROM tokens WHERE id = ? AND revoked_at IS NOT NULL")
      .all(id).length === 1;
}

describe("upgrade and rollback (5.4)", () => {
  it("upgrade: on `to`, google kept (brokerEnabled); a replay of every step changes nothing", async () => {
    const s = await active({ slug: "upco", version: V1 });
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
      twice: true,
    });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "done", step: "done" });
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "recheck",
      "release_gate",
      "upload",
      "done",
    ]);
    // jobs.args stays the request (8.3): no run state is written into it.
    expect(JSON.parse(r.job?.args as string)).toEqual({ from: V1, to: V2 });
    expect(w.install(s.installId)).toMatchObject({
      version: V2,
      previous_version: V1,
      state: "active",
      lease: null,
    });
    expect(plain(s.installId, "AUTH_BROKER_URL")).toBe(
      `https://auth.${HOSTED_DOMAINS[ENV].app}`,
    );
    expect(plain(s.installId, "GOOGLE_CLIENT_ID")).toMatch(
      /apps\.googleusercontent\.com$/,
    );
    // Already on `to`: done with no Cloudflare write.
    const writes = w.fake.writes().length;
    const again = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(again.job?.status).toBe("done");
    expect(again.log.map((l) => l.name)).toEqual(["load", "recheck", "done"]);
    expect(w.fake.writes().length).toBe(writes);
  });

  it("upgrade refusals: from moved is invalid_state; to at or below from is downgrade_refused", async () => {
    const s = await active({ slug: "refuseco" });
    const moved = await manage("upgrade", s.installId, {
      args: { from: V1, to: "0.25.0" },
    });
    expect(moved.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    const down = await manage("upgrade", s.installId, {
      args: { from: V2, to: V1 },
    });
    expect(down.job).toMatchObject({
      status: "failed",
      error_code: "downgrade_refused",
    });
    expect(w.install(s.installId)?.version).toBe(V2);
  });

  it("an upgrade whose health fails rolls back: upgrade_rolled_back, still on from", async () => {
    const s = await active({ slug: "rbco", version: V1 });
    // Only the new version is unhealthy.
    w.fake.health = (sc) =>
      (sc.metadata.tags as string[]).includes(`v${V2}`)
        ? new Response(null, { status: 503 })
        : undefined;
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    w.fake.health = undefined;
    expect(r.job).toMatchObject({ status: "failed" });
    expect(r.job?.error_code).toBe("upgrade_rolled_back");
    expect(w.install(s.installId)).toMatchObject({
      version: V1,
      lease: null,
      state: "active",
    });
  });

  it("an upgrade whose script and rollback both fail verify_clean: paused, prod_dirty", async () => {
    const s = await active({ slug: "dirtyup", version: V1 });
    w.fake.settingsEdit = (_x, b) => [...b, { name: "EXTRA", type: "service" }];
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    w.fake.settingsEdit = undefined;
    expect(r.job).toMatchObject({ status: "failed", error_code: "prod_dirty" });
    expect(w.hosts("dirtyup")).toEqual([
      `paused:${s.installId}`,
      `paused:${s.installId}`,
    ]);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("paused");
    expect(w.install(s.installId)).toMatchObject({
      state: "active",
      lease: null,
    });
  });

  it("an upgrade with no rollback (the DO tag moved): upgrade_incomplete, on `to`", async () => {
    const s = await active({ slug: "fwdco", version: V1 });
    w.db
      .prepare(
        "UPDATE install_versions SET do_migration_tag = 'v-older' WHERE install_id = ? AND version = ?",
      )
      .run(s.installId, V1);
    w.fake.health = (sc) =>
      (sc.metadata.tags as string[]).includes(`v${V2}`)
        ? new Response(null, { status: 503 })
        : undefined;
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    w.fake.health = undefined;
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "upgrade_incomplete",
    });
    expect(w.install(s.installId)).toMatchObject({
      version: V2,
      lease: null,
    });
    expect(r.log.map((l) => l.name)).not.toContain("fail_release");
  });

  it("an upgrade whose lease was taken mid-run: fail goes by the lease this run claimed, never the newer one", async () => {
    const s = await active({ slug: "stolenco", version: V1 });
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    // jobs.step = upload is written twice per attempt: by the step wrapper
    // before the body, then by the provisioner's report after its claim.
    // At that second write another holder takes the row (a lost lease).
    const db = w.env.PLATFORM_DB;
    const prepare = db.prepare.bind(db);
    let marks = 0;
    let mine: string | null = null;
    db.prepare = (sql: string) => {
      const st = prepare(sql);
      if (!sql.startsWith("UPDATE jobs SET step = ?2")) return st;
      const bind = st.bind.bind(st);
      st.bind = (...a: unknown[]) => {
        if (a[0] === id && a[1] === "upload" && ++marks === 2) {
          mine = w.install(s.installId)?.lease as string | null;
          w.db
            .prepare(
              "UPDATE installs SET lease = 'stolen', lease_until = ? WHERE id = ?",
            )
            .run(w.clock.t + 30 * 60_000, s.installId);
        }
        return bind(...a);
      };
      return st;
    };
    const r = stepRunner(w.clock);
    await runManage(w.ctx, event(id), r.step).catch(() => {});
    db.prepare = prepare;
    expect(mine).toMatch(/^[0-9a-f]{32}$/);
    expect(w.job(id)?.status).toBe("failed");
    // The stolen lease was claimed after the job started, so the started_at
    // rule alone would release it; the run's own claim says it is not ours.
    expect(r.log.map((l) => l.name)).not.toContain("fail_release");
    expect(w.install(s.installId)).toMatchObject({ lease: "stolen" });
    expect(JSON.parse(w.job(id)?.args as string)).toEqual({ from: V1, to: V2 });
  });

  it("an upgrade refused while another job's lease holds the row upgrading leaves that lease alone", async () => {
    const s = await active({ slug: "otherco", version: V1 });
    const until = w.clock.t + 20 * 60_000;
    w.db
      .prepare(
        "UPDATE installs SET state = 'upgrading', lease = 'theirs', lease_until = ? WHERE id = ?",
      )
      .run(until, s.installId);
    const r = await manage("upgrade", s.installId, {
      // A claimedLease in args is never read: args is the request (8.3).
      args: { from: V1, to: V2, claimedLease: "theirs" },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.log.map((l) => l.name)).not.toContain("fail_release");
    expect(w.clock.t).toBeLessThan(until);
    expect(w.install(s.installId)).toMatchObject({
      state: "upgrading",
      lease: "theirs",
    });
  });

  it("rollback: back on previous_version; a replay changes nothing", async () => {
    const s = await active({ slug: "backco", version: V1 });
    await manage("upgrade", s.installId, { args: { from: V1, to: V2 } });
    const r = await manage("rollback", s.installId, {
      args: { from: V2, to: V1 },
      twice: true,
    });
    expect(r.error).toBeNull();
    expect(w.install(s.installId)).toMatchObject({
      version: V1,
      state: "active",
    });
  });
});

describe("suspend, resume, delete, restore (5.5, 5.6)", () => {
  it("suspend pauses HOSTS and sign-in, then records; resume records, then serves", async () => {
    const s = await active({ slug: "pauseco" });
    const r = await manage("suspend", s.installId, {
      args: { reason: "billing" },
    });
    expect(r.error).toBeNull();
    expect(w.hosts("pauseco")).toEqual([
      `paused:${s.installId}`,
      `paused:${s.installId}`,
    ]);
    expect(w.signin(s.installId)?.disabled).toBe(true);
    expect(w.lifecycle(s.installId)).toMatchObject({
      serving_mode: "paused",
      suspended_at: expect.any(Number),
      suspend_reason: "billing",
    });
    expect(w.status(s.installId)?.state).toBe("suspended");
    // A second suspend is not a transition from suspended.
    expect(
      (await manage("suspend", s.installId, { args: { reason: "x" } })).job
        ?.error_code,
    ).toBe("invalid_state");
    const back = await manage("resume", s.installId, { twice: true });
    expect(back.error).toBeNull();
    expect(w.hosts("pauseco")).toEqual([s.installId, s.installId]);
    expect(w.signin(s.installId)?.disabled).toBeUndefined();
    expect(w.lifecycle(s.installId)).toMatchObject({
      serving_mode: "serving",
      suspended_at: null,
      suspend_reason: null,
    });
  });

  it("delete closes and starts the grace; restore reopens (paused if it was suspended)", async () => {
    const s = await active({ slug: "delco" });
    const d = await manage("delete", s.installId);
    expect(d.error).toBeNull();
    expect(w.hosts("delco")).toEqual([
      `closed:${s.installId}`,
      `closed:${s.installId}`,
    ]);
    const lc = w.lifecycle(s.installId) as {
      deleted_at: number;
      purge_at: number;
    };
    expect(lc.purge_at - lc.deleted_at).toBe(GRACE_MS);
    expect(w.status(s.installId)?.state).toBe("deleting");
    expect((await manage("restore", s.installId)).error).toBeNull();
    expect(w.hosts("delco")).toEqual([s.installId, s.installId]);
    expect(w.status(s.installId)?.state).toBe("active");

    await manage("suspend", s.installId, { args: { reason: "r" } });
    await manage("delete", s.installId);
    expect((await manage("restore", s.installId)).error).toBeNull();
    expect(w.hosts("delco")).toEqual([
      `paused:${s.installId}`,
      `paused:${s.installId}`,
    ]);
    expect(w.status(s.installId)?.state).toBe("suspended");
  });

  it("restore after purge_at is refused", async () => {
    const s = await active({ slug: "lateco" });
    await manage("delete", s.installId);
    w.clock.t += GRACE_MS + 1;
    const r = await manage("restore", s.installId);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(w.hosts("lateco")).toEqual([
      `closed:${s.installId}`,
      `closed:${s.installId}`,
    ]);
    // The fail step reconciled the mode from HOSTS.
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("closed");
  });

  it("OIDC acts only on rl- test installs on staging, and never releases a lease (4.4)", async () => {
    const plainOne = await active({ slug: "notrl" });
    const up = await manage("upgrade", plainOne.installId, {
      actor: "oidc",
      args: { from: V2, to: V2 },
    });
    expect(up.job?.error_code).toBe("invalid_state");
    const del = await manage("delete", plainOne.installId, { actor: "oidc" });
    expect(del.job?.error_code).toBe("invalid_state");
    expect(w.status(plainOne.installId)?.state).toBe("active");
    const rl = await active({ slug: "rl-x", actor: "oidc", testHooks: true });
    expect(
      (await manage("release_lease", rl.installId, { actor: "oidc" })).job
        ?.error_code,
    ).toBe("invalid_state");
    // On a prod config the recheck refuses OIDC before anything else.
    (w.env as { OA_ENV: string }).OA_ENV = "prod";
    const prod = await manage("suspend", rl.installId, {
      actor: "oidc",
      args: { reason: "r" },
    });
    w.env.OA_ENV = ENV;
    expect(prod.log.find((l) => l.name === "recheck")?.error?.message).toBe(
      "invalid_state: OIDC is staging only",
    );
    expect(w.status(rl.installId)?.state).toBe("active");
  });

  it("a token may not run an admin-only kind (TRANSITIONS)", async () => {
    const s = await active({ slug: "tokco" });
    const r = await manage("release_lease", s.installId, { actor: "token" });
    expect(r.job?.error_code).toBe("invalid_state");
  });
});

describe("purge and discard (5.6, 2.5 item 4)", () => {
  it("an admin purge of a deleting install tears it down; no HOSTS key is left", async () => {
    const s = await active({ slug: "purgeco" });
    await manage("delete", s.installId);
    const r = await manage("purge", s.installId);
    expect(r.error).toBeNull();
    expect(w.install(s.installId)?.state).toBe("deleted");
    expect(w.hosts("purgeco")).toEqual([undefined, undefined]);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("unmapped");
    expect(w.status(s.installId)?.state).toBe("deleted");
  });

  it("the scheduler's purge waits for purge_at", async () => {
    const s = await active({ slug: "graceco" });
    await manage("delete", s.installId);
    const early = await manage("purge", s.installId, { actor: "system" });
    expect(early.job?.error_code).toBe("invalid_state");
    expect(w.install(s.installId)?.state).toBe("active");
    w.clock.t += GRACE_MS;
    expect(
      (await manage("purge", s.installId, { actor: "system" })).error,
    ).toBeNull();
    expect(w.install(s.installId)?.state).toBe("deleted");
  });

  it("the scheduler never purges a suspended install in grace; an admin does (5.1)", async () => {
    const s = await active({ slug: "susdel" });
    await manage("suspend", s.installId, { args: { reason: "billing" } });
    await manage("delete", s.installId);
    w.clock.t += GRACE_MS + 1;
    const sys = await manage("purge", s.installId, { actor: "system" });
    expect(sys.job?.error_code).toBe("invalid_state");
    expect(w.install(s.installId)?.state).toBe("active");
    expect((await manage("purge", s.installId)).error).toBeNull();
    expect(w.install(s.installId)?.state).toBe("deleted");
  });

  it("skipDirectoryRevoke: R11's {reason} from an admin passes; from the scheduler it is refused", async () => {
    const s = await active({ slug: "skipco" });
    await manage("delete", s.installId);
    w.clock.t += GRACE_MS + 1;
    const skip = { reason: "directory broker down, ticket 42" };
    const sys = await manage("purge", s.installId, {
      actor: "system",
      args: { skipDirectoryRevoke: skip },
    });
    expect(sys.job?.error_code).toBe("invalid_state");
    const bad = await manage("purge", s.installId, {
      args: { skipDirectoryRevoke: { reason: 7 } },
    });
    expect(bad.job?.error_code).toBe("invalid_state");
    const r = await manage("purge", s.installId, {
      args: { skipDirectoryRevoke: skip },
    });
    expect(r.error).toBeNull();
    expect(w.install(s.installId)?.state).toBe("deleted");
  });

  it("purge is refused on an active install (delete accepts active; the recheck is the guard)", async () => {
    const s = await active({ slug: "liveco" });
    const r = await manage("purge", s.installId);
    expect(r.job?.error_code).toBe("invalid_state");
    expect(w.install(s.installId)?.state).toBe("active");
  });

  it("a prod_dirty create's own purge runs (system, never_routed skip, audited)", async () => {
    const s = seedCreate(w, { slug: "dirtyco" });
    w.fake.settingsEdit = (_x, b) => [...b, { name: "EXTRA", type: "service" }];
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    w.fake.settingsEdit = undefined;
    const purgeId = w.manage.created[0]?.id as string;
    const r = stepRunner(w.clock);
    await runManage(w.ctx, event(purgeId), r.step);
    expect(w.job(purgeId)?.status).toBe("done");
    expect(w.install(s.installId)?.state).toBe("deleted");
    expect(
      w.all(
        "SELECT detail FROM hosted_audit WHERE install_id = ? AND detail LIKE ?",
        s.installId,
        `%${NEVER_ROUTED}%`,
      ),
    ).not.toHaveLength(0);
  });

  it("discard: a failed create with no installs row is freed in D1 only", async () => {
    const s = seedCreate(w, { slug: "discardco", version: "0.30.0" });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    expect(w.status(s.installId)?.state).toBe("failed");
    const writes = w.fake.writes().length;
    const r = await manage("discard", s.installId);
    expect(r.error).toBeNull();
    expect(w.status(s.installId)?.state).toBe("deleted");
    expect(w.fake.writes().length).toBe(writes);
  });
});

describe("retry (5.2, kind retry)", () => {
  it("a failed create retried by R12 reaches done under the same install and owner token label", async () => {
    const s = seedCreate(w, { slug: "retryco", version: "0.30.0" });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    expect(w.status(s.installId)?.state).toBe("failed");
    // What R12 writes: a retry job, the signup queued again under it.
    const retry = seedJob(w, {
      kind: "retry",
      installId: s.installId,
      signupId: s.signupId,
    });
    w.db
      .prepare("UPDATE jobs SET workflow = 'provision_install' WHERE id = ?")
      .run(retry);
    w.db
      .prepare(
        "UPDATE signups SET job_id = ?, status = 'queued', version = NULL, error = NULL WHERE signup_id = ?",
      )
      .run(retry, s.signupId);
    await runCreate(w.ctx, event(retry), stepRunner(w.clock).step);
    expect(w.job(retry)?.status).toBe("done");
    expect(w.install(s.installId)?.state).toBe("active");
    expect(w.signup(s.signupId)?.status).toBe("ready");
  });
});

describe("retry resume (5.2, R12)", () => {
  it("a create that failed after its installs row resumes it; a leftover ss- token is swept", async () => {
    const s = seedCreate(w, { slug: "resumeco" });
    w.fake.health = () => new Response(null, { status: 503 });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    w.fake.health = undefined;
    expect(w.job(s.jobId)?.status).toBe("failed");
    expect(w.install(s.installId)?.state).toBe("creating");
    // A crashed attempt's owner PAT, still live.
    const revoked = liveToken(s.installId, `ss-${s.signupId}`, "left-pat");
    const retry = seedJob(w, {
      kind: "retry",
      installId: s.installId,
      signupId: s.signupId,
    });
    w.db
      .prepare("UPDATE jobs SET workflow = 'provision_install' WHERE id = ?")
      .run(retry);
    w.db
      .prepare(
        "UPDATE signups SET job_id = ?, status = 'queued', error = NULL WHERE signup_id = ?",
      )
      .run(retry, s.signupId);
    await runCreate(w.ctx, event(retry), stepRunner(w.clock).step);
    expect(w.job(retry)?.status).toBe("done");
    expect(w.install(s.installId)?.state).toBe("active");
    expect(revoked()).toBe(true);
  });
});

describe("release_lease and cleanup (3.6, R13, R25)", () => {
  it("release_lease drops an expired lease; a live one needs force", async () => {
    const s = await active({ slug: "leaseco" });
    w.db
      .prepare(
        "UPDATE installs SET lease = 'dead', lease_until = ? WHERE id = ?",
      )
      .run(w.clock.t + 60_000, s.installId);
    const live = await manage("release_lease", s.installId);
    expect(live.job?.status).toBe("failed");
    expect(
      (await manage("release_lease", s.installId, { args: { force: true } }))
        .error,
    ).toBeNull();
    expect(w.install(s.installId)?.lease).toBeNull();
  });

  it("cleanup of a canceled create: waits out the lease, releases it, settles the signup", async () => {
    const s = seedCreate(w, {
      slug: "cancelco",
      source: "self-serve",
      tier: "trial",
    });
    // R25: the job failed canceled, its cleanup inserted.
    w.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled', finished_at = 1 WHERE id = ?",
      )
      .run(s.jobId);
    const r = await manage("cleanup", s.installId, {
      parentJobId: s.jobId,
      signupId: s.signupId,
    });
    expect(r.error).toBeNull();
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "parent",
      "release_lease",
      "sweep_tokens",
      "settle",
      "done",
    ]);
    expect(r.job?.status).toBe("done");
    expect(w.signup(s.signupId)?.status).toBe("failed");
    expect(w.job(s.jobId)?.error_code).toBe("canceled");
    expect(
      w.get("SELECT freed_at FROM signup_accounts WHERE owner_sub = ?", s.sub),
    ).toEqual({
      freed_at: expect.any(Number),
    });
  });

  it("cleanup of a canceled upgrade left upgrading: sleeps to lease_until, then releases without force", async () => {
    const s = await active({ slug: "cupco" });
    const until = w.clock.t + 20 * 60_000;
    w.db
      .prepare(
        "UPDATE installs SET state = 'upgrading', lease = 'gone', lease_until = ? WHERE id = ?",
      )
      .run(until, s.installId);
    const parent = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      status: "failed",
    });
    w.db
      .prepare("UPDATE jobs SET error_code = 'canceled' WHERE id = ?")
      .run(parent);
    const r = await manage("cleanup", s.installId, { parentJobId: parent });
    expect(r.error).toBeNull();
    expect(w.clock.t).toBeGreaterThan(until);
    expect(w.install(s.installId)).toMatchObject({
      state: "active",
      lease: null,
    });
  });
});

describe("cleanup sweeps the parent's owner-token label (3.6, R25)", () => {
  it("a canceled upgrade's live ss- token is revoked", async () => {
    const s = await active({ slug: "sweepco", version: V1 });
    // The label the upgrade minted under: the install's signup (labelOf).
    // The isolate died before guarded()'s revoke: a live owner PAT.
    const revoked = liveToken(s.installId, `ss-${s.signupId}`, "live-pat");
    const parent = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
      status: "failed",
    });
    w.db
      .prepare("UPDATE jobs SET error_code = 'canceled' WHERE id = ?")
      .run(parent);
    const r = await manage("cleanup", s.installId, { parentJobId: parent });
    expect(r.error).toBeNull();
    expect(revoked()).toBe(true);
  });
});

/** The rl- install's own API, as the CLI's test stubbed it. */
/**
 * The install's dispatch stub: its token API over `tokens` (live PATs;
 * DELETE removes one, POST adds `t-new`). Stubs chain, one per install, so
 * a test can hold two installs.
 */
function stubInstall(
  installId: string,
  tokens: { id: string; label: string }[] = [
    { id: "t1", label: "redline-old" },
    { id: "t2", label: "ci-1" },
  ],
) {
  const scriptName = `oa-s-${installId}`;
  const script = w.fake.script(NAMESPACES[ENV], scriptName);
  const deleted: string[] = [];
  const seen: string[] = [];
  const real = w.env.DISPATCHER;
  w.env.DISPATCHER = {
    get: (name: string) => ({
      fetch: async (req: Request) => {
        if (name !== scriptName) return real.get(name).fetch(req);
        const u = new URL(req.url);
        seen.push(`${req.method} ${u.pathname}`);
        const key = script?.secrets.get("TEST_HOOK_KEY");
        if (u.pathname === "/__test/session")
          return req.headers.get("authorization") === `Bearer ${key}`
            ? Response.json({ cookie: "sess" })
            : new Response(null, { status: 401 });
        if (u.pathname === "/api/v1/tokens" && req.method === "GET")
          return Response.json(tokens);
        if (
          u.pathname.startsWith("/api/v1/tokens/") &&
          req.method === "DELETE"
        ) {
          const id = u.pathname.split("/").at(-1) as string;
          deleted.push(id);
          const i = tokens.findIndex((t) => t.id === id);
          if (i < 0) return new Response(null, { status: 404 });
          tokens.splice(i, 1);
          return new Response(null, { status: 204 });
        }
        if (u.pathname === "/api/v1/tokens" && req.method === "POST") {
          const { label } = (await req.json()) as { label: string };
          tokens.push({ id: "t-new", label });
          return Response.json(
            { id: "t-new", label, token: "oa_pat_minted_secret_value" },
            { status: 201 },
          );
        }
        if (u.pathname === "/api/v1/me")
          return req.headers.get("authorization") ===
            "Bearer oa_pat_minted_secret_value"
            ? Response.json({})
            : new Response(null, { status: 401 });
        return real.get(name).fetch(req);
      },
    }),
  } as unknown as DispatchNamespace;
  return { script, deleted, seen, tokens };
}

describe("redline_creds (10.1, R26)", () => {
  it("rotates TEST_HOOK_KEY, mints one redline- PAT after revoking older ones, seals {pat, hookKey}", async () => {
    const s = await active({ slug: "rl-a", actor: "oidc", testHooks: true });
    const { script, deleted, seen } = stubInstall(s.installId);
    const oldKey = script?.secrets.get("TEST_HOOK_KEY");
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    const recipientKey = Buffer.from(raw).toString("base64url");
    const r = await manage("redline_creds", s.installId, {
      actor: "oidc",
      args: { recipientKey },
    });
    expect(r.error).toBeNull();
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "recheck",
      "rotate_hook_key",
      "done",
    ]);
    const newKey = script?.secrets.get("TEST_HOOK_KEY") as string;
    expect(newKey).not.toBe(oldKey);
    expect(deleted).toEqual(["t1"]);
    const sealed = r.job?.sealed as string;
    expect(sealed).toMatch(/^oa-seal-v1\./);
    expect(JSON.parse(await openSealed(pair, sealed))).toEqual({
      pat: "oa_pat_minted_secret_value",
      hookKey: newKey,
    });
    // No credential in any step output or the job row's other columns.
    const text =
      JSON.stringify(r.log) + JSON.stringify({ ...r.job, sealed: null });
    expect(text).not.toContain("oa_pat_minted");
    expect(text).not.toContain(newKey);
    expect(seen).toContain("POST /__test/session");
  });

  it("revoke (C6): revokes the install's live redline-* PATs, mints and seals nothing; a repeat is a no-op done", async () => {
    const s = await active({ slug: "rl-b", actor: "oidc", testHooks: true });
    const { deleted, seen, tokens } = stubInstall(s.installId, [
      { id: "t1", label: "redline-101" },
      { id: "t2", label: "redline-102" },
      { id: "t3", label: "ci-1" },
    ]);
    const r = await manage("redline_creds", s.installId, {
      actor: "oidc",
      args: { revoke: true },
    });
    expect(r.error).toBeNull();
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "recheck",
      "revoke",
      "done",
    ]);
    // args.revoke is recorded on the rechecked job (never a key).
    expect(r.log.find((l) => l.name === "recheck")?.output).toMatchObject({
      args: { revoke: true },
    });
    expect(r.log.find((l) => l.name === "revoke")?.output).toEqual({
      revoked: 2,
    });
    expect(r.job).toMatchObject({ status: "done", step: "done" });
    expect(r.job?.sealed).toBeNull();
    expect(deleted).toEqual(["t1", "t2"]);
    expect(tokens).toEqual([{ id: "t3", label: "ci-1" }]);
    expect(seen).not.toContain("POST /api/v1/tokens");

    const again = await manage("redline_creds", s.installId, {
      actor: "oidc",
      args: { revoke: true },
    });
    expect(again.error).toBeNull();
    expect(again.job).toMatchObject({ status: "done", step: "done" });
    expect(again.log.find((l) => l.name === "revoke")?.output).toEqual({
      revoked: 0,
    });
    expect(deleted).toEqual(["t1", "t2"]);
    expect(again.job?.sealed).toBeNull();
  });

  it("absent revoke is a mint: a job with no recipientKey is refused at recheck, before any write", async () => {
    const s = await active({ slug: "rl-b", actor: "oidc", testHooks: true });
    const { deleted, seen } = stubInstall(s.installId);
    const script = w.fake.script(NAMESPACES[ENV], `oa-s-${s.installId}`);
    const oldKey = script?.secrets.get("TEST_HOOK_KEY");
    for (const args of [{}, { revoke: false }, { revoke: "yes" }]) {
      const r = await manage("redline_creds", s.installId, {
        actor: "oidc",
        args,
      });
      expect(r.job).toMatchObject({
        status: "failed",
        error_code: "invalid_state",
      });
      expect(r.log.map((l) => l.name)).toEqual(["load", "recheck", "fail"]);
      expect(r.job?.sealed).toBeNull();
    }
    expect(deleted).toEqual([]);
    expect(seen).toEqual([]);
    expect(script?.secrets.get("TEST_HOOK_KEY")).toBe(oldKey);
  });

  it("REDLINE_SCOPE_FIXTURE (C6): mint and revoke touch only the target install's live redline-* PATs", async () => {
    const F = REDLINE_SCOPE_FIXTURE;
    const t = await active({ slug: "rl-a", actor: "oidc", testHooks: true });
    const o = await active({ slug: "rl-b", actor: "oidc", testHooks: true });
    // The fixture's installs are these two; its live PATs are what each
    // install's token API lists (the minted one appears once minted).
    const live = (installId: string, skip?: string) =>
      F.pats
        .filter(
          (p) =>
            p.installId === installId && p.revokedAt === null && p.id !== skip,
        )
        .map((p) => ({ id: p.id, label: p.label }));
    const target = stubInstall(t.installId, live(F.target, F.minted));
    const other = stubInstall(o.installId, live(F.other));
    const otherBefore = [...other.tokens];
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const recipientKey = Buffer.from(
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
      ),
    ).toString("base64url");
    // The stub mints `t-new`; the fixture's minted PAT is F.minted.
    target.tokens.length = 0;
    target.tokens.push(...live(F.target, F.minted));
    const mint = await manage("redline_creds", t.installId, {
      actor: "oidc",
      args: { recipientKey },
    });
    expect(mint.error).toBeNull();
    expect(target.deleted).toEqual([...F.expect.mint]);
    expect(other.deleted).toEqual([]);
    expect(other.seen).toEqual([]);

    // Revoke: the target's live redline-* PATs, the minted one included.
    target.tokens.length = 0;
    target.tokens.push(...live(F.target));
    target.deleted.length = 0;
    const rev = await manage("redline_creds", t.installId, {
      actor: "oidc",
      args: { revoke: true },
    });
    expect(rev.error).toBeNull();
    expect(target.deleted).toEqual([...F.expect.revoke]);
    expect(target.tokens.map((p) => p.id)).toEqual([
      "pat-t-owner",
      "pat-t-human",
    ]);
    expect(other.deleted).toEqual([]);
    expect(other.tokens).toEqual(otherBefore);
  });

  it("is refused for a non-test install, and for any actor but OIDC", async () => {
    const s = await active({ slug: "plainco" });
    const r = await manage("redline_creds", s.installId, {
      args: { recipientKey: "A".repeat(43) },
    });
    expect(r.job?.error_code).toBe("invalid_state");
    const rl = await active({ slug: "rl-c", actor: "oidc", testHooks: true });
    const admin = await manage("redline_creds", rl.installId, {
      args: { recipientKey: "A".repeat(43) },
    });
    expect(admin.job?.error_code).toBe("invalid_state");
  });
});

describe("near-expiry token mode per kind (5.7)", () => {
  // Within REFUSE_TOKEN_DAYS (5) of expiry.
  const nearExpiry = () => {
    w.fake.tokenInfo = {
      ...w.fake.tokenInfo,
      expires_on: new Date(w.clock.t + 2 * 86_400_000).toISOString(),
    };
  };
  // Past its end date: token_invalid, retried (3.5).
  const expiredToken = () => {
    w.fake.tokenInfo = {
      ...w.fake.tokenInfo,
      expires_on: new Date(w.clock.t - 86_400_000).toISOString(),
    };
  };

  it("warn: suspend goes on; refuse: upgrade fails invalid_state (terminal, #882), unchanged", async () => {
    const s = await active({ slug: "nearco", version: V1 });
    nearExpiry();
    expect(
      (await manage("suspend", s.installId, { args: { reason: "r" } })).error,
    ).toBeNull();
    await manage("resume", s.installId);
    const up = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(up.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(w.install(s.installId)?.version).toBe(V1);
  });

  it("every manage kind follows NEAR_EXPIRY_MODE: recovery warns, forward changes refuse", async () => {
    const sus = await active({ slug: "nx-sus" });
    await manage("suspend", sus.installId, { args: { reason: "r" } });
    const del = await active({ slug: "nx-del" });
    const gone = await active({ slug: "nx-gone" });
    const back = await active({ slug: "nx-back", version: V1 });
    await manage("upgrade", back.installId, { args: { from: V1, to: V2 } });
    const lease = await active({ slug: "nx-lease" });
    nearExpiry();
    const outcome = async (
      kind: string,
      installId: string,
      o: Parameters<typeof manage>[2] = {},
    ) => {
      const r = await manage(kind, installId, o);
      return r.job?.status === "done" ? "done" : r.job?.error_code;
    };
    expect(await outcome("resume", sus.installId)).toBe("invalid_state");
    // D1 went up first (5.5); HOSTS still pauses it, and the fail step's
    // reconcile says so.
    expect(w.hosts("nx-sus")[0]).toBe(`paused:${sus.installId}`);
    expect(w.lifecycle(sus.installId)?.serving_mode).toBe("paused");
    expect(await outcome("delete", del.installId)).toBe("done");
    expect(await outcome("restore", del.installId)).toBe("invalid_state");
    // A refused restore still cleared purge_at first (5.6); purge another.
    expect(await outcome("delete", gone.installId)).toBe("done");
    expect(await outcome("purge", gone.installId)).toBe("done");
    expect(
      await outcome("rollback", back.installId, { args: { from: V2, to: V1 } }),
    ).toBe("done");
    const expired = () =>
      w.db
        .prepare(
          "UPDATE installs SET lease = 'dead', lease_until = ? WHERE id = ?",
        )
        .run(w.clock.t - 1, lease.installId);
    expired();
    expect(await outcome("release_lease", lease.installId)).toBe("done");
    expired();
    const parent = seedJob(w, {
      kind: "suspend",
      installId: lease.installId,
      status: "failed",
    });
    expect(
      await outcome("cleanup", lease.installId, { parentJobId: parent }),
    ).toBe("done");
    expect(w.install(lease.installId)?.lease).toBeNull();
  });

  it("token_invalid retries every 15 minutes for 2 hours, then fails", async () => {
    const s = await active({ slug: "nxwait", version: V1 });
    expiredToken();
    const t0 = w.clock.t;
    const up = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(up.job).toMatchObject({
      status: "failed",
      error_code: "token_invalid",
    });
    const names = up.log.map((l) => l.name);
    expect(new Set(names.filter((n) => /^upload_token\d$/.test(n))).size).toBe(
      8,
    );
    expect(names).toContain("upload_token8");
    expect(w.clock.t - t0).toBeGreaterThanOrEqual(2 * 3_600_000);
  });

  it("token_invalid: a token rolled during a wait lets the job finish", async () => {
    const s = await active({ slug: "nxroll", version: V1 });
    const good = w.fake.tokenInfo;
    expiredToken();
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    const r = stepRunner(w.clock, {
      onStep: (n) => {
        if (n === "upload_token2") w.fake.tokenInfo = good;
      },
    });
    await runManage(w.ctx, event(id), r.step);
    expect(w.job(id)?.status).toBe("done");
    expect(r.log.find((l) => l.name === "upload")?.error?.message).toMatch(
      /^token_invalid: /,
    );
    expect(w.install(s.installId)?.version).toBe(V2);
  });

  it("refuse: redline_creds fails invalid_state before the hook key is rotated", async () => {
    const s = await active({ slug: "rl-n", actor: "oidc", testHooks: true });
    const { script } = stubInstall(s.installId);
    const key = script?.secrets.get("TEST_HOOK_KEY");
    nearExpiry();
    const r = await manage("redline_creds", s.installId, {
      actor: "oidc",
      args: { recipientKey: "A".repeat(43) },
    });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(script?.secrets.get("TEST_HOOK_KEY")).toBe(key);
  });
});

describe("audit, lease and dirty-pause edges (4.9, 5.4, 3.6)", () => {
  const audits = (installId: string, action: string) =>
    w.all(
      "SELECT detail FROM hosted_audit WHERE install_id = ? AND action = ?",
      installId,
      action,
    );
  const jobAudits = (installId: string, kind: string, action: string) =>
    w.all(
      "SELECT actor, detail FROM hosted_audit WHERE install_id = ? AND action = ? AND json_extract(detail, '$.kind') = ?",
      installId,
      action,
      kind,
    );

  it("4.9: WfpProvisioner's own rows go to hosted_audit through auditAs, as job:<jobId>, never actorless", async () => {
    const s = await active({ slug: "actorco", version: V1 });
    const up = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(up.job?.status).toBe("done");
    const rows = w.all(
      "SELECT actor, action FROM hosted_audit WHERE install_id = ? ORDER BY id",
      s.installId,
    ) as { actor: string | null; action: string }[];
    const by = (a: string) => rows.filter((x) => x.action === a);
    expect(by("create.start").map((x) => x.actor)).toEqual([`job:${s.jobId}`]);
    expect(by("upgrade.start").map((x) => x.actor)).toEqual([`job:${up.id}`]);
    expect(by("upgrade.done").map((x) => x.actor)).toEqual([`job:${up.id}`]);
    expect(rows.filter((x) => x.actor === null)).toEqual([]);
    // Nothing of provision's lands in admin_audit (4.9's table).
    expect(
      w.all("SELECT 1 FROM admin_audit WHERE detail LIKE ?", `%${up.id}%`),
    ).toEqual([]);
  });

  it("job.done is written once on a replay; job.failed once with its kind and code, as job:<id>", async () => {
    const s = await active({ slug: "auditco", version: V1 });
    expect(jobAudits(s.installId, "create", "job.done")).toHaveLength(1);
    const sus = await manage("suspend", s.installId, {
      args: { reason: "r" },
      twice: true,
    });
    expect(jobAudits(s.installId, "suspend", "job.done")).toEqual([
      {
        actor: `job:${sus.id}`,
        detail: JSON.stringify({ jobId: sus.id, kind: "suspend" }),
      },
    ]);
    const bad = await manage("upgrade", s.installId, {
      args: { from: V2, to: V2 },
    });
    expect(bad.job?.status).toBe("failed");
    expect(jobAudits(s.installId, "upgrade", "job.failed")).toEqual([
      {
        actor: `job:${bad.id}`,
        detail: JSON.stringify({
          code: bad.job?.error_code,
          jobId: bad.id,
          kind: "upgrade",
        }),
      },
    ]);
  });

  it("a failed create is audited job.failed", async () => {
    const s = seedCreate(w, { slug: "badrel", version: "9.9.9" });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    expect(w.job(s.jobId)?.status).toBe("failed");
    expect(jobAudits(s.installId, "create", "job.failed")).toHaveLength(1);
  });

  it("a dirty upgrade pauses in its own step; a replayed upload never renders again", async () => {
    const s = await active({ slug: "dirtyre", version: V1 });
    w.fake.settingsEdit = (_x, b) => [...b, { name: "EXTRA", type: "service" }];
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
      twice: true,
    });
    w.fake.settingsEdit = undefined;
    expect(r.job).toMatchObject({ status: "failed", error_code: "prod_dirty" });
    expect(r.log.map((l) => l.name)).toContain("pause_dirty");
    expect(r.log.find((l) => l.name === "upload")?.output).toEqual({
      version: V2,
      dirty: true,
    });
    expect(audits(s.installId, "upgrade.start")).toHaveLength(1);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("paused");
  });

  it("a dirty upgrade replayed after its upload result: pause_dirty from the step result, prod_dirty, args clean", async () => {
    const s = await active({ slug: "dirtylost", version: V1 });
    w.fake.settingsEdit = (_x, b) => [...b, { name: "EXTRA", type: "service" }];
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    const results = new Map<string, unknown>();
    // The isolate dies after upload's result is stored, before the pause.
    const first = stepRunner(w.clock, { results, evictBefore: "pause_dirty" });
    void runManage(w.ctx, event(id), first.step);
    await first.evicted;
    w.fake.settingsEdit = undefined;
    const writes = w.fake.writes().length;
    const again = stepRunner(w.clock, { results });
    await runManage(w.ctx, event(id), again.step).catch(() => {});
    const replayed = again.log.filter((l) => l.replayed).map((l) => l.name);
    expect(replayed).toEqual(["load", "recheck", "release_gate", "upload"]);
    expect(w.job(id)).toMatchObject({
      status: "failed",
      error_code: "prod_dirty",
    });
    // Never rendered again: no script upload or settings write after it.
    expect(audits(s.installId, "upgrade.start")).toHaveLength(1);
    expect(
      w.fake
        .writes()
        .slice(writes)
        .filter((x) => x.includes("/scripts/")),
    ).toEqual([]);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("paused");
    expect(JSON.parse(w.job(id)?.args as string)).toEqual({ from: V1, to: V2 });
  });

  /** An upgrade whose isolate dies after upload's body, before its result is stored, then replayed. */
  async function lostUpload(slug: string, dirty?: "to" | "both") {
    const s = await active({ slug, version: V1 });
    if (dirty === "to")
      // No rollback (the DO tag moved): the dirty `to` keeps serving.
      w.db
        .prepare(
          "UPDATE install_versions SET do_migration_tag = 'v-older' WHERE install_id = ? AND version = ?",
        )
        .run(s.installId, V1);
    if (dirty)
      w.fake.settingsEdit = (_x, b) => [
        ...b,
        { name: "EXTRA", type: "service" },
      ];
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    const results = new Map<string, unknown>();
    const first = stepRunner(w.clock, { results, evictAfter: "upload" });
    void runManage(w.ctx, event(id), first.step);
    await first.evicted;
    w.fake.settingsEdit = undefined;
    const writes = w.fake.writes().length;
    const again = stepRunner(w.clock, { results });
    await runManage(w.ctx, event(id), again.step).catch(() => {});
    expect(again.log.filter((l) => l.replayed).map((l) => l.name)).toEqual([
      "load",
      "recheck",
      "release_gate",
    ]);
    // Never rendered again: no script upload or settings write on the replay.
    expect(audits(s.installId, "upgrade.start")).toHaveLength(1);
    expect(
      w.fake
        .writes()
        .slice(writes)
        .filter((x) => x.includes("/scripts/")),
    ).toEqual([]);
    expect(JSON.parse(w.job(id)?.args as string)).toEqual({ from: V1, to: V2 });
    return { s, id, again };
  }

  it("a clean upgrade whose upload result was lost: the replay reads the job's audit trail, done, never paused", async () => {
    const { s, id, again } = await lostUpload("cleandied");
    expect(w.install(s.installId)).toMatchObject({
      version: V2,
      state: "active",
    });
    expect(w.job(id)?.status).toBe("done");
    expect(again.log.map((l) => l.name)).not.toContain("pause_dirty");
    expect(w.lifecycle(s.installId)?.serving_mode).not.toBe("paused");
  });

  it("a dirty `to` whose upload result was lost: the replay pauses it, prod_dirty", async () => {
    const { s, id, again } = await lostUpload("dirtydied", "to");
    expect(w.install(s.installId)).toMatchObject({
      version: V2,
      state: "active",
    });
    expect(w.job(id)).toMatchObject({
      status: "failed",
      error_code: "prod_dirty",
    });
    expect(again.log.map((l) => l.name)).toContain("pause_dirty");
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("paused");
  });

  it("a dirty rollback whose upload result was lost: back on from, paused, prod_dirty, never a second upload", async () => {
    const { s, id, again } = await lostUpload("dirtyback", "both");
    expect(w.install(s.installId)).toMatchObject({
      version: V1,
      state: "active",
    });
    expect(w.job(id)).toMatchObject({
      status: "failed",
      error_code: "prod_dirty",
    });
    expect(again.log.map((l) => l.name)).toContain("pause_dirty");
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("paused");
  });

  it("a clean upgrade: done, never paused, args clean; a replay of the whole run changes nothing", async () => {
    const s = await active({ slug: "cleanmark", version: V1 });
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    const results = new Map<string, unknown>();
    await runManage(
      w.ctx,
      event(id),
      stepRunner(w.clock, { results, twice: true }).step,
    );
    expect(w.job(id)?.status).toBe("done");
    expect(JSON.parse(w.job(id)?.args as string)).toEqual({ from: V1, to: V2 });
    expect(w.lifecycle(s.installId)?.serving_mode).not.toBe("paused");
    const writes = w.fake.writes().length;
    const again = stepRunner(w.clock, { results });
    await runManage(w.ctx, event(id), again.step);
    expect(again.log.every((l) => l.replayed)).toBe(true);
    expect(w.fake.writes().length).toBe(writes);
    expect(w.job(id)?.status).toBe("done");
  });

  it("the dirty pause warns near expiry (a suspend), whatever the parent kind", async () => {
    const s = await active({ slug: "dirtynear", version: V1 });
    w.fake.settingsEdit = (_x, b) => {
      // The token entered REFUSE_TOKEN_DAYS while the upgrade ran.
      w.fake.tokenInfo = {
        ...w.fake.tokenInfo,
        expires_on: new Date(w.clock.t + 2 * 86_400_000).toISOString(),
      };
      return [...b, { name: "EXTRA", type: "service" }];
    };
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    w.fake.settingsEdit = undefined;
    expect(r.job).toMatchObject({ status: "failed", error_code: "prod_dirty" });
    expect(w.hosts("dirtynear")[0]).toBe(`paused:${s.installId}`);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("paused");
  });

  it("an upgrade that died between its claim and the first report: fail still releases the lease", async () => {
    const s = await active({ slug: "earlyco", version: V1 });
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    let until = 0;
    const r = stepRunner(w.clock, {
      onStep: (n) => {
        if (n !== "upload") return;
        // Claimed (30 minutes from now), no claimedLease recorded yet.
        until = w.clock.t + 30 * 60_000;
        w.db
          .prepare(
            "UPDATE installs SET state = 'upgrading', lease = 'early', lease_until = ? WHERE id = ?",
          )
          .run(until, s.installId);
        throw new Error("isolate evicted");
      },
    });
    await runManage(w.ctx, event(id), r.step).catch(() => {});
    expect(r.log.map((l) => l.name)).toContain("fail_release");
    expect(w.clock.t).toBeGreaterThan(until);
    expect(w.install(s.installId)).toMatchObject({
      state: "active",
      lease: null,
    });
  });

  it("fail_release in a new isolate goes by the lease the fail step stored, never a newer one", async () => {
    const s = await active({ slug: "sleptco", version: V1 });
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
    });
    let until = 0;
    const results = new Map<string, unknown>();
    const first = stepRunner(w.clock, {
      results,
      evictBefore: "fail_release",
      onStep: (n) => {
        if (n !== "upload") return;
        until = w.clock.t + 30 * 60_000;
        w.db
          .prepare(
            "UPDATE installs SET state = 'upgrading', lease = 'early', lease_until = ? WHERE id = ?",
          )
          .run(until, s.installId);
        throw new Error("isolate evicted");
      },
    });
    void runManage(w.ctx, event(id), first.step);
    await first.evicted;
    expect(results.get("fail")).toMatchObject({ lease: "early" });
    // During the sleep, another holder claims the row (after the job started).
    w.db
      .prepare(
        "UPDATE installs SET state = 'upgrading', lease = 'other', lease_until = ? WHERE id = ?",
      )
      .run(until + 60 * 60_000, s.installId);
    const again = stepRunner(w.clock, { results });
    await runManage(w.ctx, event(id), again.step).catch(() => {});
    expect(again.log.find((l) => l.name === "fail_release")).toMatchObject({
      output: { released: false },
    });
    expect(w.install(s.installId)).toMatchObject({ lease: "other" });
  });

  it("cleanup of a canceled create holding its lease: sleeps it out, releases it, settles the signup", async () => {
    const s = seedCreate(w, {
      slug: "cleasco",
      source: "self-serve",
      tier: "trial",
    });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
    // Back to a create still under its lease, then R25.
    const until = w.clock.t + 20 * 60_000;
    w.db
      .prepare(
        "UPDATE installs SET state = 'creating', lease = 'create', lease_until = ? WHERE id = ?",
      )
      .run(until, s.installId);
    w.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled' WHERE id = ?",
      )
      .run(s.jobId);
    w.db
      .prepare("UPDATE signups SET status = 'creating' WHERE signup_id = ?")
      .run(s.signupId);
    const r = await manage("cleanup", s.installId, {
      parentJobId: s.jobId,
      signupId: s.signupId,
    });
    expect(r.error).toBeNull();
    expect(w.clock.t).toBeGreaterThan(until);
    expect(r.log.find((l) => l.name === "release_lease")?.output).toEqual({
      released: true,
      until: null,
    });
    expect(w.install(s.installId)?.lease).toBeNull();
    expect(w.signup(s.signupId)?.status).toBe("failed");
  });

  it("cleanup: a lease renewed while it slept is slept out again; one never let go still settles the parent", async () => {
    const s = await active({ slug: "renewco" });
    const parent = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      status: "running",
    });
    const renew = () =>
      w.db
        .prepare(
          "UPDATE installs SET state = 'upgrading', lease = 'stuck', lease_until = ? WHERE id = ?",
        )
        .run(w.clock.t + 10 * 60_000, s.installId);
    renew();
    w.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled' WHERE id = ?",
      )
      .run(parent);
    // Renewed once: the second wait releases it.
    let n = 0;
    const once = stepRunner(w.clock, {
      onStep: (name) => {
        if (name.startsWith("release_lease") && n++ === 0) renew();
      },
    });
    const id = seedJob(w, {
      kind: "cleanup",
      installId: s.installId,
      parentJobId: parent,
    });
    await runManage(w.ctx, event(id), once.step);
    expect(w.job(id)?.status).toBe("done");
    expect(once.log.map((l) => l.name)).toContain("release_lease_1");
    expect(w.install(s.installId)?.lease).toBeNull();

    // Renewed every time: lease_held, but the parent is settled first.
    renew();
    const p2 = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      status: "failed",
    });
    const always = stepRunner(w.clock, {
      onStep: (name) => {
        if (name.startsWith("release_lease")) renew();
      },
    });
    const id2 = seedJob(w, {
      kind: "cleanup",
      installId: s.installId,
      parentJobId: p2,
    });
    await runManage(w.ctx, event(id2), always.step).catch(() => {});
    expect(always.log.find((l) => l.name === "settle")?.output).toEqual({
      settled: p2,
    });
    expect(w.job(id2)).toMatchObject({
      status: "failed",
      error_code: "lease_held",
    });
  });

  it("an OIDC purge may not skip the directory revoke (admin only)", async () => {
    const rl = await active({ slug: "rl-p", actor: "oidc", testHooks: true });
    await manage("delete", rl.installId, { actor: "oidc" });
    const r = await manage("purge", rl.installId, {
      actor: "oidc",
      args: { skipDirectoryRevoke: { reason: "broker down" } },
    });
    expect(r.job?.error_code).toBe("invalid_state");
    expect(r.log.find((l) => l.name === "recheck")?.error?.message).toBe(
      "invalid_state: skipDirectoryRevoke is an admin's, with a reason",
    );
  });
});

describe("recheck: actor and restore edges (2.5, 5.6)", () => {
  it("a user job on an admin-sourced install is refused", async () => {
    const s = await active({ slug: "notmine" });
    const r = await manage("delete", s.installId, { actor: "user" });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(w.lifecycle(s.installId)?.deleted_at).toBeNull();
  });

  it("restore is refused once a purge job exists, inside the grace period", async () => {
    const s = await active({ slug: "purgeco" });
    expect((await manage("delete", s.installId)).job?.status).toBe("done");
    seedJob(w, { kind: "purge", installId: s.installId, status: "failed" });
    const r = await manage("restore", s.installId);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(w.lifecycle(s.installId)?.purge_at).toBeGreaterThan(w.clock.t);
  });
});
