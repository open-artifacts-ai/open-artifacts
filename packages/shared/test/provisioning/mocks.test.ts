import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createProvisioningHandlers,
  createProvisioningMock,
} from "../../src/mocks/provisioning.js";
import {
  AcceptedSchema,
  InstallDetailSchema,
  JobSchema,
  LIVE_TOKENS_PER_ADMIN,
  MeSchema,
  ProvisioningErrorSchema,
  WorldSchema,
} from "../../src/provisioning/index.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ADMIN = "https://admin.open-artifacts.app/api/v1";
const API = "https://api.open-artifacts.app/v1";
const RID = "req_0123456789abcdef";

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("provisioning MSW mocks", () => {
  it("R27 world on both base paths", async () => {
    server.use(...createProvisioningHandlers());
    for (const base of [ADMIN, API]) {
      const r = await fetch(`${base}/world`);
      expect(r.status, base).toBe(200);
      const w = WorldSchema.parse(await r.json());
      expect(w.installs.total).toBe(w.installs.items.length);
      expect(w.attention.length).toBeGreaterThan(0);
    }
  });

  it("world options: env and an empty world", async () => {
    server.use(
      ...createProvisioningHandlers({ env: "staging", world: "empty" }),
    );
    const w = WorldSchema.parse(await (await fetch(`${API}/world`)).json());
    expect(w.env).toBe("staging");
    expect(w.installs.total).toBe(0);
    expect(w.attention).toEqual([]);
  });

  it("reads: me, install, job; unknown ids 404 in the envelope", async () => {
    server.use(...createProvisioningHandlers());
    MeSchema.parse(await (await fetch(`${ADMIN}/me`)).json());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string }[];
    };
    const id = list.items[0].id;
    InstallDetailSchema.parse(
      await (await fetch(`${ADMIN}/installs/${id}`)).json(),
    );
    const jobs = (await (
      await fetch(`${ADMIN}/installs/${id}/jobs`)
    ).json()) as { items: { id: string }[] };
    JobSchema.parse(
      await (await fetch(`${ADMIN}/jobs/${jobs.items[0].id}`)).json(),
    );
    const nf = await fetch(`${ADMIN}/installs/izzzzzzzzzzz`);
    expect(nf.status).toBe(404);
    expect(ProvisioningErrorSchema.parse(await nf.json()).error.code).toBe(
      "not_found",
    );
  });

  it("writes: 202 with a queued job, replay with the same requestId, 400 on a bad body", async () => {
    server.use(...createProvisioningHandlers());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string; state: string }[];
    };
    const active = list.items.find((i) => i.state === "active");
    if (!active) throw new Error("fixture has no active install");
    const body = { requestId: RID, reason: "billing" };
    const r = await post(`${ADMIN}/installs/${active.id}/suspend`, body);
    expect(r.status).toBe(202);
    const a = AcceptedSchema.parse(await r.json());
    expect(a.job.kind).toBe("suspend");
    expect(a.job.status).toBe("queued");
    const again = await post(`${ADMIN}/installs/${active.id}/suspend`, body);
    expect(again.headers.get("oa-idempotent-replay")).toBe("1");
    expect(AcceptedSchema.parse(await again.json()).job.id).toBe(a.job.id);
    const bad = await post(`${ADMIN}/installs/${active.id}/suspend`, {
      requestId: RID,
    });
    expect(bad.status).toBe(400);
    expect(ProvisioningErrorSchema.parse(await bad.json()).error.code).toBe(
      "invalid_input",
    );
  });

  it("a write in a state the table does not allow is 409 invalid_state", async () => {
    server.use(...createProvisioningHandlers());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string; state: string }[];
    };
    const active = list.items.find((i) => i.state === "active");
    const r = await post(`${ADMIN}/installs/${active?.id}/resume`, {
      requestId: RID,
    });
    expect(r.status).toBe(409);
    expect(ProvisioningErrorSchema.parse(await r.json()).error.code).toBe(
      "invalid_state",
    );
  });

  it("idempotency: another body, route or install with the same requestId is 409", async () => {
    server.use(...createProvisioningHandlers());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string; state: string }[];
    };
    const [a, b] = list.items.filter((i) => i.state === "active");
    if (!a || !b) throw new Error("fixture needs two active installs");
    const code = async (r: Response) =>
      ProvisioningErrorSchema.parse(await r.json()).error.code;
    const rid = "req_idem_0123456789";
    expect(
      (
        await post(`${ADMIN}/installs/${a.id}/suspend`, {
          requestId: rid,
          reason: "x",
        })
      ).status,
    ).toBe(202);
    for (const r of [
      await post(`${ADMIN}/installs/${a.id}/suspend`, {
        requestId: rid,
        reason: "y",
      }),
      await post(`${ADMIN}/installs/${b.id}/suspend`, {
        requestId: rid,
        reason: "x",
      }),
      await post(`${ADMIN}/installs/${a.id}/upgrade`, { requestId: rid }),
    ]) {
      expect(r.status).toBe(409);
      expect(await code(r)).toBe("idempotency_conflict");
    }
  });

  it("R4: admin field rules (3.3) and slug codes", async () => {
    server.use(...createProvisioningHandlers());
    const base = {
      slug: "newco",
      ownerEmail: "owner@newco.com",
      tier: "team",
      auth: { providers: ["google"], domains: ["newco.com"] },
    };
    const send = async (body: Record<string, unknown>, rid: string) => {
      const r = await post(`${ADMIN}/installs`, { requestId: rid, ...body });
      return { status: r.status, body: (await r.json()) as unknown };
    };
    const code = (b: unknown) => ProvisioningErrorSchema.parse(b).error.code;
    const { ownerEmail: _o, ...noOwner } = base;
    const missing = await send(noOwner, "req_r4_missing_000001");
    expect([missing.status, code(missing.body)]).toEqual([
      400,
      "invalid_input",
    ]);
    // Prod (the mock's default env) refuses testHooks for an admin.
    const hooks = await send(
      { ...base, testHooks: true },
      "req_r4_hooks_00000001",
    );
    expect([hooks.status, code(hooks.body)]).toEqual([403, "forbidden"]);
    const bad = await send(
      { ...base, slug: "Bad_Slug" },
      "req_r4_badslug_000001",
    );
    expect([bad.status, code(bad.body)]).toEqual([400, "slug_invalid"]);
    const res = await send(
      { ...base, slug: "billing" },
      "req_r4_reserved_00001",
    );
    expect([res.status, code(res.body)]).toEqual([400, "slug_reserved"]);
    const ok = await send(base, "req_r4_ok_00000000001");
    expect(ok.status).toBe(202);
  });

  it("confirm_mismatch, not invalid_input, for any wrong confirmSlug", async () => {
    server.use(...createProvisioningHandlers());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string; state: string }[];
    };
    const active = list.items.find((i) => i.state === "active");
    const r = await post(`${ADMIN}/installs/${active?.id}/delete`, {
      requestId: RID,
      confirmSlug: "Leo",
    });
    expect(r.status).toBe(400);
    expect(ProvisioningErrorSchema.parse(await r.json()).error.code).toBe(
      "confirm_mismatch",
    );
  });

  it("admin /me carries no token fields", async () => {
    server.use(...createProvisioningHandlers());
    const me = MeSchema.parse(await (await fetch(`${ADMIN}/me`)).json());
    expect(me.principal).toBe("admin");
    expect([me.tokenId, me.tokenKind, me.tokenExpiresAt]).toEqual([
      null,
      null,
      null,
    ]);
  });

  const install = async (id: string) =>
    InstallDetailSchema.parse(
      await (await fetch(`${ADMIN}/installs/${id}`)).json(),
    );
  const job = async (id: string) =>
    JobSchema.parse(await (await fetch(`${ADMIN}/jobs/${id}`)).json());
  const create = async (slug: string, rid: string) =>
    AcceptedSchema.parse(
      await (
        await post(`${ADMIN}/installs`, {
          requestId: rid,
          slug,
          ownerEmail: "owner@newco.com",
          tier: "team",
          auth: { providers: ["google"], domains: ["newco.com"] },
        })
      ).json(),
    );

  it("advanceJob: queued, running, done frees the install in its TRANSITIONS state", async () => {
    const m = createProvisioningMock();
    server.use(...m.handlers);
    const a = await create("newco", "req_adv_create_000001");
    expect((await install(a.install.id)).activeJobId).toBe(a.job.id);
    const busy = await post(`${ADMIN}/installs/${a.install.id}/upgrade`, {
      requestId: "req_adv_busy_00000001",
    });
    expect(ProvisioningErrorSchema.parse(await busy.json()).error.code).toBe(
      "job_in_progress",
    );
    m.advanceJob(a.job.id, "running");
    expect((await job(a.job.id)).status).toBe("running");
    m.advanceJob(a.job.id, "done");
    const j = await job(a.job.id);
    expect([j.status, j.step, j.finishedAt !== null]).toEqual([
      "done",
      "done",
      true,
    ]);
    const d = await install(a.install.id);
    expect([d.state, d.activeJobId]).toEqual(["active", null]);
    const s = AcceptedSchema.parse(
      await (
        await post(`${ADMIN}/installs/${a.install.id}/suspend`, {
          requestId: "req_adv_suspend_00001",
          reason: "billing",
        })
      ).json(),
    );
    expect(m.finishAllJobs()).toBe(1);
    expect((await install(a.install.id)).state).toBe("suspended");
    expect(() => m.advanceJob(s.job.id, "done")).toThrow();
  });

  it("advanceJob failed: a create settles failed with the code; the install is free", async () => {
    const m = createProvisioningMock();
    server.use(...m.handlers);
    const a = await create("newco", "req_fail_create_00001");
    m.advanceJob(a.job.id, "failed", "prod_dirty");
    const j = await job(a.job.id);
    expect([j.status, j.lastErrorCode]).toEqual(["failed", "prod_dirty"]);
    const d = await install(a.install.id);
    expect([d.state, d.activeJobId]).toEqual(["failed", null]);
    const retry = await post(`${ADMIN}/installs/${a.install.id}/retry`, {
      requestId: "req_fail_retry_000001",
    });
    expect(retry.status).toBe(202);
  });

  it("R25: only the active job; cleanup becomes active, then frees the install", async () => {
    const m = createProvisioningMock();
    server.use(...m.handlers);
    const a = await create("newco", "req_cancel_create_001");
    const cancel = (jobId: string, rid: string) =>
      post(`${ADMIN}/jobs/${jobId}/cancel`, {
        requestId: rid,
        confirmSlug: "newco",
      });
    const r = await cancel(a.job.id, "req_cancel_ok_0000001");
    expect(r.status).toBe(202);
    const c = AcceptedSchema.parse(await r.json());
    expect([c.job.kind, c.job.status]).toEqual(["cleanup", "queued"]);
    const canceled = await job(a.job.id);
    expect([canceled.status, canceled.lastErrorCode]).toEqual([
      "failed",
      "canceled",
    ]);
    expect((await install(a.install.id)).activeJobId).toBe(c.job.id);
    // The canceled job is no longer active: invalid_state.
    const again = await cancel(a.job.id, "req_cancel_again_00001");
    expect(again.status).toBe(409);
    expect(ProvisioningErrorSchema.parse(await again.json()).error.code).toBe(
      "invalid_state",
    );
    m.advanceJob(c.job.id, "done");
    const d = await install(a.install.id);
    expect([d.state, d.activeJobId]).toEqual(["failed", null]);
  });

  it("R25: a job that is not the install's active one is 409 invalid_state", async () => {
    server.use(...createProvisioningHandlers());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string; slug: string; state: string }[];
    };
    const failed = list.items.find((i) => i.state === "failed");
    if (!failed) throw new Error("fixture has no failed install");
    const jobs = (await (
      await fetch(`${ADMIN}/installs/${failed.id}/jobs`)
    ).json()) as { items: { id: string }[] };
    const r = await post(`${ADMIN}/jobs/${jobs.items[0].id}/cancel`, {
      requestId: "req_cancel_done_000001",
      confirmSlug: failed.slug,
    });
    expect(r.status).toBe(409);
    expect(ProvisioningErrorSchema.parse(await r.json()).error.code).toBe(
      "invalid_state",
    );
  });

  it("an idempotent replay returns the job as it is now", async () => {
    const m = createProvisioningMock();
    server.use(...m.handlers);
    const body = {
      requestId: "req_replay_now_000001",
      slug: "newco",
      ownerEmail: "owner@newco.com",
      tier: "team",
      auth: { providers: ["google"], domains: ["newco.com"] },
    };
    const a = AcceptedSchema.parse(
      await (await post(`${ADMIN}/installs`, body)).json(),
    );
    m.advanceJob(a.job.id, "done");
    const r = await post(`${ADMIN}/installs`, body);
    expect(r.headers.get("oa-idempotent-replay")).toBe("1");
    const b = AcceptedSchema.parse(await r.json());
    expect(b.job.id).toBe(a.job.id);
    expect([b.job.status, b.install.state]).toEqual(["done", "active"]);
  });

  it("R14 jobs never carry sealed; DELETE /tokens revokes all", async () => {
    server.use(...createProvisioningHandlers());
    const list = (await (await fetch(`${ADMIN}/installs`)).json()) as {
      items: { id: string }[];
    };
    const jobs = (await (
      await fetch(`${ADMIN}/installs/${list.items[0].id}/jobs`)
    ).json()) as { items: Record<string, unknown>[] };
    for (const j of jobs.items) expect(j).not.toHaveProperty("sealed");
    for (const label of ["one", "two"])
      await post(`${ADMIN}/tokens`, {
        requestId: `req_tok_${label}_0000000`,
        label,
        scopes: ["installs:read"],
      });
    expect((await fetch(`${ADMIN}/tokens`, { method: "DELETE" })).status).toBe(
      204,
    );
    const t = (await (await fetch(`${ADMIN}/tokens`)).json()) as {
      items: { revokedAt: number | null }[];
    };
    expect(t.items).toHaveLength(2);
    for (const x of t.items) expect(x.revokedAt).not.toBeNull();
  });

  it("mint stamps createdAt and expiresAt from opts.now", async () => {
    let t = 1_800_000_000_000;
    server.use(...createProvisioningMock({ now: () => t }).handlers);
    const r = await post(`${ADMIN}/tokens`, {
      requestId: "req_tok_clock_00000000",
      label: "clock",
      scopes: ["installs:read"],
      ttlMinutes: 30,
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as { createdAt: number; expiresAt: number };
    expect(m.createdAt).toBe(1_800_000_000_000);
    expect(m.expiresAt).toBe(1_800_000_000_000 + 30 * 60_000);
    t += 5_000;
    const j = (await (
      await post(`${ADMIN}/installs`, {
        requestId: "req_clock_install_0000",
        slug: "clocked",
        ownerEmail: "o@acme.test",
        tier: "team",
        auth: { providers: ["google"], domains: ["acme.test"] },
      })
    ).json()) as { job: { createdAt: number } };
    expect(j.job.createdAt).toBe(1_800_000_005_000);
  });

  it(`token_limit after ${LIVE_TOKENS_PER_ADMIN} live tokens of both kinds; revoked and expired ones do not count`, async () => {
    let t = 1_800_000_000_000;
    const oauth = {
      id: "01JMCKZZZZZZZZZZZZZZZZZZZZ",
      kind: "oauth" as const,
      label: "Claude Code",
      clientName: "Claude Code",
      scopes: ["installs:read" as const],
      createdAt: t,
      expiresAt: t + 8 * 3_600_000,
      revokedAt: null,
      lastUsedAt: null,
    };
    server.use(
      ...createProvisioningMock({ now: () => t, tokens: [oauth] }).handlers,
    );
    const mint = (n: number, ttlMinutes = 15) =>
      post(`${ADMIN}/tokens`, {
        requestId: `req_tok_limit_${String(n).padStart(8, "0")}`,
        label: `t${n}`,
        scopes: ["installs:read"],
        ttlMinutes,
      });
    const code = async (r: Response) =>
      ProvisioningErrorSchema.parse(await r.json()).error.code;
    // The oauth grant counts: 4 oat_ mints reach 5 live.
    const ids: string[] = [];
    for (let n = 0; n < LIVE_TOKENS_PER_ADMIN - 1; n++) {
      const r = await mint(n);
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { id: string }).id);
    }
    const refused = await mint(90);
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("token_limit");
    // A revoked token frees one slot.
    expect(
      (await fetch(`${ADMIN}/tokens/${ids[0]}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await mint(91)).status).toBe(201);
    const again = await mint(92);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("token_limit");
    // Past the oat_ tokens' 15-minute expiry only the oauth grant is live.
    t += 15 * 60_000;
    for (let n = 100; n < 100 + LIVE_TOKENS_PER_ADMIN - 1; n++)
      expect((await mint(n)).status).toBe(201);
    expect(await code(await mint(200))).toBe("token_limit");
  });
});
