import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createProvisioningHandlers } from "../../src/mocks/provisioning.js";
import {
  AcceptedSchema,
  InstallDetailSchema,
  JobSchema,
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
});
