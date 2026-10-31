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
});
