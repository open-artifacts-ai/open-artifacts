import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorSchema,
  ArtifactSummarySchema,
  AUTH,
  AuditEventSchema,
  AuthProvidersSchema,
  artifactCan,
  CodeRateLimitedDetailsSchema,
  CodeRequestedSchema,
  CodeRequestSchema,
  CodeVerifiedSchema,
  CodeVerifyFailureDetailsSchema,
  DirectoryGroupSchema,
  ERROR_CODES,
  GroupMappingSchema,
  HealthzSchema,
  ListQuerySchema,
  MemberSchema,
  MembersQuerySchema,
  MeSchema,
  normalizeCode,
  PageSchema,
  PublishInputSchema,
  parseFeatures,
  R,
  RestrictedGroupSchema,
  SearchHitSchema,
  SearchQuerySchema,
  SettingsPatchSchema,
  SettingsSchema,
  SPACE_MANAGER_MAPPING_ROLES,
  SpaceCanSchema,
  SpaceCreateSchema,
  SpaceForbiddenDetailsSchema,
  SpaceMemberGroupSchema,
  SpaceMemberSchema,
  SpaceMembersPageSchema,
  SpaceMembersQuerySchema,
  SpacePatchSchema,
  SpaceSchema,
  STATUS_FOR,
  SyncStatusSchema,
  TEST_HOOKS_ALLOWED,
  TestSessionInputSchema,
  TransferInputSchema,
  TransferResultSchema,
  TransferSummarySchema,
} from "../src/index.js";
import { fixtures } from "../src/mocks/fixtures.js";
import { createHandlers } from "../src/mocks/handlers.js";
import { HOSTED_MOCK_CODE } from "../src/mocks/hosted.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const fresh = (o?: Parameters<typeof createHandlers>[0]) =>
  server.use(...createHandlers(o));

const O = "http://localhost";
const H: Record<string, string> = {
  "content-type": "application/json",
  "x-oa-request": "1",
  cookie: "s=1",
};
const call = (method: string, path: string, body?: unknown, headers = H) =>
  fetch(`${O}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const errCode = async (r: Response) =>
  ApiErrorSchema.parse(await r.json()).error;

/** Response schemas made strict: an unexpected key fails the mock tests. */
const Strict = {
  Me: MeSchema.strict(),
  ArtifactSummary: ArtifactSummarySchema.strict(),
  SearchHit: SearchHitSchema.strict(),
  Space: SpaceSchema.strict(),
  SpaceMember: SpaceMemberSchema.strict(),
  GroupMapping: GroupMappingSchema.strict(),
  SyncStatus: SyncStatusSchema.strict(),
  TransferSummary: TransferSummarySchema.strict(),
  TransferResult: TransferResultSchema.strict(),
  CodeVerified: CodeVerifiedSchema.strict(),
  CodeRequested: CodeRequestedSchema.strict(),
  AuthProviders: AuthProvidersSchema.strict(),
  Member: MemberSchema.strict(),
  RestrictedGroup: RestrictedGroupSchema.strict(),
  DirectoryGroup: DirectoryGroupSchema.strict(),
  AuditEvent: AuditEventSchema.strict(),
};

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
});

describe("hosted off: responses are byte-identical", () => {
  it("me, list, members, search carry no hosted fields", async () => {
    fresh();
    expect(await (await call("GET", R.me)).text()).toBe(
      JSON.stringify(fixtures.me),
    );
    expect(await (await call("GET", R.members)).text()).toBe(
      JSON.stringify(fixtures.members),
    );
    const list = await (await call("GET", `${R.artifacts}?limit=100`)).text();
    expect(list).toBe(
      JSON.stringify({ items: fixtures.artifacts, nextCursor: null }),
    );
    for (const k of ['"space"', '"can"', '"status"', '"hosted"', '"auth"'])
      expect(list).not.toContain(k);
  });
});

describe("hosted mocks", () => {
  it("providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal", async () => {
    fresh({ hosted: true });
    const p = Strict.AuthProviders.parse(
      await json(await call("GET", AUTH.providers)),
    );
    expect(p.mode).toBe("direct");
    expect(p.providers.map((x) => x.id)).toEqual(["google", "email"]);

    const rq = await call("POST", AUTH.codeRequest, {
      email: "Ada@example.com",
      next: "/a/x",
    });
    expect(rq.status).toBe(202);
    expect(Strict.CodeRequested.parse(await rq.json())).toEqual({
      maskedEmail: "a***@example.com",
      expiresIn: 600,
      resendAfter: 60,
      codeLength: 8,
    });
    const bad = await call("POST", AUTH.codeVerify, { code: "0000 0000" });
    expect(bad.status).toBe(401);
    expect((await errCode(bad)).details).toEqual({
      reason: "invalid_code",
      attemptsLeft: 4,
    });
    const ok = await call("POST", AUTH.codeVerify, {
      code: `${HOSTED_MOCK_CODE.slice(0, 4)} ${HOSTED_MOCK_CODE.slice(4)}`,
    });
    expect(ok.status).toBe(200);
    const v = Strict.CodeVerified.parse(await ok.json());
    expect(v).toMatchObject({ next: "/a/x", readOnly: false });
    expect(v.user.email).toBe("ada@example.com");

    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.hosted).toBe(true);
    expect(me.instance.tier).toBe("business");
    expect(me.instance.features).toContain("usage_off");
    expect(me.instance.directory).toMatchObject({
      mode: "google",
      healthy: true,
      banner: false,
    });
    expect(me.auth).toMatchObject({
      method: "code",
      readOnly: false,
      cap: null,
    });
    expect(me.personalSpaceId).toBe(me.user.id);
    expect(me.spaces?.map((s) => [s.name, s.myRole])).toEqual([
      ["Engineering", "manager"],
      ["Exec", "viewer"],
    ]);

    const list = PageSchema(Strict.ArtifactSummary).parse(
      await json(await call("GET", `${R.artifacts}?limit=100`)),
    );
    const notes = list.items.find((a) => a.title === "Meeting notes");
    expect(notes?.access).toBe("manager");
    expect(notes?.space).toMatchObject({ kind: "shared", name: "Engineering" });
    expect(notes?.can).toMatchObject({ move: true, transfer: false });
    const mine = list.items.find((a) => a.title === "Landing page");
    expect(mine?.space).toMatchObject({ kind: "personal", id: me.user.id });
    expect(mine?.can?.transfer).toBe(true);
    const viewer = list.items.find((a) => a.access === "viewer");
    expect(viewer?.can).toMatchObject({ edit: false, dataWrite: true });
    const hits = PageSchema(Strict.SearchHit).parse(
      await json(await call("GET", `${R.search}?q=notes`)),
    );
    expect(hits.items[0]?.space?.name).toBe("Engineering");

    // Move: one's own personal space is refused, someone else's is 404; a
    // viewer-role space is forbidden; Engineering works.
    const bob = fixtures.members[1]?.id as string;
    const toBob = await call("POST", R.moveArtifact(mine?.id as string), {
      spaceId: bob,
    });
    expect(toBob.status).toBe(404);
    const toPersonal = await call("POST", R.moveArtifact(mine?.id as string), {
      spaceId: me.user.id,
    });
    expect(toPersonal.status).toBe(400);
    expect((await errCode(toPersonal)).code).toBe("space_personal");
    const exec = me.spaces?.find((s) => s.name === "Exec")?.id as string;
    const forbidden = await call("POST", R.moveArtifact(mine?.id as string), {
      spaceId: exec,
    });
    expect(forbidden.status).toBe(403);
    expect((await errCode(forbidden)).code).toBe("space_forbidden");
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const moved = Strict.ArtifactSummary.parse(
      await json(
        await call("POST", R.moveArtifact(mine?.id as string), {
          spaceId: eng,
        }),
      ),
    );
    expect(moved).toMatchObject({ access: "manager", space: { id: eng } });
  });

  it("code flow: no_pending, expiry after 5 tries, turnstile, rate limits", async () => {
    fresh({ hosted: { turnstile: true } });
    const none = await call("POST", AUTH.codeVerify, { code: "1" });
    expect((await errCode(none)).details).toEqual({ reason: "no_pending" });
    const missing = await call("POST", AUTH.codeRequest, {
      email: "x@example.com",
    });
    expect(missing.status).toBe(400);
    expect(await errCode(missing)).toMatchObject({
      code: "turnstile_required",
      details: { field: "turnstile", required: true },
    });
    const rejected = await call("POST", AUTH.codeRequest, {
      email: "x@example.com",
      turnstileToken: "fail",
    });
    expect((await errCode(rejected)).code).toBe("turnstile_failed");
    const req = { email: "g@outside.org", turnstileToken: "ok" };
    expect((await call("POST", AUTH.codeRequest, req)).status).toBe(202);
    for (let i = 0; i < 4; i++)
      await call("POST", AUTH.codeVerify, { code: "11111111" });
    const dead = await call("POST", AUTH.codeVerify, { code: "11111111" });
    expect((await errCode(dead)).details).toEqual({ reason: "expired" });
    for (let i = 0; i < 4; i++) await call("POST", AUTH.codeRequest, req);
    const limited = await call("POST", AUTH.codeRequest, req);
    expect(limited.status).toBe(429);
    expect(
      CodeRateLimitedDetailsSchema.parse((await errCode(limited)).details)
        .scope,
    ).toBe("email");
  });

  it("guest sign-in is read-only and can't publish", async () => {
    fresh({ hosted: true });
    await call("POST", AUTH.codeRequest, { email: "guest@outside.org" });
    const v = Strict.CodeVerified.parse(
      await json(
        await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE }),
      ),
    );
    expect(v.user.role).toBe("guest");
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.auth).toMatchObject({ readOnly: true, cap: "guest" });
    const list = await json(await call("GET", R.artifacts));
    expect(list.items[0].can.dataWrite).toBe(false);
    const pub = await call("POST", R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
    });
    expect((await errCode(pub)).code).toBe("space_forbidden");
  });

  it("spaces, members, mappings, directory, transfer", async () => {
    fresh({ hosted: true });
    const spaces = PageSchema(Strict.Space).parse(
      await json(await call("GET", R.spaces)),
    );
    expect(spaces.items[0]?.kind).toBe("personal");
    const clients = spaces.items.find((s) => s.name === "Clients");
    expect(clients?.myRole).toBeNull();
    const created = Strict.Space.parse(
      await json(await call("POST", R.spaces, { name: "Sales" })),
    );
    expect(created).toMatchObject({
      kind: "shared",
      publicLinks: true,
      myRole: null,
    });
    const bob = fixtures.members[1]?.id as string;
    const m = Strict.SpaceMember.parse(
      await json(
        await call("PUT", R.spaceMember(created.id, bob), { role: "editor" }),
      ),
    );
    expect(m).toMatchObject({ userId: bob, role: "editor", source: "manual" });
    expect(
      Strict.GroupMapping.parse(
        await json(
          await call("PUT", R.spaceMapping(created.id, "gSales03"), {
            role: "viewer",
          }),
        ),
      ).name,
    ).toBe("Sales");
    const patched = Strict.Space.parse(
      await json(
        await call("PATCH", R.space(created.id), { publicLinks: false }),
      ),
    );
    expect(patched.publicLinks).toBe(false);
    expect((await call("DELETE", R.space(created.id))).status).toBe(204);
    const personal = await call(
      "PATCH",
      R.space(fixtures.members[0]?.id as string),
      { name: "x" },
    );
    expect((await errCode(personal)).code).toBe("space_personal");

    const st = Strict.SyncStatus.parse(
      await json(await call("GET", R.directory)),
    );
    expect(st).toMatchObject({
      mode: "google",
      healthy: true,
      customerMismatch: null,
    });
    expect(st.held).toHaveLength(1);
    expect(
      (await call("POST", R.directoryHeldConfirm("gSales03"))).status,
    ).toBe(202);
    expect((await call("POST", R.directorySync)).status).toBe(202);

    const departed = await json(
      await call("GET", `${R.members}?status=suspended,removed`),
    );
    expect(departed.map((x: { status: string }) => x.status)).toEqual([
      "suspended",
    ]);
    const carol = departed[0].id as string;
    expect(
      Strict.TransferSummary.parse(
        await json(await call("GET", R.memberTransfer(carol))),
      ),
    ).toEqual({
      live: 2,
      deleted: 1,
    });
    const toPersonal = await call("POST", R.memberTransfer(carol), {
      to: { kind: "space", spaceId: bob },
    });
    expect((await errCode(toPersonal)).code).toBe("space_personal");
    const toCarol = await call("POST", R.memberTransfer(carol), {
      to: { kind: "user", userId: carol },
    });
    expect((await errCode(toCarol)).code).toBe("invalid_successor");
    expect(
      Strict.TransferResult.parse(
        await json(
          await call("POST", R.memberTransfer(carol), {
            to: { kind: "user", userId: bob },
          }),
        ),
      ),
    ).toEqual({ moved: 3, remaining: 0, nextCursor: null });
    const active = await call("POST", R.memberTransfer(bob), {
      to: { kind: "user", userId: bob },
    });
    expect((await errCode(active)).code).toBe("member_active");
    expect((await call("GET", R.usage)).status).toBe(404);
  });

  it("frozen sync refuses mapping changes; unhealthy shows the banner", async () => {
    fresh({ hosted: { directory: "frozen", unhealthy: true } });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.directory).toMatchObject({
      mode: "frozen",
      healthy: false,
      banner: true,
      tokensUnverified: true,
    });
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const r = await call("PUT", R.spaceMapping(eng, "x@example.com"), {
      role: "viewer",
    });
    expect(r.status).toBe(409);
    expect((await errCode(r)).code).toBe("directory_sync_off");
  });

  it("transfer of a personal artifact and spaceId on publish", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const exec = me.spaces?.find((s) => s.name === "Exec")?.id as string;
    const base = { title: "n", format: "html", content: "x" };
    expect(
      (await call("POST", R.artifacts, { ...base, spaceId: eng })).status,
    ).toBe(201);
    const forbidden = await call("POST", R.artifacts, {
      ...base,
      spaceId: exec,
    });
    expect((await errCode(forbidden)).code).toBe("space_forbidden");
    const id = fixtures.artifacts[0]?.id as string;
    const useMove = await call("POST", R.artifacts, {
      ...base,
      id,
      spaceId: eng,
    });
    expect((await errCode(useMove)).code).toBe("use_move");
    const bob = fixtures.members[1]?.id as string;
    const t = Strict.ArtifactSummary.parse(
      await json(await call("POST", R.transferArtifact(id), { userId: bob })),
    );
    expect(t).toMatchObject({
      access: "editor",
      space: { id: bob },
      owner: { id: bob },
    });
    expect(
      z.array(Strict.Member).parse(await json(await call("GET", R.members)))[0]
        ?.status,
    ).toBe("active");
  });
});

describe("hosted mocks: restriction, public links, admin self-add, audit", () => {
  const signIn = async (email: string) => {
    await call("POST", AUTH.codeRequest, { email });
    return Strict.CodeVerified.parse(
      await json(
        await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE }),
      ),
    );
  };

  it("a restricted-group member is capped and gets no allMembersRole", async () => {
    fresh({ hosted: true });
    const v = await signIn("dan@example.com");
    expect(v.readOnly).toBe(true);
    expect(v.user.restriction?.groups.map((g) => g.groupId)).toEqual([
      "gCon04",
    ]);
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.auth).toMatchObject({ readOnly: true, cap: "restricted" });
    // Engineering has allMembersRole viewer, which never reaches Dan.
    expect(me.spaces).toEqual([]);
    const pub = await call("POST", R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
    });
    expect((await errCode(pub)).code).toBe("space_forbidden");
  });

  it("manual restricted flag: cap on space members, no successor, audited", async () => {
    fresh({ hosted: { directory: "frozen" } });
    const bob = fixtures.members[1]?.id as string;
    const set = Strict.Member.parse(
      await json(await call("PUT", R.memberRestricted(bob))),
    );
    expect(set.restriction).toEqual({ manual: true, groups: [] });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const ms = PageSchema(Strict.SpaceMember).parse(
      await json(await call("GET", R.spaceMembers(eng))),
    );
    expect(ms.items.find((m) => m.userId === bob)?.cap).toBe("restricted");
    const id = fixtures.artifacts[0]?.id as string;
    const t = await call("POST", R.transferArtifact(id), { userId: bob });
    expect((await errCode(t)).code).toBe("invalid_successor");
    const cleared = Strict.Member.parse(
      await json(await call("DELETE", R.memberRestricted(bob))),
    );
    expect(cleared.restriction).toBeNull();
    const audit = PageSchema(Strict.AuditEvent).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items.map((e) => e.action)).toEqual([
      "restricted.remove",
      "restricted.set",
    ]);
  });

  it("restricted groups by groupId: PUT 409 when frozen, DELETE allowed", async () => {
    fresh({ hosted: { directory: "frozen" } });
    const list = z
      .array(Strict.RestrictedGroup)
      .parse(await json(await call("GET", R.restrictedGroups)));
    expect(list.map((g) => g.groupId)).toEqual(["gCon04"]);
    const put = await call("PUT", R.restrictedGroup("gSales03"));
    expect((await errCode(put)).code).toBe("directory_sync_off");
    expect((await call("DELETE", R.restrictedGroup("gCon04"))).status).toBe(
      204,
    );
  });

  it("restricted groups and the group picker with sync on", async () => {
    fresh({ hosted: true });
    const g = Strict.RestrictedGroup.parse(
      await json(await call("PUT", R.restrictedGroup("gSales03"))),
    );
    expect(g).toMatchObject({
      groupId: "gSales03",
      email: "sales@example.com",
    });
    expect((await call("PUT", R.restrictedGroup("nope"))).status).toBe(404);
    const picker = PageSchema(Strict.DirectoryGroup).parse(
      await json(await call("GET", `${R.directoryGroups}?q=eng`)),
    );
    expect(picker.items.map((x) => x.groupId)).toEqual(["gEng01"]);
  });

  it("public in a space with publicLinks off is 403 public_links_off", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.spaces?.find((s) => s.name === "Exec")?.publicLinks).toBe(false);
    // The caller manages Engineering ("Meeting notes"); turn its public links off.
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    expect(
      (await call("PATCH", R.space(eng), { publicLinks: false })).status,
    ).toBe(200);
    const notes = fixtures.artifacts.find((a) => a.title === "Meeting notes")
      ?.id as string;
    const r = await call("PATCH", R.artifact(notes), { visibility: "public" });
    expect(r.status).toBe(403);
    expect((await errCode(r)).code).toBe("public_links_off");
    const create = await call("POST", R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
      spaceId: eng,
      visibility: "public",
    });
    expect((await errCode(create)).code).toBe("public_links_off");
  });

  it("public links off keeps an existing public artifact public (no rewrite)", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const notes = fixtures.artifacts.find((a) => a.title === "Meeting notes")
      ?.id as string;
    expect(
      (await call("PATCH", R.artifact(notes), { visibility: "public" })).status,
    ).toBe(200);
    expect(
      (await call("PATCH", R.space(eng), { publicLinks: false })).status,
    ).toBe(200);
    const a = await json(await call("GET", R.artifact(notes)));
    expect(a).toMatchObject({
      visibility: "public",
      space: { id: eng, publicLinks: false },
    });
    // Echoing "public" on it passes (agents resend it); only a change is refused.
    expect(
      (await call("PATCH", R.artifact(notes), { visibility: "public" })).status,
    ).toBe(200);
    expect(
      (
        await call("POST", R.artifacts, {
          id: notes,
          format: "html",
          content: "y",
          visibility: "public",
        })
      ).status,
    ).toBe(201);
  });

  it("space members: personal space 400 space_personal; PUT needs an existing, active target", async () => {
    fresh({ hosted: true });
    const ada = fixtures.members[0]?.id as string;
    expect((await errCode(await call("GET", R.spaceMembers(ada)))).code).toBe(
      "space_personal",
    );
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    // Carol is suspended; the other id names nobody.
    for (const userId of ["Cr7tNpQrSt8uVwXy", "Zz0nobodyZz0abcd"])
      expect(
        (await call("PUT", R.spaceMember(eng, userId), { role: "viewer" }))
          .status,
      ).toBe(404);
    const bob = fixtures.members[1]?.id as string;
    expect(
      (await call("PUT", R.spaceMember(eng, bob), { role: "viewer" })).status,
    ).toBe(200);
  });

  it("admin self-add to a shared space only, audited", async () => {
    fresh({ hosted: true });
    const spaces = PageSchema(Strict.Space).parse(
      await json(await call("GET", R.spaces)),
    );
    const clients = spaces.items.find((s) => s.name === "Clients")
      ?.id as string;
    const r = await call("POST", R.spaceMemberSelf(clients), {
      role: "viewer",
    });
    expect(r.status).toBe(201);
    expect(Strict.SpaceMember.parse(await r.json())).toMatchObject({
      role: "viewer",
    });
    const personal = await call(
      "POST",
      R.spaceMemberSelf(fixtures.members[0]?.id as string),
      { role: "viewer" },
    );
    expect((await errCode(personal)).code).toBe("space_personal");
    const audit = PageSchema(Strict.AuditEvent).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items[0]).toMatchObject({
      action: "space.admin_self_add",
      spaceId: clients,
    });
  });

  it("guests_read_only is reported from sign-in config, never from FEATURES", async () => {
    fresh({ hosted: { mode: "access", features: ["guests_read_only"] } });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.features).not.toContain("guests_read_only");
    server.resetHandlers();
    fresh({ hosted: true });
    const me2 = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me2.instance.features).toContain("guests_read_only");
  });
});

describe("hosted mocks: move and public links", () => {
  it("moving a public artifact into a space with publicLinks off makes it team", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    expect(
      (await call("PATCH", R.space(eng), { publicLinks: false })).status,
    ).toBe(200);
    const report = fixtures.artifacts.find((a) => a.title === "Q4 report");
    expect(report?.visibility).toBe("public");
    const moved = Strict.ArtifactSummary.parse(
      await json(
        await call("POST", R.moveArtifact(report?.id as string), {
          spaceId: eng,
        }),
      ),
    );
    expect(moved).toMatchObject({
      visibility: "team",
      space: { id: eng, publicLinks: false },
    });
  });
});

describe("hosted mocks: owners and admins can't be restricted", () => {
  it("PUT memberRestricted on the owner or an admin is 400 restrict_admin", async () => {
    fresh({ hosted: true });
    const owner = fixtures.members[0]?.id as string;
    const r = await call("PUT", R.memberRestricted(owner));
    expect(r.status).toBe(400);
    expect((await errCode(r)).code).toBe("restrict_admin");
    const bob = fixtures.members[1]?.id as string;
    expect((await call("PATCH", R.member(bob), { role: "admin" })).status).toBe(
      200,
    );
    const admin = await call("PUT", R.memberRestricted(bob));
    expect((await errCode(admin)).code).toBe("restrict_admin");
    const ms = z
      .array(Strict.Member)
      .parse(await json(await call("GET", R.members)));
    expect(ms.find((m) => m.id === bob)?.restriction).toBeNull();
  });
});

describe("hosted mocks: sync banner fields", () => {
  it("admins see state, staleAt and held sweeps", async () => {
    fresh({ hosted: { unhealthy: true, unhealthyState: "scope_missing" } });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const d = me.instance.directory;
    expect(d).toMatchObject({
      state: "scope_missing",
      heldSweeps: 1,
      banner: true,
    });
    const st = Strict.SyncStatus.parse(
      await json(await call("GET", R.directory)),
    );
    expect(st.state).toBe("scope_missing");
    expect(d?.staleAt).toBe(st.staleAt);
    expect(
      Date.parse(d?.staleAt as string) - Date.parse(st.lastSuccessAt as string),
    ).toBe(7 * 24 * 3600_000);
  });

  it("members can't read health", async () => {
    fresh({ hosted: { unhealthy: true } });
    await call("POST", AUTH.codeRequest, { email: "bob@example.com" });
    await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.directory).toMatchObject({
      state: null,
      staleAt: null,
      heldSweeps: 0,
      banner: false,
      tokensUnverified: false,
    });
  });
});

describe("hosted contract: space-manager and Every-space mappings", () => {
  const signIn = async (email: string) => {
    await call("POST", AUTH.codeRequest, { email });
    await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE });
  };
  const ENG = "SpEngNpQrSt2uVwX";
  const CLIENTS = "SpCliNpQrSt4uVwX";
  const ada = fixtures.members[0]?.id as string;
  const bob = fixtures.members[1]?.id as string;
  /** As Ada (owner): make Bob a manager of Engineering, then sign in as Bob. */
  const bobManagesEng = async () => {
    await call("PUT", R.spaceMember(ENG, bob), { role: "manager" });
    await signIn("bob@example.com");
  };

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

  it("settings: spaceManagerMappings defaults on; PATCH is admin-only and audited", async () => {
    fresh({ hosted: true });
    const s = SettingsSchema.strict().parse(
      await json(await call("GET", R.settings)),
    );
    expect(s.spaceManagerMappings).toBe(true);
    const off = SettingsSchema.strict().parse(
      await json(
        await call("PATCH", R.settings, { spaceManagerMappings: false }),
      ),
    );
    expect(off.spaceManagerMappings).toBe(false);
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance).not.toHaveProperty("spaceManagerMappings");
    const audit = PageSchema(AuditEventSchema).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items[0]).toMatchObject({
      action: "settings.space_manager_mappings",
      detail: { spaceManagerMappings: false },
    });
    await signIn("bob@example.com");
    expect(
      (await call("PATCH", R.settings, { spaceManagerMappings: true })).status,
    ).toBe(404);
  });

  it("hosted off: settings carry no spaceManagerMappings", async () => {
    fresh();
    expect(await (await call("GET", R.settings)).text()).not.toContain(
      "spaceManagerMappings",
    );
  });

  it("a space manager maps viewer/editor; manager is space_forbidden", async () => {
    fresh({ hosted: true });
    await bobManagesEng();
    const sp = Strict.Space.parse(await json(await call("GET", R.space(ENG))));
    expect(sp.can).toEqual({ manageMappings: true });
    expect(
      z
        .array(Strict.GroupMapping)
        .parse(await json(await call("GET", R.spaceMappings(ENG)))),
    ).toHaveLength(1);
    const ok = Strict.GroupMapping.parse(
      await json(
        await call("PUT", R.spaceMapping(ENG, "gSales03"), { role: "viewer" }),
      ),
    );
    expect(ok).toMatchObject({ groupId: "gSales03", role: "viewer" });
    const mgr = await call("PUT", R.spaceMapping(ENG, "gSales03"), {
      role: "manager",
    });
    expect(mgr.status).toBe(403);
    expect((await errCode(mgr)).code).toBe("space_forbidden");
    // Exec: Bob has no role there, so mapping routes stay 404.
    expect(
      (
        await call("PUT", R.spaceMapping("SpExcNpQrSt3uVwX", "gSales03"), {
          role: "viewer",
        })
      ).status,
    ).toBe(404);
    expect((await call("DELETE", R.spaceMapping(ENG, "gSales03"))).status).toBe(
      204,
    );
    // Bob's own personal space: mappings don't exist there.
    const personal = await call("GET", R.spaceMappings(bob));
    expect(personal.status).toBe(400);
    expect((await errCode(personal)).code).toBe("space_personal");
  });

  it("a space manager can't change or remove a manager-role row an admin set", async () => {
    fresh({ hosted: true });
    await call("PUT", R.spaceMapping(ENG, "gSales03"), { role: "manager" });
    await bobManagesEng();
    const demote = await call("PUT", R.spaceMapping(ENG, "gSales03"), {
      role: "viewer",
    });
    expect(demote.status).toBe(403);
    expect((await errCode(demote)).code).toBe("space_forbidden");
    const del = await call("DELETE", R.spaceMapping(ENG, "gSales03"));
    expect((await errCode(del)).code).toBe("space_forbidden");
  });

  it("setting off: a manager's PUT is 403 directory_mapping_off; list and remove still work", async () => {
    fresh({ hosted: true });
    await call("PATCH", R.settings, { spaceManagerMappings: false });
    const eng = Strict.Space.parse(await json(await call("GET", R.space(ENG))));
    expect(eng.can).toEqual({ manageMappings: true });
    await bobManagesEng();
    const sp = Strict.Space.parse(await json(await call("GET", R.space(ENG))));
    expect(sp.can).toEqual({ manageMappings: false });
    const r = await call("PUT", R.spaceMapping(ENG, "gSales03"), {
      role: "viewer",
    });
    expect(r.status).toBe(403);
    expect((await errCode(r)).code).toBe("directory_mapping_off");
    expect(
      z
        .array(Strict.GroupMapping)
        .parse(await json(await call("GET", R.spaceMappings(ENG)))),
    ).toEqual([expect.objectContaining({ groupId: "gEng01" })]);
    expect((await call("DELETE", R.spaceMapping(ENG, "gEng01"))).status).toBe(
      204,
    );
  });

  it("an Every-space mapping is an effective role in every shared space, never Personal", async () => {
    fresh({ hosted: true });
    expect(
      PageSchema(Strict.GroupMapping).parse(
        await json(await call("GET", R.orgMappings)),
      ),
    ).toEqual({ items: [], nextCursor: null });
    const m = Strict.GroupMapping.parse(
      await json(await call("PUT", R.orgMapping("gEng01"), { role: "editor" })),
    );
    expect(m).toMatchObject({ groupId: "gEng01", role: "editor" });
    // One row per group: a second PUT updates it.
    await call("PUT", R.orgMapping("gEng01"), { role: "editor" });
    expect(
      PageSchema(Strict.GroupMapping).parse(
        await json(await call("GET", `${R.orgMappings}?limit=1`)),
      ).items,
    ).toHaveLength(1);
    // Not expanded into per-space mapping rows.
    expect(await json(await call("GET", R.spaceMappings(CLIENTS)))).toEqual([]);
    const members = PageSchema(Strict.SpaceMember).parse(
      await json(await call("GET", R.spaceMembers(CLIENTS))),
    );
    expect(members.items).toEqual([
      expect.objectContaining({
        userId: bob,
        role: "editor",
        source: "sync",
        syncRole: "editor",
      }),
    ]);
    await signIn("bob@example.com");
    const clients = Strict.Space.parse(
      await json(await call("GET", R.space(CLIENTS))),
    );
    expect(clients.myRole).toBe("editor");
    expect(clients.can).toEqual({ manageMappings: false });
    // Personal spaces: Bob's own stays manager; Ada's stays invisible.
    expect(
      Strict.Space.parse(await json(await call("GET", R.space(bob)))).myRole,
    ).toBe("manager");
    expect((await call("GET", R.space(ada))).status).toBe(404);
    expect((await call("GET", R.orgMappings)).status).toBe(404);
  });

  it("org mappings: DELETE, sync off, audit", async () => {
    fresh({ hosted: true });
    await call("PUT", R.orgMapping("gEng01"), { role: "viewer" });
    expect((await call("DELETE", R.orgMapping("gEng01"))).status).toBe(204);
    expect((await call("DELETE", R.orgMapping("gEng01"))).status).toBe(404);
    const audit = PageSchema(AuditEventSchema).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items.slice(0, 2)).toEqual([
      expect.objectContaining({ action: "mapping.remove", spaceId: null }),
      expect.objectContaining({ action: "mapping.set", spaceId: null }),
    ]);
    fresh({ hosted: { directory: "frozen" } });
    const r = await call("PUT", R.orgMapping("gEng01"), { role: "viewer" });
    expect((await errCode(r)).code).toBe("directory_sync_off");
  });
});

describe("hosted contract: space People", () => {
  const signIn = async (email: string) => {
    await call("POST", AUTH.codeRequest, { email });
    await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE });
  };
  const ENG = "SpEngNpQrSt2uVwX";
  const EXEC = "SpExcNpQrSt3uVwX";
  const ada = fixtures.members[0]?.id as string;
  const bob = fixtures.members[1]?.id as string;
  const dan = "Dn8uPqRsTu9vWxYz";
  const StrictMember = SpaceMemberSchema.extend({
    groups: z.array(SpaceMemberGroupSchema.strict()),
  }).strict();
  const StrictPage = SpaceMembersPageSchema.extend({
    items: z.array(StrictMember),
  }).strict();
  const list = async (space: string, qs = "") =>
    StrictPage.parse(
      await json(await call("GET", `${R.spaceMembers(space)}${qs}`)),
    );
  const forbidden = async (r: Response) => {
    expect(r.status).toBe(403);
    const e = await errCode(r);
    expect(e.code).toBe("space_forbidden");
    return SpaceForbiddenDetailsSchema.strict().parse(e.details).target;
  };

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
    expect(Object.keys(SpaceMemberSchema.shape).at(-1)).toBe("allMembers");
    expect(Object.keys(SpaceMemberSchema.shape)).not.toContain("lastSeenAt");
  });

  it("members: groups role/via, allMembers, total, q and group filters", async () => {
    fresh({ hosted: true });
    // Dan is restricted: no allMembers.
    await call("PUT", R.spaceMember(ENG, dan), { role: "editor" });
    const all = await list(ENG);
    expect(all.total).toBe(3);
    const by = (id: string) => all.items.find((m) => m.userId === id);
    expect(by(bob)).toMatchObject({
      syncRole: "editor",
      groups: [
        {
          groupId: "gEng01",
          email: "eng@example.com",
          role: "editor",
          via: "space",
        },
      ],
      allMembers: "viewer",
    });
    expect(by(ada)).toMatchObject({
      manualRole: "manager",
      allMembers: "viewer",
    });
    expect(by(dan)).toMatchObject({ cap: "restricted", allMembers: null });
    // Paging keeps the filtered total.
    const p1 = await list(ENG, "?limit=1");
    expect(p1.items).toHaveLength(1);
    expect(p1.total).toBe(3);
    expect(p1.nextCursor).not.toBeNull();
    // q: name or email prefix, case-insensitive.
    expect((await list(ENG, "?q=BO")).items.map((m) => m.userId)).toEqual([
      bob,
    ]);
    expect((await list(ENG, "?q=ada%40")).items.map((m) => m.userId)).toEqual([
      ada,
    ]);
    // Any word of the name: "build" finds Bob Builder; mid-word doesn't.
    expect((await list(ENG, "?q=build")).items.map((m) => m.userId)).toEqual([
      bob,
    ]);
    expect((await list(ENG, "?q=uilder")).total).toBe(0);
    const eng = await list(ENG, "?group=gEng01");
    expect(eng.items.map((m) => m.userId)).toEqual([bob]);
    expect(eng.total).toBe(1);
    expect((await call("GET", `${R.spaceMembers(ENG)}?bogus=1`)).status).toBe(
      400,
    );
    // An Every-space mapping shows as via "every".
    await call("PUT", R.orgMapping("gEng01"), { role: "viewer" });
    expect((await list(ENG, "?group=gEng01")).items[0]?.groups).toEqual([
      expect.objectContaining({
        groupId: "gEng01",
        role: "editor",
        via: "space",
      }),
      expect.objectContaining({
        groupId: "gEng01",
        role: "viewer",
        via: "every",
      }),
    ]);
  });

  it("a space manager can't grant or change Manager on a member (target member); mappings say target mapping", async () => {
    fresh({ hosted: true });
    await call("PUT", R.spaceMember(ENG, bob), { role: "manager" });
    await signIn("bob@example.com");
    expect(
      await forbidden(
        await call("PUT", R.spaceMember(ENG, dan), { role: "manager" }),
      ),
    ).toBe("member");
    // Ada is a manager by hand: demoting her is changing the Manager role.
    expect(
      await forbidden(
        await call("PUT", R.spaceMember(ENG, ada), { role: "viewer" }),
      ),
    ).toBe("member");
    expect(
      StrictMember.parse(
        await json(
          await call("PUT", R.spaceMember(ENG, dan), { role: "editor" }),
        ),
      ),
    ).toMatchObject({ userId: dan, manualRole: "editor" });
    expect(
      await forbidden(
        await call("PUT", R.spaceMapping(ENG, "gSales03"), { role: "manager" }),
      ),
    ).toBe("mapping");
  });

  it("a space manager can't change or remove a peer manager (403 target member); org admins can", async () => {
    for (const directory of ["google", "frozen"] as const) {
      fresh({ hosted: { directory } });
      // Bob becomes a manager of Engineering, where Ada is manager by hand.
      await call("PUT", R.spaceMember(ENG, bob), { role: "manager" });
      await call("PUT", R.spaceMember(ENG, dan), { role: "manager" });
      // Org admin (Ada) changes and removes a manager: allowed.
      expect(
        (await call("PUT", R.spaceMember(ENG, dan), { role: "editor" })).status,
      ).toBe(200);
      expect((await call("DELETE", R.spaceMember(ENG, dan))).status).toBe(204);
      await signIn("bob@example.com");
      expect(
        await forbidden(
          await call("PUT", R.spaceMember(ENG, ada), { role: "viewer" }),
        ),
      ).toBe("member");
      expect(
        await forbidden(await call("DELETE", R.spaceMember(ENG, ada))),
      ).toBe("member");
    }
  });

  it("PUT member validates the body before the target (400, not 404)", async () => {
    fresh({ hosted: true });
    const r = await call("PUT", R.spaceMember(ENG, "Zz0nobodyZz0abcd"), {
      role: "owner",
    });
    expect(r.status).toBe(400);
  });

  it("PATCH space audits space.update only when name or allMembersRole changes", async () => {
    fresh({ hosted: true });
    await call("PATCH", R.space(ENG), { publicLinks: false });
    await call("PATCH", R.space(ENG), { name: "Engineering" });
    const actions = async () =>
      PageSchema(Strict.AuditEvent)
        .parse(await json(await call("GET", R.audit)))
        .items.map((e) => e.action);
    expect(await actions()).toEqual(["space.public_links"]);
    await call("PATCH", R.space(ENG), { name: "Eng" });
    expect(await actions()).toEqual(["space.update", "space.public_links"]);
  });

  it("live sync: DELETE on a synced-only row is 409 member_synced", async () => {
    fresh({ hosted: true });
    const r = await call("DELETE", R.spaceMember(ENG, bob));
    expect(r.status).toBe(409);
    expect((await errCode(r)).code).toBe("member_synced");
    expect((await list(ENG)).items.map((m) => m.userId)).toContain(bob);
  });

  it("frozen sync: raising a synced row is a manual grant (managers up to editor, admins any)", async () => {
    fresh({ hosted: { directory: "frozen" } });
    // Admin raises Bob's synced editor (Engineering) to manager.
    expect(
      StrictMember.parse(
        await json(
          await call("PUT", R.spaceMember(ENG, bob), { role: "manager" }),
        ),
      ),
    ).toMatchObject({
      role: "manager",
      source: "manual",
      manualRole: "manager",
      syncRole: null,
      groups: [],
    });
    // Bob, now a manager, works on Ada's synced viewer row in Exec.
    await call("PUT", R.spaceMember(EXEC, bob), { role: "manager" });
    await signIn("bob@example.com");
    expect(
      await forbidden(
        await call("PUT", R.spaceMember(EXEC, ada), { role: "manager" }),
      ),
    ).toBe("member");
    expect(
      StrictMember.parse(
        await json(
          await call("PUT", R.spaceMember(EXEC, ada), { role: "editor" }),
        ),
      ),
    ).toMatchObject({
      role: "editor",
      source: "manual",
      manualRole: "editor",
      syncRole: null,
    });
  });

  it("frozen sync: DELETE removes a synced row; PUT may lower (manual override); audited", async () => {
    fresh({ hosted: { directory: "frozen" } });
    const low = StrictMember.parse(
      await json(
        await call("PUT", R.spaceMember(ENG, bob), { role: "viewer" }),
      ),
    );
    expect(low).toMatchObject({
      role: "viewer",
      source: "manual",
      manualRole: "viewer",
      syncRole: null,
      groups: [],
    });
    expect((await call("DELETE", R.spaceMember(EXEC, ada))).status).toBe(204);
    expect((await list(EXEC)).items).toEqual([]);
    const audit = PageSchema(AuditEventSchema).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items.slice(0, 2)).toEqual([
      expect.objectContaining({
        action: "space.member.remove",
        spaceId: EXEC,
        detail: { syncFrozen: true },
      }),
      expect.objectContaining({
        action: "space.member.role",
        spaceId: ENG,
        detail: { syncFrozen: true, role: "viewer" },
      }),
    ]);
  });
});

describe("hosted mocks: list by space", () => {
  it("scope=space lists one space; scope=spaces lists shared spaces; scope=space without spaceId is 400", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const pub = await call("POST", R.artifacts, {
      title: "in eng",
      format: "html",
      content: "x",
      spaceId: eng,
    });
    expect(pub.status).toBe(201);
    const inEng = (await json(
      await call("GET", `${R.artifacts}?scope=space&spaceId=${eng}&limit=100`),
    )) as { items: { title: string; space?: { id: string } }[] };
    expect(inEng.items.map((a) => a.title)).toContain("in eng");
    expect(inEng.items.every((a) => a.space?.id === eng)).toBe(true);
    const shared = (await json(
      await call("GET", `${R.artifacts}?scope=spaces&limit=100`),
    )) as { items: { space?: { kind: string } }[] };
    expect(shared.items.every((a) => a.space?.kind === "shared")).toBe(true);
    expect((await call("GET", `${R.artifacts}?scope=space`)).status).toBe(400);
  });
});

describe("hosted mocks: reset a Google link", () => {
  const byEmail = async (email: string) =>
    (
      (await json(await call("GET", R.members))) as {
        id: string;
        email: string;
        identities?: string[];
      }[]
    ).find((m) => m.email === email);

  it("the owner resets an active member's and an admin's link", async () => {
    fresh({ hosted: true });
    const bob = await byEmail("bob@example.com");
    const erin = await byEmail("erin@example.com");
    expect(bob?.identities).toEqual(["google"]);
    expect(erin?.identities).toEqual(["google"]);
    expect(
      (await call("DELETE", R.memberIdentity(bob?.id as string, "google")))
        .status,
    ).toBe(204);
    expect(
      (await call("DELETE", R.memberIdentity(erin?.id as string, "google")))
        .status,
    ).toBe(204);
  });

  it("an admin can't reset a peer admin (owner_only) but can reset a member", async () => {
    fresh({ hosted: { actAs: "admin" } });
    const bob = await byEmail("bob@example.com");
    const erin = await byEmail("erin@example.com");
    const r = await call(
      "DELETE",
      R.memberIdentity(erin?.id as string, "google"),
    );
    expect(r.status).toBe(403);
    expect((await errCode(r)).code).toBe("owner_only");
    expect(
      (await call("DELETE", R.memberIdentity(bob?.id as string, "google")))
        .status,
    ).toBe(204);
  });
});
