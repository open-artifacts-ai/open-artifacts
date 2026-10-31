import {
  canTransition,
  PURGE_STUCK_FAILURES,
  REQUEST_ID_RE,
} from "@oa/shared/provisioning";
import { FakeWorkflow } from "@oa/shared/provisioning/fakes";
import {
  PURGE_MAX_TRIES,
  purgeRequestId,
  SYSTEM_ACTOR,
} from "@oa/shared/provisioning/system";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sqlConditions } from "../src/provapi/conditions.js";
import type { ProvapiEnv } from "../src/provapi/env.js";
import { PURGE_LIMIT, purgeDue } from "../src/provapi/purge.js";
import {
  captureLogs,
  db,
  install,
  installId,
  job,
  lifecycle,
  migrate,
  reset,
  rows,
} from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const DAY = 24 * 60 * 60_000;
const PURGE_AT = NOW - 1;

function fakes() {
  const manage = new FakeWorkflow();
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    MANAGE_INSTALL: manage,
  } as unknown as ProvapiEnv;
  return { env, manage };
}

/** A soft-deleted install in grace until purgeAt. */
async function deleting(
  purgeAt: number | null = PURGE_AT,
  over: Record<string, number | null> = {},
) {
  const id = installId();
  await install(id, { state: "active" });
  await lifecycle(id, {
    deleted_at: purgeAt === null ? null : purgeAt - 7 * DAY,
    purge_at: purgeAt,
    serving_mode: "closed",
    ...over,
  });
  return id;
}

const purges = (id: string) =>
  rows(
    "SELECT * FROM jobs WHERE install_id = ?1 AND kind = 'purge' ORDER BY created_at, request_id",
    id,
  );
const fail = (jobId: unknown) =>
  db
    .prepare(
      "UPDATE jobs SET status = 'failed', error_code = 'revoke_pending', finished_at = ?2, updated_at = ?2 WHERE id = ?1",
    )
    .bind(jobId, NOW)
    .run();

describe("purge after grace", () => {
  it("the scheduler may purge a deleting install (TRANSITIONS)", () => {
    expect(canTransition("deleting", "purge", "S")).toBe(true);
  });

  it("purge_at passed: one purge job, started, with the try-0 request id and args { purgeAt, n }", async () => {
    const f = fakes();
    const id = await deleting();
    const lines = captureLogs(vi.spyOn);
    await purgeDue(f.env, NOW);
    const [p, ...rest] = await purges(id);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      kind: "purge",
      workflow: "manage_install",
      actor_kind: SYSTEM_ACTOR.kind,
      actor_key: SYSTEM_ACTOR.key,
      request_id: `purge-${id}-${PURGE_AT}-0`,
      status: "queued",
    });
    expect(JSON.parse(String(p?.args))).toEqual({ purgeAt: PURGE_AT, n: 0 });
    expect(p?.request_id).toMatch(REQUEST_ID_RE);
    expect(f.manage.created).toEqual([{ id: p?.id, params: { jobId: p?.id } }]);
    expect(lines).toEqual([`provapi purge queued ${id} ${p?.id} try=0`]);
  });

  it("not before purge_at", async () => {
    const f = fakes();
    const id = await deleting(NOW + 1);
    await purgeDue(f.env, NOW);
    expect(await purges(id)).toEqual([]);
  });

  it("never while suspended", async () => {
    const f = fakes();
    const id = await deleting(PURGE_AT, { suspended_at: NOW - DAY });
    for (let t = NOW; t < NOW + 30 * DAY; t += DAY) await purgeDue(f.env, t);
    expect(await purges(id)).toEqual([]);
  });

  it("blocked by an active job", async () => {
    const f = fakes();
    const id = await deleting();
    await job(id, { kind: "release_lease", workflow: "manage_install" });
    await purgeDue(f.env, NOW);
    expect(await purges(id)).toEqual([]);
  });

  it("restore (purge_at cleared) stops it", async () => {
    const f = fakes();
    const id = await deleting();
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = NULL, purge_at = NULL WHERE install_id = ?1",
      )
      .bind(id)
      .run();
    await purgeDue(f.env, NOW);
    expect(await purges(id)).toEqual([]);
  });

  it(`tries 0 to ${PURGE_MAX_TRIES - 1}, then no more, and purge_stuck opens`, async () => {
    expect(PURGE_MAX_TRIES).toBe(PURGE_STUCK_FAILURES);
    const f = fakes();
    const id = await deleting();
    for (let n = 0; n < PURGE_MAX_TRIES + 2; n++) {
      await purgeDue(f.env, NOW + n);
      const all = await purges(id);
      expect(all).toHaveLength(Math.min(n + 1, PURGE_MAX_TRIES));
      const last = all.at(-1);
      if (n < PURGE_MAX_TRIES) {
        expect(last?.request_id).toBe(purgeRequestId(id, PURGE_AT, n));
        expect(JSON.parse(String(last?.args))).toEqual({
          purgeAt: PURGE_AT,
          n,
        });
        expect(last?.request_id).toMatch(REQUEST_ID_RE);
        await fail(last?.id);
      }
    }
    const c = await sqlConditions(db, { now: NOW, signupDailyCap: 0 });
    expect(c.purge_stuck.open).toBe(true);
    expect(c.purge_stuck.rows.map((r) => r.install_id)).toEqual([id]);
  });

  it("tries count every failed purge on the install, as purge_stuck does: the scheduler stops exactly when it opens", async () => {
    const f = fakes();
    const id = await deleting();
    // An admin-run purge that failed on this install counts too.
    await job(id, {
      kind: "purge",
      workflow: "manage_install",
      status: "failed",
      error_code: "revoke_pending",
      finished_at: NOW - DAY,
      updated_at: NOW - DAY,
    });
    for (let t = NOW; t < NOW + 10; t++) {
      const before = (await purges(id)).length;
      const stuck = (await sqlConditions(db, { now: t, signupDailyCap: 0 }))
        .purge_stuck.open;
      await purgeDue(f.env, t);
      const all = await purges(id);
      // Queued a try iff purge_stuck is not open.
      expect(all.length > before).toBe(!stuck);
      if (all.length > before) await fail(all.at(-1)?.id);
    }
    expect(await purges(id)).toHaveLength(PURGE_STUCK_FAILURES);
  });

  it("a later grace end (restore, delete again) after a stuck purge: no new try, and purge_stuck stays open", async () => {
    const f = fakes();
    const id = await deleting();
    for (let n = 0; n < PURGE_MAX_TRIES; n++) {
      await purgeDue(f.env, NOW);
      await fail((await purges(id)).at(-1)?.id);
    }
    const later = NOW + 8 * DAY;
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = ?2, purge_at = ?3 WHERE install_id = ?1",
      )
      .bind(id, later - 7 * DAY, later)
      .run();
    for (let t = later; t < later + 3; t++) {
      await purgeDue(f.env, t);
      expect(await purges(id)).toHaveLength(PURGE_STUCK_FAILURES);
      const c = await sqlConditions(db, { now: t, signupDailyCap: 0 });
      expect(c.purge_stuck.open).toBe(true);
    }
  });

  it("a later grace end with one earlier failure: its tries are numbered from 0", async () => {
    const f = fakes();
    const id = await deleting();
    await purgeDue(f.env, NOW);
    await fail((await purges(id)).at(-1)?.id);
    const later = NOW + 8 * DAY;
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = ?2, purge_at = ?3 WHERE install_id = ?1",
      )
      .bind(id, later - 7 * DAY, later)
      .run();
    await purgeDue(f.env, later);
    expect((await purges(id)).at(-1)?.request_id).toBe(
      purgeRequestId(id, later, 0),
    );
  });

  for (const [what, sql] of [
    [
      "suspended",
      "UPDATE install_lifecycle SET suspended_at = ?2 WHERE install_id = ?1",
    ],
    [
      "restored",
      "UPDATE install_lifecycle SET deleted_at = NULL, purge_at = NULL WHERE install_id = ?1 AND ?2 > 0",
    ],
  ] as const)
    it(`${what} after the due read: no purge job is queued`, async () => {
      const f = fakes();
      const id = await deleting();
      // The install changes between the due read and the insert (an admin
      // job that ran and finished in between).
      const racy = new Proxy(db, {
        get(t, k) {
          if (k === "prepare")
            return (q: string) => {
              const s = t.prepare(q);
              if (!q.startsWith("SELECT install_id")) return s;
              return {
                bind: (...a: unknown[]) => {
                  const b = s.bind(...a);
                  return {
                    all: async () => {
                      const r = await b.all();
                      await t.prepare(sql).bind(id, NOW).run();
                      return r;
                    },
                  };
                },
              };
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      await purgeDue({ ...f.env, PLATFORM_DB: racy } as ProvapiEnv, NOW);
      expect(await purges(id)).toEqual([]);
      expect(f.manage.created).toEqual([]);
    });

  it(`${PURGE_LIMIT} stuck installs never crowd out one that comes due later`, async () => {
    const f = fakes();
    for (let i = 0; i < PURGE_LIMIT; i++) {
      const stuck = await deleting(PURGE_AT - DAY - i);
      for (let n = 0; n < PURGE_STUCK_FAILURES; n++)
        await job(stuck, {
          kind: "purge",
          workflow: "manage_install",
          status: "failed",
          error_code: "revoke_pending",
          finished_at: NOW - DAY,
          updated_at: NOW - DAY,
        });
    }
    const due = await deleting(PURGE_AT);
    await purgeDue(f.env, NOW);
    expect(await purges(due)).toHaveLength(1);
    expect(f.manage.created).toHaveLength(1);
  });

  it("overlapping ticks make one job", async () => {
    const f = fakes();
    const id = await deleting();
    await Promise.all(Array.from({ length: 4 }, () => purgeDue(f.env, NOW)));
    expect(await purges(id)).toHaveLength(1);
    expect(f.manage.created).toHaveLength(1);
  });

  it("a failed start leaves the job queued (the sweep starts it)", async () => {
    const f = fakes();
    const id = await deleting();
    f.manage.failNextCreate(new Error("boom"));
    const lines = captureLogs(vi.spyOn);
    await purgeDue(f.env, NOW);
    expect((await purges(id))[0]?.status).toBe("queued");
    expect(lines.at(-1)).toBe(`provapi purge install_failed rpc_error ${id}`);
  });

  it("the binding's already-exists error counts as started; a create error that only says 'already exists' is an rpc_error", async () => {
    const f = fakes();
    const a = await deleting();
    f.manage.failNextCreate(
      new Error(
        '(instance.already_exists) Workflow instance with id "x" already exists',
      ),
    );
    const lines = captureLogs(vi.spyOn);
    await purgeDue(f.env, NOW);
    expect(lines.filter((l) => l.includes("install_failed"))).toEqual([]);
    const b = await deleting();
    f.manage.failNextCreate(new Error("instance x already exists"));
    await purgeDue(f.env, NOW);
    expect(lines.at(-1)).toBe(`provapi purge install_failed rpc_error ${b}`);
    expect((await purges(a))[0]?.status).toBe("queued");
  });

  it("a deleted install is never purged again", async () => {
    const f = fakes();
    const id = await deleting();
    await db
      .prepare("UPDATE installs SET state = 'deleted' WHERE id = ?1")
      .bind(id)
      .run();
    await purgeDue(f.env, NOW);
    expect(await purges(id)).toEqual([]);
  });
});
