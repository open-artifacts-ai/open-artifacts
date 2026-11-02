import { describe, expect, it } from "vitest";
import {
  FakeWorkflow,
  fakeProvisionerRpc,
} from "../../src/provisioning/fakes.js";
import {
  InventoryHealthSchema,
  InventoryHostSchema,
  InventoryHostsSchema,
  InventoryInstallsSchema,
  PROVISIONER_RPC_METHODS,
  ProdcleanReportSchema,
  ReleaseSchema,
  TokenStatusSchema,
} from "../../src/provisioning/index.js";

const JOB = "01JD7Z9W5Q8X3N4M2K1H0G9F8E";

describe("ProvisionerRpc fake", () => {
  it("has exactly the three RPC methods", async () => {
    expect(PROVISIONER_RPC_METHODS).toEqual([
      "releases",
      "verifyTurnstile",
      "tokenStatus",
    ]);
    const rpc = fakeProvisionerRpc();
    for (const m of PROVISIONER_RPC_METHODS)
      expect(typeof rpc[m]).toBe("function");
  });

  it("returns schema-valid defaults and records calls", async () => {
    const rpc = fakeProvisionerRpc();
    for (const r of await rpc.releases()) ReleaseSchema.parse(r);
    const s = TokenStatusSchema.parse(await rpc.tokenStatus());
    expect(s.status).toBe("active");
    expect(
      await rpc.verifyTurnstile({
        token: "t",
        remoteIp: "192.0.2.1",
        action: "signup",
        hostname: "signup.example",
        testUser: false,
      }),
    ).toEqual({ ok: true });
    expect(rpc.calls.map((c) => c.method)).toEqual([
      "releases",
      "tokenStatus",
      "verifyTurnstile",
    ]);
  });

  it("is configurable", async () => {
    const rpc = fakeProvisionerRpc({
      releases: [],
      tokenStatus: { status: "invalid", expiresAt: null, daysLeft: null },
      turnstile: () => false,
    });
    expect(await rpc.releases()).toEqual([]);
    expect((await rpc.tokenStatus()).status).toBe("invalid");
    expect(
      (
        await rpc.verifyTurnstile({
          token: "",
          remoteIp: "",
          action: "signup",
          hostname: "",
          testUser: false,
        })
      ).ok,
    ).toBe(false);
  });

  it("token status: daysLeft null only when invalid; expiring at 30 days or less", () => {
    expect(
      TokenStatusSchema.safeParse({
        status: "active",
        expiresAt: 1,
        daysLeft: null,
      }).success,
    ).toBe(false);
    expect(
      TokenStatusSchema.safeParse({
        status: "invalid",
        expiresAt: null,
        daysLeft: null,
      }).success,
    ).toBe(true);
    expect(
      TokenStatusSchema.safeParse({
        status: "expiring",
        expiresAt: 1,
        daysLeft: 31,
      }).success,
    ).toBe(false);
    expect(
      TokenStatusSchema.safeParse({
        status: "active",
        expiresAt: 1,
        daysLeft: 30,
      }).success,
    ).toBe(false);
    expect(
      TokenStatusSchema.safeParse({
        status: "expiring",
        expiresAt: 1,
        daysLeft: 30,
      }).success,
    ).toBe(true);
  });
});

describe("Workflow binding fake", () => {
  it("create, get, status, terminate", async () => {
    const wf = new FakeWorkflow();
    const inst = await wf.create({ id: JOB, params: { jobId: JOB } });
    expect(inst.id).toBe(JOB);
    expect((await (await wf.get(JOB)).status()).status).toBe("queued");
    wf.setStatus(JOB, "running");
    expect((await inst.status()).status).toBe("running");
    await inst.terminate();
    expect((await inst.status()).status).toBe("terminated");
    expect(wf.created).toEqual([{ id: JOB, params: { jobId: JOB } }]);
  });

  it("refuses params other than { jobId }, duplicate ids and unknown ids", async () => {
    const wf = new FakeWorkflow();
    await expect(
      wf.create({ id: JOB, params: { jobId: JOB, slug: "x" } as never }),
    ).rejects.toThrow();
    await wf.create({ id: JOB, params: { jobId: JOB } });
    await expect(
      wf.create({ id: JOB, params: { jobId: JOB } }),
    ).rejects.toThrow(/exists/);
    await expect(wf.get("01JD7Z9W5Q8X3N4M2K1H0G9F8F")).rejects.toThrow(
      /not found/,
    );
  });

  it("failNextCreate makes the next create throw once (the job stays queued)", async () => {
    const wf = new FakeWorkflow();
    wf.failNextCreate(new Error("binding down"));
    await expect(
      wf.create({ id: JOB, params: { jobId: JOB } }),
    ).rejects.toThrow("binding down");
    await expect(
      wf.create({ id: JOB, params: { jobId: JOB } }),
    ).resolves.toBeTruthy();
  });
});

describe("inventory schemas", () => {
  it("installs add state and mode", () => {
    const row = {
      id: "iabcdefgh234",
      appHost: "leo.open-artifacts.app",
      contentHost: "leo.oa-content.app",
      state: "suspended",
      testHooks: false,
      mode: "paused",
    };
    expect(InventoryInstallsSchema.parse({ installs: [row] })).toEqual({
      installs: [row],
    });
    expect(
      InventoryInstallsSchema.safeParse({
        installs: [{ ...row, mode: "nope" }],
      }).success,
    ).toBe(false);
    expect(
      InventoryInstallsSchema.safeParse({ installs: [{ ...row, mode: null }] })
        .success,
    ).toBe(true);
  });

  it("a creating install with no hosts row parses; every other field is still checked", () => {
    const row = {
      id: "iabcdefgh234",
      appHost: null,
      contentHost: null,
      state: "provisioning",
      testHooks: false,
      mode: null,
    };
    expect(InventoryInstallsSchema.parse({ installs: [row] })).toEqual({
      installs: [row],
    });
    const bad = (o: Record<string, unknown>) =>
      InventoryInstallsSchema.safeParse({ installs: [{ ...row, ...o }] })
        .success;
    for (const o of [
      { id: "nope" },
      { id: undefined },
      { state: "creating" },
      { state: undefined },
      { testHooks: null },
      { testHooks: "false" },
      { mode: "nope" },
      // No host: nothing can route to it.
      { mode: "serving" },
      // Both hosts come from one hosts row: both or neither.
      { appHost: "leo.open-artifacts.app" },
      { contentHost: "leo.oa-content.app" },
      { appHost: undefined },
      { appHost: 7 },
    ])
      expect(bad(o), JSON.stringify(o)).toBe(false);
  });

  it("hosts keep installId and add mode", () => {
    const h = {
      host: "leo.open-artifacts.app",
      installId: "iabcdefgh234",
      mode: "closed",
    };
    expect(InventoryHostSchema.parse(h)).toEqual(h);
    expect(
      InventoryHostsSchema.parse({ hosts: [h], complete: true }).hosts,
    ).toHaveLength(1);
    expect(
      InventoryHostSchema.safeParse({ ...h, installId: null, mode: null })
        .success,
    ).toBe(true);
  });

  it("health and prodclean report", () => {
    expect(InventoryHealthSchema.parse({ schedulerTickAt: null })).toEqual({
      schedulerTickAt: null,
    });
    expect(
      ProdcleanReportSchema.safeParse({ ok: true, code: "pass" }).success,
    ).toBe(true);
    expect(
      ProdcleanReportSchema.safeParse({
        ok: false,
        code: "prod_dirty",
        installId: "iabcdefgh234",
        detail: "x".repeat(200),
      }).success,
    ).toBe(true);
    expect(
      ProdcleanReportSchema.safeParse({
        ok: false,
        code: "prod_dirty",
        detail: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      ProdcleanReportSchema.safeParse({
        ok: false,
        code: "prod_dirty",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
