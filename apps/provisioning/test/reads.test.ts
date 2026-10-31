import {
  AuditEntrySchema,
  InstallDetailSchema,
  InstallSummarySchema,
  JobListItemSchema,
  JobSchema,
  MeSchema,
} from "@oa/shared/provisioning";
import { FAKE_RELEASES } from "@oa/shared/provisioning/fakes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "./call.js";
import {
  ADMIN_P,
  db,
  fakeEnv,
  insert,
  OIDC_P,
  requestId,
  resetDb,
  seedFailedCreate,
  seedInstall,
  seedJob,
  tokenP,
  userP,
} from "./fakes.js";

// The read routes: R1, R2, R3, R14, R15, R16, R17, R18.

const NOW = Date.UTC(2026, 9, 31, 12);
const READ = tokenP(["installs:read"]);
const PII = tokenP(["installs:read", "installs:pii", "audit:read"]);

let now = NOW;
beforeEach(async () => {
  await resetDb();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("R1 /me", () => {
  it("an admin: role admin, env, the provisioning token banner", async () => {
    const e = fakeEnv();
    const r = await call(e, ADMIN_P, "R1");
    expect(MeSchema.parse(r.body)).toMatchObject({
      principal: "admin",
      email: "me@example.com",
      role: "admin",
      env: "staging",
      authAt: 0,
      provisioningToken: "active",
      tokenId: null,
    });
  });

  it("a token: its scopes and id, no banner", async () => {
    const e = fakeEnv();
    const r = await call(e, READ, "R1");
    expect(MeSchema.parse(r.body)).toMatchObject({
      principal: "token",
      scopes: ["installs:read"],
      tokenId: READ.tokenId,
      provisioningToken: null,
    });
  });

  it("session and token facts by the W5a/W5b Principal names", async () => {
    const admin = {
      ...ADMIN_P,
      session: { hash: "h", csrf: "c1", expiresAt: NOW + 1000, authAt: 0 },
    };
    expect((await call(fakeEnv(), admin, "R1")).body).toMatchObject({
      csrf: "c1",
      sessionExpiresAt: NOW + 1000,
    });
    const oauth = { ...READ, tokenKind: "oauth" as const };
    expect((await call(fakeEnv(), oauth, "R1")).body.tokenKind).toBe("oauth");
  });

  it("an oauth token's tokenExpiresAt is its row's expires_at (the grant chain's end)", async () => {
    const oauth = { ...READ, tokenKind: "oauth" as const };
    await insert("agent_tokens", {
      id: READ.tokenId,
      kind: "oauth",
      session_hash: "h",
      admin_email: "me@example.com",
      label: "claude",
      scopes: "installs:read",
      client_id: "c1",
      oauth_user: "adm_1",
      created_at: NOW,
      expires_at: NOW + 3600_000,
    });
    expect((await call(fakeEnv(), oauth, "R1")).body).toMatchObject({
      tokenKind: "oauth",
      tokenExpiresAt: NOW + 3600_000,
    });
  });

  it("a user: role user", async () => {
    const r = await call(fakeEnv(), userP(), "R1");
    expect(r.body).toMatchObject({ principal: "user", role: "user" });
  });
});

describe("R2 list and R3 detail", () => {
  it("lists summaries newest first with a cursor; filters by state, source and q", async () => {
    const e = fakeEnv();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await seedInstall({ slug: `ls${i}`, createdAt: 100 + i })).id);
    await seedFailedCreate({ slug: "lsfail" });
    const p1 = await call(e, ADMIN_P, "R2", { query: { limit: "2" } });
    expect(p1.body.items.map((i: { slug: string }) => i.slug)).toEqual([
      "ls4",
      "ls3",
    ]);
    for (const i of p1.body.items) InstallSummarySchema.parse(i);
    const p2 = await call(e, ADMIN_P, "R2", {
      query: { limit: "2", cursor: p1.body.nextCursor },
    });
    expect(p2.body.items.map((i: { slug: string }) => i.slug)).toEqual([
      "ls2",
      "ls1",
    ]);
    const failed = await call(e, ADMIN_P, "R2", { query: { state: "failed" } });
    expect(failed.body.items.map((i: { slug: string }) => i.slug)).toEqual([
      "lsfail",
    ]);
    expect(failed.body.items[0].appHost).toBe("lsfail.hosted.test");
    const q = await call(e, ADMIN_P, "R2", { query: { q: "ls3" } });
    expect(q.body.items).toHaveLength(1);
    const slugsFor = async (v: string) =>
      (await call(e, ADMIN_P, "R2", { query: { q: v } })).body.items.map(
        (i: { slug: string }) => i.slug,
      );
    // A slug substring, case-insensitive; never a host, never a wildcard.
    expect(await slugsFor("S3")).toEqual(["ls3"]);
    expect(await slugsFor("fai")).toEqual(["lsfail"]);
    expect(await slugsFor("hosted")).toEqual([]);
    expect(await slugsFor("ls3.hosted.test")).toEqual([]);
    expect(await slugsFor("%")).toEqual([]);
    expect(await slugsFor("l_3")).toEqual([]);
    expect(
      (await call(e, ADMIN_P, "R2", { query: { source: "self-serve" } })).body
        .items,
    ).toEqual([]);
  });

  it("a cursor from elsewhere is 400 invalid_input", async () => {
    const e = fakeEnv();
    expect(
      (await call(e, ADMIN_P, "R2", { query: { cursor: "garbage!" } })).code,
    ).toBe("invalid_input");
  });

  it("a cursor from another query (route or filters) is 400 invalid_input", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ createdAt: 5 });
    await seedInstall({ createdAt: 6 });
    await seedJob(id, { status: "done", created_at: 10 });
    await seedJob(id, { status: "done", created_at: 20 });
    const jobs = await call(e, ADMIN_P, "R14", {
      params: { id },
      query: { limit: "1" },
    });
    expect(jobs.body.nextCursor).not.toBeNull();
    expect(
      (
        await call(e, ADMIN_P, "R2", {
          query: { cursor: jobs.body.nextCursor },
        })
      ).code,
    ).toBe("invalid_input");
    const all = await call(e, ADMIN_P, "R2", { query: { limit: "1" } });
    expect(all.body.nextCursor).not.toBeNull();
    expect(
      (
        await call(e, ADMIN_P, "R2", {
          query: { cursor: all.body.nextCursor, state: "active" },
        })
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await call(e, ADMIN_P, "R2", {
          query: { cursor: all.body.nextCursor, limit: "1" },
        })
      ).status,
    ).toBe(200);
    const other = await seedInstall();
    expect(
      (
        await call(e, ADMIN_P, "R14", {
          params: { id: other.id },
          query: { cursor: jobs.body.nextCursor },
        })
      ).code,
    ).toBe("invalid_input");
  });

  it("O sees rl- test installs only; U its own only", async () => {
    const e = fakeEnv();
    await seedInstall({ slug: "rl-a", testHooks: true });
    await seedInstall({ slug: "rl-z" });
    const mine = await seedInstall({ source: "self-serve", ownerSub: "u1" });
    await seedInstall({ source: "self-serve", ownerSub: "u2" });
    const o = await call(e, OIDC_P, "R2");
    expect(o.body.items.map((i: { slug: string }) => i.slug)).toEqual(["rl-a"]);
    const u = await call(e, userP("u1"), "R2");
    expect(u.body.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
  });

  it("R3: detail; ownerEmail for admin, owner and installs:pii only", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({
      ownerEmail: "boss@acme.test",
      source: "self-serve",
      ownerSub: "u1",
      leaseUntil: NOW + 1000,
    });
    const a = await call(e, ADMIN_P, "R3", { params: { id } });
    expect(InstallDetailSchema.parse(a.body)).toMatchObject({
      id,
      ownerEmail: "boss@acme.test",
      auth: { providers: ["google"], domains: ["acme.test"] },
      version: "1.41.2",
      previousVersion: "1.40.0",
      lease: { held: true, until: NOW + 1000 },
      mismatch: null,
      restorable: false,
      testHooks: false,
    });
    expect(
      (await call(e, READ, "R3", { params: { id } })).body.ownerEmail,
    ).toBe(null);
    expect((await call(e, PII, "R3", { params: { id } })).body.ownerEmail).toBe(
      "boss@acme.test",
    );
    expect(
      (await call(e, userP("u1"), "R3", { params: { id } })).body.ownerEmail,
    ).toBe("boss@acme.test");
    expect((await call(e, userP("u2"), "R3", { params: { id } })).code).toBe(
      "not_found",
    );
    expect((await call(e, OIDC_P, "R3", { params: { id } })).code).toBe(
      "not_found",
    );
  });

  it("R3: mismatch when the serving mode disagrees with the state; restorable in grace", async () => {
    const e = fakeEnv();
    const a = await seedInstall({ lifecycle: { serving_mode: "paused" } });
    expect(
      (await call(e, ADMIN_P, "R3", { params: { id: a.id } })).body.mismatch,
    ).toBe("state active, serving mode paused");
    const d = await seedInstall({
      state: "deleting",
      lifecycle: { deleted_at: NOW - 1, purge_at: NOW + 1000 },
    });
    const r = await call(e, ADMIN_P, "R3", { params: { id: d.id } });
    expect(r.body).toMatchObject({
      state: "deleting",
      restorable: true,
      deletedAt: NOW - 1,
      purgeAt: NOW + 1000,
      mismatch: null,
    });
  });

  it("R3 on a bad id is invalid_input; unknown is 404", async () => {
    const e = fakeEnv();
    expect(
      (await call(e, ADMIN_P, "R3", { params: { id: "nope" } })).code,
    ).toBe("invalid_input");
    expect(
      (await call(e, ADMIN_P, "R3", { params: { id: "izzzzzzzzzzz" } })).code,
    ).toBe("not_found");
  });
});

describe("R14 and R15 jobs", () => {
  it("R14 lists the install's jobs newest first, without sealed", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    const a = await seedJob(id, { status: "done", created_at: 10 });
    const b = await seedJob(id, {
      kind: "redline_creds",
      workflow: "manage_install",
      status: "done",
      sealed: "secret",
      created_at: 20,
    });
    const r = await call(e, ADMIN_P, "R14", { params: { id } });
    expect(r.body.items.map((j: { id: string }) => j.id)).toEqual([b, a]);
    for (const j of r.body.items) {
      JobListItemSchema.strict().parse(j);
      expect(j).not.toHaveProperty("sealed");
    }
  });

  it("R15: sealed only to the creating OIDC caller, cleared on first read", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ slug: "rl-a", testHooks: true });
    const j = await seedJob(id, {
      kind: "redline_creds",
      workflow: "manage_install",
      status: "done",
      sealed: "ciphertext",
      actor_kind: "oidc",
      actor_key: OIDC_P.actorKey,
      actor_label: OIDC_P.label,
    });
    expect(
      (await call(e, ADMIN_P, "R15", { params: { jobId: j } })).body.sealed,
    ).toBe(null);
    const first = await call(e, OIDC_P, "R15", { params: { jobId: j } });
    expect(JobSchema.parse(first.body).sealed).toBe("ciphertext");
    expect(
      (await call(e, OIDC_P, "R15", { params: { jobId: j } })).body.sealed,
    ).toBe(null);
  });

  it("R15 maps the step index and error", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    const j = await seedJob(id, {
      kind: "upgrade",
      workflow: "manage_install",
      status: "failed",
      step: "health",
      attempt: 2,
      error_code: "upgrade_rolled_back",
      error_message: "health failed",
      args: JSON.stringify({ from: "1.41.2", to: "1.42.0" }),
    });
    const r = await call(e, READ, "R15", { params: { jobId: j } });
    expect(r.body).toMatchObject({
      step: "health",
      stepIndex: 4,
      attempt: 2,
      error: { code: "upgrade_rolled_back", message: "health failed" },
      args: { from: "1.41.2", to: "1.42.0" },
    });
  });

  it("R15 on another user's install is 404", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ source: "self-serve", ownerSub: "u2" });
    const j = await seedJob(id, {});
    expect(
      (await call(e, userP("u1"), "R15", { params: { jobId: j } })).code,
    ).toBe("not_found");
  });
});

describe("R16 releases", () => {
  it("via PROVISIONER.releases(), cached 60 s per isolate", async () => {
    const e = fakeEnv();
    const r = await call(e, ADMIN_P, "R16");
    expect(r.body).toEqual({ items: FAKE_RELEASES });
    await call(e, ADMIN_P, "R16");
    const n = () =>
      e.provisioner.calls.filter((c) => c.method === "releases").length;
    expect(n()).toBe(1);
    now += 61_000;
    await call(e, ADMIN_P, "R16");
    expect(n()).toBe(2);
  });
});

describe("R18 slug check", () => {
  it("ok, invalid, reserved and taken", async () => {
    const e = fakeEnv();
    await seedInstall({ slug: "taken1" });
    const st = async (slug: string) =>
      (await call(e, ADMIN_P, "R18", { params: { slug } })).body.status;
    expect(await st("fresh")).toBe("ok");
    expect(await st("Bad")).toBe("invalid");
    expect(await st("admin")).toBe("reserved");
    expect(await st("taken1")).toBe("taken");
  });

  it("RL_PV_SLUG_IP keys IPv6 by /64 (4.7 ipKey)", async () => {
    const e = fakeEnv();
    for (const ip of ["2001:db8:1:2::5", "2001:db8:1:2:ffff::9"])
      await call(
        e,
        userP(),
        "R18",
        { params: { slug: "x" } },
        { kind: "http", client: { ip, host: "api.hosted.test" } },
      );
    const [a, b] = e.limits.RL_PV_SLUG_IP.keys;
    expect(a).toBe(b);
    expect(a).not.toContain("::5");
  });

  it("a user is charged RL_PV_SLUG_IP by IP", async () => {
    const e = fakeEnv();
    await call(e, userP(), "R18", { params: { slug: "x" } });
    expect(e.limits.RL_PV_SLUG_IP.keys).toEqual(["192.0.2.1"]);
    e.limits.RL_PV_SLUG_IP.allow = false;
    expect(
      (await call(e, userP(), "R18", { params: { slug: "x" } })).code,
    ).toBe("rate_limited");
  });
});

describe("R17 audit", () => {
  const seedAudit = async (installId: string) => {
    await insert("admin_audit", {
      at: NOW - 3,
      actor_kind: "token",
      actor_label: "bot",
      token_id: "01JD7Z9W5Q8X3N4M2K1H0G9F8G",
      action: "job.accepted",
      install_id: installId,
      outcome: "ok",
      detail: JSON.stringify({
        admin: "other@example.com",
        ownerEmail: "o@acme.test",
        kind: "create",
      }),
    });
    await insert("hosted_audit", {
      at: NOW - 2,
      install_id: installId,
      action: "job.done",
      detail: JSON.stringify({ code: null }),
    });
    await insert("audit_refusals", {
      bucket: "auth",
      code: "unauthenticated",
      ip_hmac: "x",
      window_start: NOW - 1,
      count: 7,
      updated_at: NOW,
    });
  };

  it("merges admin_audit, hosted_audit and audit_refusals, newest first, paged", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    await seedAudit(id);
    const all = await call(e, PII, "R17", { query: { limit: "100" } });
    for (const x of all.body.items) AuditEntrySchema.parse(x);
    const mine = all.body.items.filter((x: { at: number }) => x.at >= NOW - 3);
    expect(mine.map((x: { source: string }) => x.source)).toEqual([
      "refusals",
      "provision",
      "api",
    ]);
    expect(mine[0]).toMatchObject({
      count: 7,
      outcome: "refused",
      code: "unauthenticated",
    });
    const p1 = await call(e, PII, "R17", { query: { limit: "1" } });
    const p2 = await call(e, PII, "R17", {
      query: { limit: "1", cursor: p1.body.nextCursor },
    });
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    const byInstall = await call(e, PII, "R17", { query: { installId: id } });
    expect(
      byInstall.body.items.map((x: { source: string }) => x.source),
    ).toEqual(["provision", "api"]);
  });

  it("email detail fields are null for a token without installs:pii", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    await seedAudit(id);
    const t = tokenP(["audit:read"]);
    const r = await call(e, t, "R17", { query: { installId: id } });
    const api = r.body.items.find(
      (x: { source: string }) => x.source === "api",
    );
    expect(api.detail).toEqual({
      admin: null,
      ownerEmail: null,
      kind: "create",
    });
    const p = await call(e, PII, "R17", { query: { installId: id } });
    expect(
      p.body.items.find((x: { source: string }) => x.source === "api").detail
        .ownerEmail,
    ).toBe("o@acme.test");
  });

  it("an email actor label of another admin is hidden for a token without installs:pii", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    await insert("admin_audit", {
      at: NOW - 4,
      actor_kind: "admin",
      actor_label: "other@example.com",
      action: "job.accepted",
      install_id: id,
      outcome: "ok",
    });
    const t = tokenP(["audit:read"]);
    const r = await call(e, t, "R17", { query: { installId: id } });
    const api = r.body.items.find(
      (x: { source: string }) => x.source === "api",
    );
    expect(api.actor).toEqual({ kind: "admin", label: "hidden" });
    const p = await call(e, PII, "R17", { query: { installId: id } });
    expect(
      p.body.items.find((x: { source: string }) => x.source === "api").actor
        .label,
    ).toBe("other@example.com");
  });

  it("an email actor filter without installs:pii is forbidden unless it is the token's own", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    await insert("admin_audit", {
      at: NOW - 4,
      actor_kind: "admin",
      actor_label: "other@example.com",
      action: "job.accepted",
      install_id: id,
      outcome: "ok",
    });
    const t = tokenP(["audit:read"]);
    const r = await call(e, t, "R17", {
      query: { actor: "other@example.com" },
    });
    expect(r.code).toBe("forbidden");
    const own = await call(e, t, "R17", {
      query: { actor: t.email as string },
    });
    expect(own.status).toBe(200);
    const tok = await call(e, t, "R17", {
      query: { actor: `token:${t.tokenId}` },
    });
    expect(tok.status).toBe(200);
    const p = await call(e, PII, "R17", {
      query: { actor: "other@example.com" },
    });
    expect(p.body.items.length).toBeGreaterThan(0);
    for (const x of p.body.items)
      expect(x.actor.label).toBe("other@example.com");
  });

  it("O sees its own actor rows only", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall();
    await seedAudit(id);
    const body = { requestId: requestId(), reason: "x" };
    await seedInstall({ slug: "rl-q", testHooks: true }).then((t) =>
      call(e, OIDC_P, "R7", { params: { id: t.id }, body }),
    );
    const r = await call(e, OIDC_P, "R17", { query: { limit: "100" } });
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const x of r.body.items)
      expect(x.actor).toEqual({ kind: "oidc", label: OIDC_P.label });
  });

  it("a bad cursor is invalid_input", async () => {
    expect(
      (await call(fakeEnv(), ADMIN_P, "R17", { query: { cursor: "e30" } }))
        .code,
    ).toBe("invalid_input");
  });
});

void db;
