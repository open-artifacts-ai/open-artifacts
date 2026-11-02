import {
  authorize,
  isApiRoute,
  ROUTE_IDS,
  TestAdminSessionResultSchema,
} from "@oa/shared/provisioning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideConsent, showConsent } from "../src/auth/oauth/consent.js";
import { openSealed, SEAL_INFO } from "../src/auth/seal.js";
import { SESSION_COOKIE, sessionPrincipal } from "../src/auth/session.js";
import {
  mintTestAdminSession,
  TEST_ADMIN,
  TEST_ADMIN_TTL_MS,
} from "../src/auth/test-admin.js";
import type { Principal } from "../src/principal.js";
import { call } from "./call.js";
import {
  ADMIN,
  db,
  fakeEnv,
  insert,
  OIDC_P,
  requestId,
  resetDb,
  seedInstall,
} from "./fakes.js";

// Staging's test admin (#1053): its own principal kind, an explicit route
// allowlist, rl- reach, no pii, sessions only from the pinned workflow.

const NOW = Date.UTC(2026, 10, 2, 6);
let now = NOW;
beforeEach(async () => {
  await resetDb();
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** The routes the test admin may call; every other API route is 403. */
const ALLOWED = [
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R14",
  "R15",
  "R16",
  "R17",
  "R18",
] as const;

const TA: Principal = {
  kind: "test-admin",
  actorKey: `admin:${TEST_ADMIN.email}`,
  rateKey: `admin:${TEST_ADMIN.email}`,
  label: "test admin",
  scopes: [],
  email: TEST_ADMIN.email,
  sub: TEST_ADMIN.sub,
  authAt: NOW,
};
const TA_OIDC: Principal = {
  ...OIDC_P,
  rateKey: `${OIDC_P.rateKey}:test-admin`,
  oidcWorkflow: "test-admin",
  oidcRun: {
    actor: "octocat",
    runId: "123456",
    workflowRef:
      "open-artifacts-ai/open-artifacts/.github/workflows/staging-test-admin.yml@refs/heads/main",
  },
};
const RL_OIDC: Principal = { ...OIDC_P, oidcWorkflow: "redline" };

async function keyPair() {
  const k = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { k, b64 };
}
const cookieReq = (sid: string) =>
  new Request(`${ADMIN}/api/v1/me`, {
    headers: { cookie: `${SESSION_COOKIE}=${sid}` },
  });

describe("authz: the test admin's allowlist", () => {
  it("staging: allowed routes are exactly the allowlist, with rl- reach; every other API route is 403", () => {
    for (const route of ROUTE_IDS.filter(isApiRoute)) {
      const d = authorize(route, TA, "staging");
      if ((ALLOWED as readonly string[]).includes(route))
        expect(d.ok, route).toBe(true);
      else expect(d, route).toEqual({ ok: false, code: "forbidden" });
    }
    for (const r of ["R2", "R3", "R4", "R5", "R14", "R15", "R17"] as const)
      expect(authorize(r, TA, "staging")).toEqual({ ok: true, reach: "own" });
  });

  it("prod: every route is unauthenticated", () => {
    for (const route of ROUTE_IDS)
      expect(authorize(route, TA, "prod"), route).toEqual({
        ok: false,
        code: "unauthenticated",
      });
  });

  it("through invokeRoute: every route off the allowlist answers 403 forbidden", async () => {
    const e = fakeEnv();
    for (const route of ROUTE_IDS.filter(isApiRoute)) {
      if ((ALLOWED as readonly string[]).includes(route)) continue;
      expect((await call(e, TA, route)).code, route).toBe("forbidden");
    }
  });

  it("R11 purge, R9 delete, R19-R21 tokens, R13, R25, R26, R27, R28 are refused", async () => {
    const e = fakeEnv();
    for (const r of [
      "R9",
      "R11",
      "R13",
      "R19",
      "R20",
      "R21",
      "R25",
      "R26",
      "R27",
      "R28",
    ] as const)
      expect((await call(e, TA, r)).status, r).toBe(403);
  });

  it("R28: only the test admin workflow's OIDC caller; that caller nothing else", () => {
    expect(authorize("R28", TA_OIDC, "staging").ok).toBe(true);
    expect(authorize("R28", RL_OIDC, "staging")).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(authorize("R28", OIDC_P, "staging")).toEqual({
      ok: false,
      code: "forbidden",
    });
    for (const k of ["admin", "token", "user"] as const)
      expect(authorize("R28", { kind: k, scopes: [] }, "staging").ok, k).toBe(
        false,
      );
    for (const route of ROUTE_IDS.filter((r) => r !== "R28"))
      expect(authorize(route, TA_OIDC, "staging"), route).toEqual({
        ok: false,
        code: "forbidden",
      });
    expect(authorize("R28", TA_OIDC, "prod")).toEqual({
      ok: false,
      code: "unauthenticated",
    });
  });
});

describe("R28: the sealed 1 h session", () => {
  it("returns the sid sealed to the caller's key; the session is the test admin", async () => {
    const e = fakeEnv();
    const { k, b64 } = await keyPair();
    const r = await call(e, TA_OIDC, "R28", { body: { recipientKey: b64 } });
    expect(r.status).toBe(201);
    const body = TestAdminSessionResultSchema.parse(r.body);
    expect(body.expiresAt).toBe(NOW + TEST_ADMIN_TTL_MS);
    expect(body.sealed).toMatch(/^oa-seal-v1\./);
    const sid = await openSealed(k, body.sealed, SEAL_INFO.testAdminSession);
    await expect(openSealed(k, body.sealed)).rejects.toThrow();
    expect(JSON.stringify(r.body)).not.toContain(sid);
    const p = await sessionPrincipal(cookieReq(sid), e.env, NOW);
    expect(p).toMatchObject({
      kind: "test-admin",
      label: "test admin",
      email: TEST_ADMIN.email,
      sub: TEST_ADMIN.sub,
    });
    const a = await db
      .prepare(
        "SELECT actor_kind, action, outcome, detail FROM admin_audit WHERE action = 'test_admin.session'",
      )
      .first<{ actor_kind: string; outcome: string; detail: string }>();
    expect(a).toMatchObject({ actor_kind: "oidc", outcome: "ok" });
    expect(a?.detail).not.toContain(sid);
    // Traceable to the run that minted it (#1053 review).
    expect(JSON.parse(a?.detail as string)).toMatchObject({
      runActor: "octocat",
      runId: "123456",
      workflowRef: expect.stringContaining(
        "staging-test-admin.yml@refs/heads/main",
      ),
    });
  });

  it("a small-order key is 400 invalid_input, and the live session stays live", async () => {
    const e = fakeEnv();
    const live = await mintTestAdminSession(e.env, NOW);
    const zero = Buffer.alloc(32).toString("base64url");
    const r = await call(e, TA_OIDC, "R28", { body: { recipientKey: zero } });
    expect(r).toMatchObject({ status: 400, code: "invalid_input" });
    expect(
      await sessionPrincipal(cookieReq(live.sid), e.env, NOW),
    ).toMatchObject({
      kind: "test-admin",
    });
  });

  it("ends after 1 h", async () => {
    const e = fakeEnv();
    const { sid } = await mintTestAdminSession(e.env, NOW);
    expect(
      await sessionPrincipal(
        cookieReq(sid),
        e.env,
        NOW + TEST_ADMIN_TTL_MS - 1,
      ),
    ).toMatchObject({ kind: "test-admin" });
    expect(
      await sessionPrincipal(cookieReq(sid), e.env, NOW + TEST_ADMIN_TTL_MS),
    ).toEqual({ refusal: true, code: "unauthenticated" });
  });

  it("one live session: a new mint revokes the previous", async () => {
    const e = fakeEnv();
    const first = await mintTestAdminSession(e.env, NOW);
    const second = await mintTestAdminSession(e.env, NOW + 1000);
    expect(
      await sessionPrincipal(cookieReq(first.sid), e.env, NOW + 2000),
    ).toEqual({ refusal: true, code: "unauthenticated" });
    expect(
      await sessionPrincipal(cookieReq(second.sid), e.env, NOW + 2000),
    ).toMatchObject({ kind: "test-admin" });
    const live = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE sub = ? AND revoked_at IS NULL",
      )
      .bind(TEST_ADMIN.sub)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
  });

  it("the mint refuses outside staging", async () => {
    await expect(
      mintTestAdminSession(fakeEnv({ OA_ENV: "prod" }).env, NOW),
    ).rejects.toThrow(/staging only/);
  });
});

describe("prod refuses the test admin's session", () => {
  it("a pinned session row on prod is unauthenticated, even if ADMIN_IDENTITIES lists it", async () => {
    const staging = fakeEnv();
    const { sid } = await mintTestAdminSession(staging.env, NOW);
    const prod = fakeEnv({
      OA_ENV: "prod",
      ADMIN_IDENTITIES: `${TEST_ADMIN.email}:${TEST_ADMIN.sub}`,
    });
    expect(await sessionPrincipal(cookieReq(sid), prod.env, NOW)).toEqual({
      refusal: true,
      code: "unauthenticated",
    });
  });

  it("listing the pinned pair in staging's ADMIN_IDENTITIES does not make it an admin", async () => {
    const e = fakeEnv({
      ADMIN_IDENTITIES: `me@example.com:123,${TEST_ADMIN.email}:${TEST_ADMIN.sub}`,
    });
    const { sid } = await mintTestAdminSession(e.env, NOW);
    expect(await sessionPrincipal(cookieReq(sid), e.env, NOW)).toMatchObject({
      kind: "test-admin",
    });
  });
});

describe("reads and writes: rl- reach, no pii", () => {
  it("R2 lists only rl- test installs; R3 hides the owner email", async () => {
    const e = fakeEnv();
    const rl = await seedInstall({
      slug: "rl-ta1",
      testHooks: true,
      ownerEmail: "o@oa-redline-a.fyi",
    });
    const other = await seedInstall({ slug: "customer1" });
    const list = await call(e, TA, "R2");
    const ids = (list.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(rl.id);
    expect(ids).not.toContain(other.id);
    const d = await call(e, TA, "R3", { params: { id: rl.id } });
    expect(d.status).toBe(200);
    expect(d.body.ownerEmail ?? null).toBeNull();
    expect((await call(e, TA, "R3", { params: { id: other.id } })).status).toBe(
      404,
    );
  });

  it("R17: only its own rows, with every email in them hidden", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ slug: "rl-ta4", testHooks: true });
    await insert("admin_audit", {
      at: NOW - 2,
      actor_kind: "test-admin",
      actor_label: "test admin",
      action: "job.accepted",
      install_id: id,
      outcome: "ok",
      detail: JSON.stringify({
        ownerEmail: "o@oa-redline-a.fyi",
        kind: "create",
      }),
    });
    await insert("admin_audit", {
      at: NOW - 1,
      actor_kind: "admin",
      actor_label: "me@example.com",
      action: "job.accepted",
      install_id: id,
      outcome: "ok",
      detail: JSON.stringify({ kind: "create" }),
    });
    const r = await call(e, TA, "R17", { query: { installId: id } });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("o@oa-redline-a.fyi");
    expect(text).not.toContain("me@example.com");
  });

  it("R2's q never matches by owner email", async () => {
    const e = fakeEnv();
    await seedInstall({
      slug: "rl-ta2",
      testHooks: true,
      ownerEmail: "findme@oa-redline-a.fyi",
    });
    const r = await call(e, TA, "R2", { query: { q: "findme" } });
    expect(r.body.items).toEqual([]);
  });

  it("R5 upgrade end to end: an rl- install's job is accepted and stored as oidc; another install is 404", async () => {
    const e = fakeEnv();
    const rl = await seedInstall({
      slug: "rl-ta5",
      testHooks: true,
      version: "1.41.2",
    });
    const up = await call(e, TA, "R5", {
      params: { id: rl.id },
      body: { requestId: requestId() },
    });
    expect(up.status).toBe(202);
    expect(up.body.job.args).toEqual({ from: "1.41.2", to: "1.42.0" });
    const j = await db
      .prepare("SELECT kind, actor_kind, actor_label FROM jobs WHERE id = ?")
      .bind(up.body.job.id)
      .first();
    expect(j).toEqual({
      kind: "upgrade",
      actor_kind: "oidc",
      actor_label: "test admin",
    });
    const other = await seedInstall({ slug: "customer3", version: "1.41.2" });
    expect(
      (
        await call(e, TA, "R5", {
          params: { id: other.id },
          body: { requestId: requestId() },
        })
      ).status,
    ).toBe(404);
  });

  it("R4 takes O's field rules, and the job is stored as oidc under the test admin's key", async () => {
    const e = fakeEnv();
    const body = {
      requestId: requestId(),
      slug: "rl-ta3",
      ownerEmail: "a@oa-redline-a.fyi",
      tier: "team",
      auth: { providers: ["email"], domains: [] },
      testHooks: true,
    };
    expect(
      (await call(e, TA, "R4", { body: { ...body, slug: "customer2" } })).code,
    ).toBe("forbidden");
    const r = await call(e, TA, "R4", { body });
    expect(r.status).toBe(202);
    const j = await db
      .prepare(
        "SELECT actor_kind, actor_key, actor_label FROM jobs WHERE id = ?",
      )
      .bind(r.body.job.id)
      .first();
    expect(j).toEqual({
      actor_kind: "oidc",
      actor_key: `admin:${TEST_ADMIN.email}`,
      actor_label: "test admin",
    });
  });
});

describe("OAuth consent: a grant is a token, so the test admin gets none", () => {
  it("GET and POST /oauth/authorize answer 403 for a test admin session", async () => {
    vi.restoreAllMocks();
    const e = fakeEnv();
    const { sid } = await mintTestAdminSession(e.env, Date.now());
    const headers = {
      cookie: `${SESSION_COOKIE}=${sid}`,
      "cf-connecting-ip": "192.0.2.20",
      "sec-fetch-site": "same-origin",
      origin: ADMIN,
    };
    const get = await showConsent(
      new Request(`${ADMIN}/oauth/authorize?client_id=c&b=1`, { headers }),
      e.env,
    );
    expect(get.status).toBe(403);
    const post = await decideConsent(
      new Request(`${ADMIN}/oauth/authorize`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "x=1",
      }),
      e.env,
    );
    expect(post.status).toBe(403);
  });
});
