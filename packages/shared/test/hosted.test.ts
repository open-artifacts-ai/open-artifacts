// The hosted contract on the MSW mock: the schema cases here, and every
// request case (hosted-contract.ts) with the mock as the driver. The same
// request cases run against the real server in
// apps/server/test/hosted.contract.test.ts.
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactSummarySchema,
  AUTH,
  AuditEventSchema,
  AuthProvidersSchema,
  artifactCan,
  CodeRateLimitedDetailsSchema,
  CodeRequestSchema,
  CodeVerifyFailureDetailsSchema,
  directoryModeOf,
  ENV_FEATURE_FLAGS,
  ERROR_CODES,
  HealthzSchema,
  ListQuerySchema,
  MemberSchema,
  MembersQuerySchema,
  MeSchema,
  normalizeCode,
  PublishInputSchema,
  parseFeatures,
  parseTier,
  R,
  SearchQuerySchema,
  SettingsPatchSchema,
  SettingsSchema,
  SPACE_MANAGER_MAPPING_ROLES,
  SPACE_NAME_RESERVED_MESSAGE,
  SpaceCanSchema,
  SpaceCreateSchema,
  SpaceForbiddenDetailsSchema,
  SpaceMemberGroupSchema,
  SpaceMemberSchema,
  SpaceMembersPageSchema,
  SpaceMembersQuerySchema,
  SpaceNameSchema,
  SpacePatchSchema,
  STATUS_FOR,
  spaceNameReserved,
  TEST_HOOKS_ALLOWED,
  TestSessionInputSchema,
  TIER_FEATURES,
  TransferInputSchema,
} from "../src/index.js";
import { fixtures } from "../src/mocks/fixtures.js";
import { createHandlers } from "../src/mocks/handlers.js";
import { HOSTED_MOCK_CODE } from "../src/mocks/hosted.js";
import { type ContractDriver, hostedContract } from "./hosted-contract.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const O = "http://localhost";
const H: Record<string, string> = {
  "content-type": "application/json",
  "x-oa-request": "1",
  cookie: "s=1",
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${O}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const msw: ContractDriver = {
  mock: true,
  fresh: async (o) => {
    server.resetHandlers();
    server.use(...createHandlers(o));
  },
  call,
  // Google when it is on (a domain member gets no code then), else a code.
  signIn: async (email) => {
    const g = await fetch(
      `${O}${AUTH.callbackGoogle}?mock_email=${encodeURIComponent(email)}`,
      { headers: H, redirect: "manual" },
    );
    if (g.headers.get("location") === "/") return;
    await call("POST", AUTH.codeRequest, { email });
    await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE });
  },
  code: async () => HOSTED_MOCK_CODE,
};

hostedContract(msw);

describe("mock AuthProviders.hosted (review item 36c)", () => {
  it("true by default; false with selfHosted, and Me agrees", async () => {
    for (const [selfHosted, hosted] of [
      [false, true],
      [true, false],
    ] as const) {
      server.resetHandlers();
      server.use(...createHandlers({ hosted: { selfHosted } }));
      const p = AuthProvidersSchema.parse(
        await (await call("GET", AUTH.providers)).json(),
      );
      expect(p.hosted).toBe(hosted);
      const me = MeSchema.parse(await (await call("GET", R.me)).json());
      expect(me.instance.hosted).toBe(hosted);
    }
  });
});

describe("hosted contract schemas", () => {
  it("every new error code has a status", () => {
    expect(Object.keys(STATUS_FOR).sort()).toEqual([...ERROR_CODES].sort());
    expect(STATUS_FOR.space_forbidden).toBe(403);
    expect(STATUS_FOR.turnstile_required).toBe(400);
    expect(STATUS_FOR.directory_sync_off).toBe(409);
    expect(STATUS_FOR.directory_mapping_off).toBe(403);
  });

  it("old shapes still parse; new fields are optional", () => {
    expect(MeSchema.parse(fixtures.me)).toEqual(fixtures.me);
    for (const a of fixtures.artifacts)
      expect(ArtifactSummarySchema.parse(a)).toEqual(a);
    for (const m of fixtures.members) expect(MemberSchema.parse(m)).toEqual(m);
    expect(
      HealthzSchema.parse({ ok: true, plan: "free", version: "1" }),
    ).toBeTruthy();
  });

  it("round-trips the hosted shapes", () => {
    const providers = {
      mode: "direct",
      providers: [
        { id: "google", start: AUTH.loginGoogle, domains: ["acme.com"] },
        {
          id: "email",
          domainCodes: false,
          guests: true,
          turnstileSiteKey: "k",
        },
      ],
      hosted: true,
    };
    expect(AuthProvidersSchema.parse(providers)).toEqual(providers);
    expect(
      CodeRequestSchema.parse({ email: " b@acme.com ", turnstileToken: "t" }),
    ).toEqual({ email: "b@acme.com", turnstileToken: "t" });
    expect(CodeRequestSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(normalizeCode(" 1234-5678\t")).toBe("12345678");
    expect(
      CodeVerifyFailureDetailsSchema.parse({
        reason: "invalid_code",
        attemptsLeft: 3,
      }),
    ).toEqual({ reason: "invalid_code", attemptsLeft: 3 });
    expect(
      CodeRateLimitedDetailsSchema.parse({ retryAfter: 60, scope: "ip" }),
    ).toEqual({ retryAfter: 60, scope: "ip" });
    expect(SpacePatchSchema.safeParse({ kind: "shared" }).success).toBe(false);
    // Space names: C0, DEL and bidi controls stripped, then trimmed.
    expect(
      SpaceCreateSchema.parse({
        name: " \u202EEng\u0000\u0007ineer\u2066ing\u200F\u007F\u061C ",
      }).name,
    ).toBe("Engineering");
    expect(SpacePatchSchema.parse({ name: "A\u0009B\u2069" }).name).toBe("AB");
    expect(
      SpacePatchSchema.safeParse({ name: "\u202A\u0000 \u200E" }).success,
    ).toBe(false);
    // Zero-width characters too: ZWSP, ZWNJ, ZWJ and BOM.
    expect(
      SpaceCreateSchema.parse({ name: "\uFEFFEn\u200Bg\u200Cin\u200Deering" })
        .name,
    ).toBe("Engineering");
    expect(
      SpacePatchSchema.safeParse({ name: "\u200B\uFEFF\u200D" }).success,
    ).toBe(false);
    expect(SpaceCreateSchema.parse({ name: "Café 東京" }).name).toBe(
      "Café 東京",
    );
    // "Personal" is reserved for the personal space: trimmed, any case, and
    // after controls are stripped; only the whole name.
    for (const name of [
      "Personal",
      " personal ",
      "PERSONAL",
      "Pers\u200Bonal",
    ]) {
      const r = SpaceCreateSchema.safeParse({ name });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual([
        SPACE_NAME_RESERVED_MESSAGE,
      ]);
      expect(spaceNameReserved(r.error?.issues ?? [])).toBe(true);
      expect(
        spaceNameReserved(
          SpacePatchSchema.safeParse({ name }).error?.issues ?? [],
        ),
      ).toBe(true);
    }
    expect(SpaceNameSchema.parse("Personal finance")).toBe("Personal finance");
    expect(SPACE_NAME_RESERVED_MESSAGE).not.toMatch(/\u2014/);
    expect(
      spaceNameReserved(
        SpaceCreateSchema.safeParse({ name: "" }).error?.issues ?? [],
      ),
    ).toBe(false);
    expect(
      TransferInputSchema.parse({
        to: { kind: "space", spaceId: "s" },
        cursor: "c",
      }),
    ).toEqual({ to: { kind: "space", spaceId: "s" }, cursor: "c" });
    expect(
      MembersQuerySchema.parse({ status: "suspended,removed" }).status,
    ).toEqual(["suspended", "removed"]);
    expect(MembersQuerySchema.parse({}).status).toEqual(["active"]);
    expect(MembersQuerySchema.safeParse({ status: "gone" }).success).toBe(
      false,
    );
    expect(ListQuerySchema.safeParse({ scope: "space" }).success).toBe(false);
    expect(
      ListQuerySchema.parse({ scope: "space", spaceId: "s" }).spaceId,
    ).toBe("s");
    expect(ListQuerySchema.parse({ scope: "spaces" }).scope).toBe("spaces");
    expect(SearchQuerySchema.parse({ q: "x", spaceId: "s" }).spaceId).toBe("s");
    expect(
      TestSessionInputSchema.parse({
        email: "a@b.co",
        role: "member",
        spaces: [{ spaceId: "s", role: "editor" }],
      }).spaces,
    ).toHaveLength(1);
    expect(parseFeatures("guests_read_only,spaces")).toEqual(["spaces"]);
    expect(parseFeatures("spaces, usage_off,bogus,spaces")).toEqual([
      "spaces",
      "usage_off",
    ]);
    expect(TEST_HOOKS_ALLOWED).toBe(false);
  });

  it("parseTier: the three tiers (trimmed), else null", () => {
    for (const t of ["trial", "team", "business"] as const)
      expect(parseTier(t)).toBe(t);
    expect(parseTier(" team ")).toBe("team");
    for (const v of [undefined, "", "Team", "enterprise", "team,business"])
      expect(parseTier(v)).toBeNull();
  });

  it("TIER_FEATURES: settable flags only; Team swaps sync_google for sync_frozen; directoryModeOf", () => {
    for (const fs of Object.values(TIER_FEATURES))
      for (const f of fs) expect(ENV_FEATURE_FLAGS).toContain(f);
    expect(TIER_FEATURES.trial).toEqual(TIER_FEATURES.business);
    const team = new Set(TIER_FEATURES.team);
    const business = new Set(TIER_FEATURES.business);
    expect([...business].filter((f) => !team.has(f))).toEqual(["sync_google"]);
    expect([...team].filter((f) => !business.has(f))).toEqual(["sync_frozen"]);
    expect(parseFeatures(TIER_FEATURES.team.join(","))).toEqual([
      ...TIER_FEATURES.team,
    ]);
    expect(directoryModeOf(TIER_FEATURES.business)).toBe("google");
    expect(directoryModeOf(TIER_FEATURES.team)).toBe("frozen");
    expect(directoryModeOf(["sync_frozen", "sync_google"])).toBe("google");
    expect(directoryModeOf([])).toBe("off");
  });

  it("publish: spaceId is folded into PublishInputSchema and keeps the publish rules", () => {
    const base = { title: "t", format: "html", content: "x" };
    expect(PublishInputSchema.parse({ ...base, spaceId: "s" })).toMatchObject({
      spaceId: "s",
      title: "t",
    });
    expect(PublishInputSchema.safeParse({ spaceId: "s" }).success).toBe(false);
    expect(PublishInputSchema.safeParse({ ...base, spaceId: 1 }).success).toBe(
      false,
    );
  });

  it("artifactCan follows the action table", () => {
    expect(artifactCan("viewer", { personal: false })).toEqual({
      edit: false,
      share: false,
      setVisibility: false,
      delete: false,
      transfer: false,
      move: false,
      dataWrite: true,
    });
    expect(artifactCan("manager", { personal: false }).transfer).toBe(false);
    expect(artifactCan("manager", { personal: false }).move).toBe(true);
    expect(artifactCan("owner", { personal: true }).transfer).toBe(true);
    expect(artifactCan("owner", { personal: true, cap: "guest" })).toEqual({
      edit: false,
      share: false,
      setVisibility: false,
      delete: false,
      transfer: false,
      move: false,
      dataWrite: false,
    });
    expect(
      artifactCan("viewer", { personal: false, cap: "restricted" }).dataWrite,
    ).toBe(false);
  });

  it("schemas: settings flag, Space.can, org mappings, audit action", () => {
    expect(
      SettingsSchema.parse({
        name: "x",
        defaultVisibility: "team",
        spaceManagerMappings: false,
      }).spaceManagerMappings,
    ).toBe(false);
    expect(
      SettingsSchema.parse({ name: "x", defaultVisibility: "team" }),
    ).not.toHaveProperty("spaceManagerMappings");
    expect(SettingsPatchSchema.parse({ spaceManagerMappings: true })).toEqual({
      spaceManagerMappings: true,
    });
    expect(SpaceCanSchema.parse({ manageMappings: true })).toEqual({
      manageMappings: true,
    });
    expect(SPACE_MANAGER_MAPPING_ROLES).toEqual(["viewer", "editor"]);
    expect(AuditEventSchema.shape.action.options).toContain(
      "settings.space_manager_mappings",
    );
    expect(R.orgMappings).toBe("/api/v1/directory/org-mappings");
    expect(R.orgMapping("g/1")).toBe("/api/v1/directory/org-mappings/g%2F1");
  });

  it("schemas: query, page total, groups role/via, details, member_synced", () => {
    expect(SpaceMembersQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(
      SpaceMembersQuerySchema.parse({ q: " bo ", group: "gEng01", limit: "2" }),
    ).toEqual({ q: "bo", group: "gEng01", limit: 2 });
    expect(() => SpaceMembersQuerySchema.parse({ lastSeenAt: "x" })).toThrow();
    expect(
      SpaceMembersPageSchema.parse({ items: [], nextCursor: null, total: 0 }),
    ).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(() =>
      SpaceMemberGroupSchema.parse({
        groupId: "g",
        email: "g@x",
        name: null,
        role: "viewer",
        via: "org",
      }),
    ).toThrow();
    expect(SpaceForbiddenDetailsSchema.parse({ target: "mapping" })).toEqual({
      target: "mapping",
    });
    expect(ERROR_CODES).toContain("member_synced");
    expect(STATUS_FOR.member_synced).toBe(409);
    expect(Object.keys(SpaceMemberSchema.shape).slice(-2)).toEqual([
      "allMembers",
      "restriction",
    ]);
    expect(Object.keys(SpaceMemberSchema.shape)).not.toContain("lastSeenAt");
  });
});
