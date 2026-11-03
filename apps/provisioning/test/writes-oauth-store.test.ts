import { JOB_STEPS } from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "./call.js";
import {
  ADMIN_P,
  fakeEnv,
  insert,
  OIDC_P,
  requestId,
  resetDb,
  seedInstall,
  seedJob,
  tokenP,
  userP,
} from "./fakes.js";

// R29 and R30 (#1008): what the API refuses from D1 alone. The job re-reads
// /healthz; apps/provisioner/test/node/oauth-store.test.ts covers that.

const NOW = Date.UTC(2026, 10, 3, 12);
const WRITE = tokenP(["installs:read", "installs:write", "installs:delete"]);
const VARS = {
  AUTH_PROVIDERS: "google",
  AUTH_DOMAINS: "acme.test",
  TIER: "team",
};

beforeEach(async () => {
  await resetDb();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

const params = (id: string) => ({ id });
const setBody = (mode: string) => ({
  requestId: requestId(),
  vars: { OAUTH_STORE: mode },
});
const onMode = (mode?: string) =>
  seedInstall({ vars: mode ? { ...VARS, OAUTH_STORE: mode } : VARS });
const liveRow = (installId: string, mode: string, at: number) =>
  insert("hosted_audit", {
    at,
    actor: "job:x",
    install_id: installId,
    action: "oauth_store.mode_live",
    detail: JSON.stringify({ mode }),
  });

describe("R29 set the OAuth store", () => {
  it("an admin's request is an update job with the mode alone", async () => {
    const e = fakeEnv();
    const { id } = await onMode();
    const r = await call(e, ADMIN_P, "R29", {
      params: params(id),
      body: setBody("dual"),
    });
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({
      kind: "update",
      status: "queued",
      steps: [...JOB_STEPS.update],
      args: { vars: { OAUTH_STORE: "dual" } },
    });
    expect(e.manageInstall.created).toHaveLength(1);
  });

  it("the same request id replays; another body is a conflict", async () => {
    const e = fakeEnv();
    const { id } = await onMode();
    const body = setBody("dual");
    const a = await call(e, ADMIN_P, "R29", { params: params(id), body });
    const b = await call(e, ADMIN_P, "R29", { params: params(id), body });
    expect(b.headers["oa-idempotent-replay"]).toBe("1");
    expect(b.body.job.id).toBe(a.body.job.id);
    const c = await call(e, ADMIN_P, "R29", {
      params: params(id),
      body: { ...body, vars: { OAUTH_STORE: "kv" } },
    });
    expect(c.code).toBe("idempotency_conflict");
  });

  it("no token, OIDC or user reaches it", async () => {
    const e = fakeEnv();
    const { id } = await onMode();
    for (const p of [WRITE, OIDC_P, userP()]) {
      const r = await call(e, p, "R29", {
        params: params(id),
        body: setBody("dual"),
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(e.manageInstall.created).toHaveLength(0);
  });

  it("takes OAUTH_STORE and nothing else", async () => {
    const e = fakeEnv();
    const { id } = await onMode();
    const r = await call(e, ADMIN_P, "R29", {
      params: params(id),
      body: {
        requestId: requestId(),
        vars: { OAUTH_STORE: "dual", TIER: "team" },
      },
    });
    expect(r.code).toBe("invalid_input");
  });

  it("leaving d1 is refused, a rerun of d1 is not", async () => {
    const e = fakeEnv();
    const { id } = await onMode("d1");
    for (const m of ["kv", "dual"]) {
      const r = await call(e, ADMIN_P, "R29", {
        params: params(id),
        body: setBody(m),
      });
      expect(r.code, m).toBe("invalid_state");
    }
    const r = await call(e, ADMIN_P, "R29", {
      params: params(id),
      body: setBody("d1"),
    });
    expect(r.status).toBe(202);
  });

  it("a suspended install is refused", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({
      vars: VARS,
      lifecycle: { suspended_at: 5 },
    });
    const r = await call(e, ADMIN_P, "R29", {
      params: params(id),
      body: setBody("dual"),
    });
    expect(r.code).toBe("invalid_state");
  });
});

describe("R30 copy the OAuth store", () => {
  const body = () => ({ requestId: requestId() });

  it("needs dual live for at least 60 s, by R29's record", async () => {
    const e = fakeEnv();
    const { id } = await onMode("dual");
    const refuse = () =>
      call(e, ADMIN_P, "R30", { params: params(id), body: body() });
    expect((await refuse()).code).toBe("invalid_state");
    await liveRow(id, "dual", NOW - 59_999);
    expect((await refuse()).code).toBe("invalid_state");
    await liveRow(id, "dual", NOW - 60_000);
    const r = await refuse();
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({
      kind: "update",
      steps: [...JOB_STEPS.oauth_copy],
      args: { oauthCopy: true },
    });
  });

  it("reads the last record, not an older dual", async () => {
    const e = fakeEnv();
    const { id } = await onMode("dual");
    await liveRow(id, "dual", NOW - 600_000);
    await liveRow(id, "kv", NOW - 500_000);
    const r = await call(e, ADMIN_P, "R30", {
      params: params(id),
      body: body(),
    });
    expect(r.code).toBe("invalid_state");
  });

  it("needs the stored mode dual, whatever the record says", async () => {
    const e = fakeEnv();
    const { id } = await onMode("kv");
    await liveRow(id, "dual", NOW - 600_000);
    const r = await call(e, ADMIN_P, "R30", {
      params: params(id),
      body: body(),
    });
    expect(r.code).toBe("invalid_state");
  });

  it("refuses a second open job on the install", async () => {
    const e = fakeEnv();
    const { id } = await onMode("dual");
    await liveRow(id, "dual", NOW - 600_000);
    const first = await call(e, ADMIN_P, "R30", {
      params: params(id),
      body: body(),
    });
    expect(first.status).toBe(202);
    const r = await call(e, ADMIN_P, "R30", {
      params: params(id),
      body: body(),
    });
    expect(r.code).toBe("job_in_progress");
    expect(e.manageInstall.created).toHaveLength(1);
  });

  it("no token, OIDC or user reaches it", async () => {
    const e = fakeEnv();
    const { id } = await onMode("dual");
    await liveRow(id, "dual", NOW - 600_000);
    for (const p of [WRITE, OIDC_P, userP()]) {
      const r = await call(e, p, "R30", { params: params(id), body: body() });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(e.manageInstall.created).toHaveLength(0);
  });

  it("reads an update job's steps from its args", async () => {
    const e = fakeEnv();
    const { id } = await onMode();
    const jobId = await seedJob(id, {
      kind: "update",
      workflow: "manage_install",
      args: '{"oauthCopy":true}',
      status: "failed",
    });
    const r = await call(e, ADMIN_P, "R15", { params: { jobId } });
    expect(r.body.steps).toEqual([...JOB_STEPS.oauth_copy]);
  });
});
