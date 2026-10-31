import { describe, expect, it } from "vitest";
import {
  fixtureInstall,
  fixtureJob,
  fixtureSummary,
  fixtureWorld,
} from "../../src/provisioning/fixtures.js";
import {
  AcceptedSchema,
  ALERT_KEYS,
  API_ERROR_CODES,
  API_ERROR_STATUS,
  AttentionSchema,
  AuthSchema,
  bodyHash,
  CreateInstallSchema,
  canonicalJson,
  DeleteSchema,
  InstallDetailSchema,
  InstallIdSchema,
  InstallSummarySchema,
  JOB_ERROR_CODES,
  JOB_ERROR_RETRY,
  JOB_STEPS,
  JobIdSchema,
  JobKindSchema,
  JobSchema,
  MeSchema,
  MintedTokenSchema,
  MintTokenSchema,
  PAGE_LIMIT,
  ProvisioningErrorSchema,
  PurgeSchema,
  RESERVED_SLUGS,
  RETURN_FALLBACK,
  RETURN_RE,
  RedlineCredsSchema,
  RequestIdSchema,
  ROUTE_IDS,
  ROUTES,
  SlugSchema,
  safeReturn,
  slugError,
  slugRule,
  TokenKindSchema,
  TokenSchema,
  VersionSchema,
  WorkflowParamsSchema,
  WorldSchema,
} from "../../src/provisioning/index.js";
import * as slugsOnly from "../../src/provisioning/slugs.js";

const ULID = "01JD7Z9W5Q8X3N4M2K1H0G9F8E";
const IID = "iabcdefgh234";
const RID = "req_0123456789abcdef";

describe("ids", () => {
  it("InstallId, ULID ids, requestId", () => {
    expect(InstallIdSchema.safeParse(IID).success).toBe(true);
    for (const bad of [
      "Iabcdefgh234",
      "iabcdefgh23",
      "iabcdefgh2345",
      "i_bcdefgh234",
    ])
      expect(InstallIdSchema.safeParse(bad).success, bad).toBe(false);
    expect(JobIdSchema.safeParse(ULID).success).toBe(true);
    // 8 cannot lead a ULID (time overflow); I, L, O, U are not Crockford.
    for (const bad of [
      "81JD7Z9W5Q8X3N4M2K1H0G9F8E",
      "01JD7Z9W5Q8X3N4M2K1H0G9F8I",
      ULID.toLowerCase(),
    ])
      expect(JobIdSchema.safeParse(bad).success, bad).toBe(false);
    expect(RequestIdSchema.safeParse("a".repeat(16)).success).toBe(true);
    expect(RequestIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    for (const bad of ["a".repeat(15), "a".repeat(65), "has space 0123456"])
      expect(RequestIdSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("Workflow params are exactly { jobId }", () => {
    expect(WorkflowParamsSchema.parse({ jobId: ULID })).toEqual({
      jobId: ULID,
    });
    expect(
      WorkflowParamsSchema.safeParse({ jobId: ULID, slug: "x" }).success,
    ).toBe(false);
    expect(WorkflowParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe("slugs", () => {
  it("reserves the platform hosts, including the new ones", () => {
    for (const s of [
      "admin",
      "api",
      "auth",
      "directory",
      "signup",
      "billing",
      "provisioning",
      "provisioner",
    ])
      expect(RESERVED_SLUGS, s).toContain(s);
  });

  it("slugRule: ok, invalid, reserved; IDNA -- at 3-4 is invalid", () => {
    expect(slugRule("acme")).toBe("ok");
    expect(slugRule("rl-a")).toBe("ok");
    expect(slugRule("signup")).toBe("reserved");
    for (const bad of [
      "",
      "-a",
      "a-",
      "A",
      "xn--abc",
      "ab--c",
      "a".repeat(33),
      "a_b",
    ])
      expect(slugRule(bad), bad).toBe("invalid");
    expect(slugRule("a".repeat(32))).toBe("ok");
    expect(SlugSchema.safeParse("acme").success).toBe(true);
    expect(SlugSchema.safeParse("admin").success).toBe(false);
    expect(SlugSchema.safeParse("xn--abc").success).toBe(false);
    expect(slugError("acme")).toBeNull();
    expect(slugError("Bad")).toBe("slug_invalid");
    expect(slugError("billing")).toBe("slug_reserved");
  });

  it("inputs take any short slug, so policy can say slug_* or confirm_mismatch", () => {
    const rid = "req_0123456789abcdef";
    for (const slug of ["admin", "Bad_Slug", "xn--abc"])
      expect(CreateInstallSchema.shape.slug.safeParse(slug).success, slug).toBe(
        true,
      );
    expect(
      CreateInstallSchema.shape.slug.safeParse("a".repeat(65)).success,
    ).toBe(false);
    expect(
      DeleteSchema.safeParse({ requestId: rid, confirmSlug: "Leo" }).success,
    ).toBe(true);
    // Outputs: a since-reserved slug still parses.
    expect(
      InstallSummarySchema.safeParse(fixtureSummary({ slug: "billing" }))
        .success,
    ).toBe(true);
  });

  it("safeReturn (4.3)", () => {
    const O = "https://admin.open-artifacts.app";
    for (const ok of ["/installs/i1", "/oauth/authorize?client_id=a&state=b"])
      expect(safeReturn(ok, O), ok).toBe(ok);
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "/a\tb",
      "/a\nb",
      "/a b",
      "/auth/start",
      "https://evil.com/",
      "installs",
      "",
      undefined,
      `/${"a".repeat(2048)}`,
    ])
      expect(safeReturn(bad, O), String(bad)).toBe(RETURN_FALLBACK);
    expect(RETURN_RE.test("/ok")).toBe(true);
  });

  it("RedlineCreds.recipientKey is a 32-byte base64url key", () => {
    const rid = "req_0123456789abcdef";
    const key = Buffer.alloc(32, 7).toString("base64url");
    expect(
      RedlineCredsSchema.safeParse({ requestId: rid, recipientKey: key })
        .success,
    ).toBe(true);
    for (const bad of ["", "x".repeat(43), `${key}=`, key.slice(1), `${key}A`])
      expect(
        RedlineCredsSchema.safeParse({ requestId: rid, recipientKey: bad })
          .success,
        bad,
      ).toBe(false);
  });

  it("the slugs module stands alone (no zod), for @oa/provision", () => {
    expect(slugsOnly.RESERVED_SLUGS).toBe(RESERVED_SLUGS);
    expect(Object.keys(slugsOnly).sort()).toEqual([
      "RESERVED_SLUGS",
      "SLUG_RE",
      "isValidSlug",
      "slugError",
      "slugRule",
    ]);
  });
});

describe("enums and JOB_STEPS", () => {
  it("every job kind has steps ending in done; create and retry match", () => {
    for (const k of JobKindSchema.options) {
      const steps = JOB_STEPS[k];
      expect(steps.length, k).toBeGreaterThan(1);
      expect(steps.at(-1), k).toBe("done");
      expect(new Set(steps).size, k).toBe(steps.length);
    }
    expect(JOB_STEPS.retry).toEqual(JOB_STEPS.create);
    expect(Object.keys(JOB_STEPS).sort()).toEqual(
      [...JobKindSchema.options].sort(),
    );
  });

  it("create runs verify_clean and health before route", () => {
    const c = JOB_STEPS.create;
    expect(c.indexOf("verify_clean")).toBeLessThan(c.indexOf("route"));
    expect(c.indexOf("health")).toBeLessThan(c.indexOf("route"));
    expect(c.indexOf("route")).toBeLessThan(c.indexOf("enable_signin"));
  });

  it("the reserved M1.1 kind is not in the enum", () => {
    expect(JobKindSchema.safeParse("update").success).toBe(false);
  });

  it("ALERT_KEYS lists the scheduler's alerts once each", () => {
    expect(new Set(ALERT_KEYS).size).toBe(ALERT_KEYS.length);
    for (const k of [
      "job_failed",
      "prod_dirty",
      "token_expiring",
      "token_invalid",
      "oauth_register_flood",
    ])
      expect(ALERT_KEYS).toContain(k);
  });
});

describe("error tables", () => {
  it("each ApiErrorCode has exactly one HTTP status", () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual(
      [...API_ERROR_CODES].sort(),
    );
    for (const c of API_ERROR_CODES) {
      const s = API_ERROR_STATUS[c];
      expect(Number.isInteger(s) && s >= 400 && s < 600, c).toBe(true);
    }
    expect(API_ERROR_STATUS.unauthenticated).toBe(401);
    expect(API_ERROR_STATUS.job_in_progress).toBe(409);
    expect(API_ERROR_STATUS.release_not_published).toBe(422);
    expect(API_ERROR_STATUS.signups_closed).toBe(503);
  });

  it("each JobErrorCode has one retry class", () => {
    expect(Object.keys(JOB_ERROR_RETRY).sort()).toEqual(
      [...JOB_ERROR_CODES].sort(),
    );
    expect(JOB_ERROR_RETRY.token_invalid).toBe("retry");
    expect(JOB_ERROR_RETRY.upgrade_incomplete).toBe("terminal_alert");
    expect(JOB_ERROR_RETRY.canceled).toBe("terminal");
  });

  it("the envelope matches the API's", () => {
    const e = {
      error: {
        code: "forbidden",
        message: "no",
        details: { needs: "admin_session" },
      },
    };
    expect(ProvisioningErrorSchema.parse(e)).toEqual(e);
    expect(
      ProvisioningErrorSchema.safeParse({
        error: { code: "nope", message: "" },
      }).success,
    ).toBe(false);
  });
});

describe("shapes", () => {
  it("round-trips the fixtures", () => {
    const install = fixtureInstall();
    expect(InstallDetailSchema.parse(install)).toEqual(install);
    const job = fixtureJob();
    expect(JobSchema.parse(job)).toEqual(job);
    const world = fixtureWorld();
    expect(WorldSchema.parse(world)).toEqual(world);
    expect(
      AcceptedSchema.parse({ job, install: fixtureSummary() }),
    ).toBeTruthy();
  });

  it("AuthSchema: google needs a domain", () => {
    expect(
      AuthSchema.safeParse({ providers: ["google"], domains: [] }).success,
    ).toBe(false);
    expect(
      AuthSchema.safeParse({ providers: ["email"], domains: [] }).success,
    ).toBe(true);
    expect(AuthSchema.safeParse({ providers: [], domains: [] }).success).toBe(
      false,
    );
  });

  it("Version is stable semver only", () => {
    expect(VersionSchema.safeParse("1.42.0").success).toBe(true);
    for (const bad of ["1.42", "1.42.0-rc.1", "v1.42.0", "1234567.0.0"])
      expect(VersionSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("CreateInstall needs requestId and slug, nothing else", () => {
    expect(
      CreateInstallSchema.safeParse({ requestId: RID, slug: "acme" }).success,
    ).toBe(true);
    expect(CreateInstallSchema.safeParse({ slug: "acme" }).success).toBe(false);
  });

  it("Purge carries skipDirectoryRevoke with a reason", () => {
    const base = { requestId: RID, confirmSlug: "acme" };
    expect(
      PurgeSchema.safeParse({
        ...base,
        skipDirectoryRevoke: { reason: "short" },
      }).success,
    ).toBe(false);
    expect(
      PurgeSchema.safeParse({
        ...base,
        skipDirectoryRevoke: { reason: "directory gone" },
      }).success,
    ).toBe(true);
  });

  it("MintToken: ttl 5..60, default 15", () => {
    const m = MintTokenSchema.parse({
      requestId: RID,
      label: "ci bot",
      scopes: ["installs:read"],
    });
    expect(m.ttlMinutes).toBe(15);
    expect(MintTokenSchema.safeParse({ ...m, ttlMinutes: 61 }).success).toBe(
      false,
    );
    expect(MintTokenSchema.safeParse({ ...m, ttlMinutes: 4 }).success).toBe(
      false,
    );
    expect(MintTokenSchema.safeParse({ ...m, label: "<script>" }).success).toBe(
      false,
    );
  });

  it("TokenSchema carries kind and clientName; minted adds the token", () => {
    expect(TokenKindSchema.options).toEqual(["oat", "oauth"]);
    const t = {
      id: ULID,
      kind: "oauth",
      label: "Claude",
      clientName: "Claude",
      scopes: ["installs:read"],
      createdAt: 1,
      expiresAt: 2,
      revokedAt: null,
      lastUsedAt: null,
    };
    expect(TokenSchema.parse(t)).toEqual(t);
    expect(TokenSchema.safeParse({ ...t, kind: "pat" }).success).toBe(false);
    expect(MintedTokenSchema.safeParse(t).success).toBe(false);
    expect(MintedTokenSchema.safeParse({ ...t, token: "oat_x" }).success).toBe(
      true,
    );
  });

  it("Me carries tokenId, tokenKind and tokenExpiresAt", () => {
    const me = {
      principal: "token",
      email: null,
      role: "admin",
      scopes: ["installs:read"],
      env: "prod",
      csrf: null,
      sessionExpiresAt: null,
      authAt: null,
      provisioningToken: null,
      tokenId: "01JD7Z9W5Q8X3N4M2K1H0G9F8G",
      tokenKind: "oauth",
      tokenExpiresAt: 1_800_000_000_000,
    };
    expect(MeSchema.parse(me)).toEqual(me);
    const { tokenKind: _k, ...missing } = me;
    expect(MeSchema.safeParse(missing).success).toBe(false);
  });

  it("World: recent jobs never carry sealed; attention kinds include ALERT_KEYS", () => {
    const w = fixtureWorld();
    const withSealed = {
      ...w,
      jobs: { ...w.jobs, recent: [{ ...fixtureJob(), sealed: "x" }] },
    };
    const parsed = WorldSchema.parse(withSealed);
    expect("sealed" in parsed.jobs.recent[0]).toBe(false);
    for (const k of [
      ...ALERT_KEYS,
      "install_failed",
      "health_failing",
      "mismatch",
    ])
      expect(AttentionSchema.shape.kind.safeParse(k).success, k).toBe(true);
    expect(
      WorldSchema.safeParse({ ...w, attention: Array(51).fill(w.attention[0]) })
        .success,
    ).toBe(false);
  });

  it("no fixture carries an email-shaped string in World", () => {
    expect(JSON.stringify(fixtureWorld())).not.toMatch(
      /[^\s"@]+@[^\s"@]+\.[a-z]+/,
    );
  });
});

describe("routes", () => {
  it("R1..R27, each once", () => {
    expect(ROUTE_IDS).toEqual(
      Array.from({ length: 27 }, (_, i) => `R${i + 1}`),
    );
    for (const id of ROUTE_IDS) expect(ROUTES[id].id).toBe(id);
  });

  it("writes are POST/DELETE with a requestId body (except tokens' DELETE and auth routes)", () => {
    for (const id of ROUTE_IDS) {
      const r = ROUTES[id];
      if (r.method === "GET") expect(r.write, id).toBe(false);
      if (r.write && r.method === "POST" && r.base === "api")
        expect(Object.keys(r.body.shape), id).toContain("requestId");
    }
  });

  it("path params match the route's params schema", () => {
    for (const id of ROUTE_IDS) {
      const r = ROUTES[id];
      const names = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
      expect(Object.keys(r.params.shape).sort(), id).toEqual(names.sort());
    }
  });

  it("job writes return 202 Accepted", () => {
    for (const id of [
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R9",
      "R10",
      "R11",
      "R12",
      "R13",
      "R26",
    ] as const) {
      expect(ROUTES[id].status, id).toBe(202);
      expect(ROUTES[id].response, id).toBe(AcceptedSchema);
    }
    expect(ROUTES.R25.status).toBe(202);
    expect(ROUTES.R19.status).toBe(201);
    expect(ROUTES.R21.status).toBe(204);
  });

  it("page limit: default 50, max 100", () => {
    expect(PAGE_LIMIT).toEqual({ default: 50, max: 100 });
    const q = ROUTES.R2.query;
    expect(q.safeParse({ limit: "100" }).success).toBe(true);
    expect(q.safeParse({ limit: "101" }).success).toBe(false);
    expect(q.safeParse({ limit: 20 }).success).toBe(true);
  });
});

describe("bodyHash", () => {
  it("canonical JSON sorts keys at every depth", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("includes route and install", async () => {
    const body = { requestId: RID, reason: "x" };
    const h = await bodyHash("R7", IID, body);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await bodyHash("R7", IID, { reason: "x", requestId: RID })).toBe(h);
    expect(await bodyHash("R8", IID, body)).not.toBe(h);
    expect(await bodyHash("R7", "iabcdefgh235", body)).not.toBe(h);
    expect(await bodyHash("R7", null, body)).not.toBe(h);
  });
});
