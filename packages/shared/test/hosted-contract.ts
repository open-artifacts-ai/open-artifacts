// The hosted contract cases, run by more than one driver: the MSW mock
// (hosted.test.ts) and the real server (apps/server/test/hosted.contract.test.ts).
// A case the real server can't set up is tagged MSW-only with its reason; a
// case the server fails today is listed in that driver's knownGaps and runs
// there as an expected failure (it.fails), so a fix that makes it pass fails
// CI until the entry is removed.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorSchema,
  ArtifactSummarySchema,
  AUTH,
  AuditEventSchema,
  AuthProvidersSchema,
  BreakGlassRequiredDetailsSchema,
  CodeRateLimitedDetailsSchema,
  CodeRequestedSchema,
  CodeVerifiedSchema,
  DirectoryGroupSchema,
  type DirectoryMode,
  type FeatureFlag,
  GroupMappingSchema,
  MemberSchema,
  MeSchema,
  PageSchema,
  R,
  RestrictedGroupSchema,
  SearchHitSchema,
  SettingsSchema,
  SPACE_NAME_RESERVED_MESSAGE,
  SpaceCandidateSchema,
  SpaceForbiddenDetailsSchema,
  SpaceMemberGroupSchema,
  SpaceMemberSchema,
  SpaceMembersPageSchema,
  SpaceSchema,
  SyncStatusSchema,
  TransferResultSchema,
  TransferSummarySchema,
  TrashItemSchema,
} from "../src/index.js";
import { fixtures } from "../src/mocks/fixtures.js";

/**
 * The HostedMockOptions the cases use (mocks/hosted.ts), declared here so a
 * server driver needn't typecheck the MSW mock.
 */
export type ContractHosted = {
  mode?: "access" | "direct";
  providers?: ("google" | "email")[];
  turnstile?: boolean;
  directory?: DirectoryMode;
  unhealthy?: boolean;
  /**
   * With unhealthy: the outage began, and the last success was, over 7 d
   * ago, so staleAt (lastSuccessAt + 7 d, once passed) is set.
   */
  stale?: boolean;
  unhealthyState?:
    | "backoff"
    | "auth_failed"
    | "customer_mismatch"
    | "scope_missing";
  breakGlass?: "fresh" | "stale";
  actAs?: "owner" | "admin";
  features?: FeatureFlag[];
};

/** What a driver sets up: no `hosted` is hosted off; `hosted` as createHandlers takes it. */
export type ContractSetup = { hosted?: boolean | ContractHosted };

/**
 * A known server gap: the review item(s) it belongs to ("new" when the review
 * didn't list it), whether it blocks M1, and why the case fails today.
 */
export type KnownGap = { item: string; m1: boolean; why: string };

export type ContractDriver = {
  /** Runs the MSW-only cases (true for the mock). */
  mock: boolean;
  /** Resets to the fixture world, signed in as the owner (or an admin with actAs). */
  fresh: (o?: ContractSetup) => Promise<void>;
  /** A request as the current caller (JSON body, CSRF header, session). */
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  /** Signs the caller in as the fixture member with this email. */
  signIn: (email: string) => Promise<void>;
  /** The code the last AUTH.codeRequest sent. */
  code: () => Promise<string>;
  /** Case name -> gap: these run as expected failures on this driver. */
  knownGaps?: Readonly<Record<string, KnownGap>>;
};

export type ContractCases = {
  /** Every case name, in order. */
  names: string[];
  /** MSW-only case name -> why the real server can't run it. */
  mswOnly: Map<string, string>;
};

const json = async (r: Response) => (await r.json()) as any;
const errCode = async (r: Response) =>
  ApiErrorSchema.parse(await r.json()).error;

/** Response schemas made strict: an unexpected key fails the contract. */
const Strict = {
  Me: MeSchema.strict(),
  ArtifactSummary: ArtifactSummarySchema.strict(),
  SearchHit: SearchHitSchema.strict(),
  Space: SpaceSchema.strict(),
  SpaceMember: SpaceMemberSchema.strict(),
  SpaceCandidate: SpaceCandidateSchema.strict(),
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
  TrashItem: TrashItemSchema.strict(),
};

/** Registers the hosted contract cases against `d`. */
export function hostedContract(d: ContractDriver): ContractCases {
  const names: string[] = [];
  const mswOnly = new Map<string, string>();
  const t = (name: string, fn: () => Promise<void>, mockOnly?: string) => {
    if (names.includes(name)) throw new Error(`duplicate case: ${name}`);
    names.push(name);
    if (mockOnly) mswOnly.set(name, mockOnly);
    const gap = d.knownGaps?.[name];
    if (mockOnly && !d.mock) it.skip(`${name} [MSW-only: ${mockOnly}]`, fn);
    else if (gap)
      it.fails(
        `${name} [known gap: item ${gap.item}${gap.m1 ? ", M1" : ""}]`,
        fn,
      );
    else it(name, fn);
  };

  /** The Engineering space's fixture id (mocks/hosted.ts). */
  const ENG = "SpEngNpQrSt2uVwX";

  describe("hosted off: responses are byte-identical", () => {
    t(
      "me, list, members, search carry no hosted fields",
      async () => {
        await d.fresh();
        expect(await (await d.call("GET", R.me)).text()).toBe(
          JSON.stringify(fixtures.me),
        );
        expect(await (await d.call("GET", R.members)).text()).toBe(
          JSON.stringify(fixtures.members),
        );
        const list = await (
          await d.call("GET", `${R.artifacts}?limit=100`)
        ).text();
        expect(list).toBe(
          JSON.stringify({ items: fixtures.artifacts, nextCursor: null }),
        );
        for (const k of ['"space"', '"can"', '"status"', '"hosted"', '"auth"'])
          expect(list).not.toContain(k);
      },
      "compares bytes with the mock's fixtures",
    );
  });

  describe("hosted mocks", () => {
    t("providers with Google on: no domain codes", async () => {
      await d.fresh({ hosted: true });
      const p = Strict.AuthProviders.parse(
        await json(await d.call("GET", AUTH.providers)),
      );
      expect(p.mode).toBe("direct");
      // turnstileSiteKey is the driver's own config, not the contract's.
      expect(
        p.providers.map((x) => {
          const { turnstileSiteKey: _, ...rest } = x as typeof x & {
            turnstileSiteKey?: string;
          };
          return rest;
        }),
      ).toEqual([
        { id: "google", start: AUTH.loginGoogle, domains: ["example.com"] },
        { id: "email", domainCodes: false, guests: true },
      ]);
    });

    t(
      "providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal",
      async () => {
        // Email only: with Google on, a domain member gets no code (domainCodes).
        await d.fresh({ hosted: { providers: ["email"] } });
        const p = Strict.AuthProviders.parse(
          await json(await d.call("GET", AUTH.providers)),
        );
        expect(p.mode).toBe("direct");
        expect(p.providers).toMatchObject([{ id: "email", domainCodes: true }]);

        const rq = await d.call("POST", AUTH.codeRequest, {
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
        const bad = await d.call("POST", AUTH.codeVerify, {
          code: "0000 0000",
        });
        expect(bad.status).toBe(401);
        expect((await errCode(bad)).details).toEqual({
          reason: "invalid_code",
          attemptsLeft: 4,
        });
        const c = await d.code();
        const ok = await d.call("POST", AUTH.codeVerify, {
          code: `${c.slice(0, 4)} ${c.slice(4)}`,
        });
        expect(ok.status).toBe(200);
        const v = Strict.CodeVerified.parse(await ok.json());
        expect(v).toMatchObject({ next: "/a/x", readOnly: false });
        expect(v.user.email).toBe("ada@example.com");

        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
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
          await json(await d.call("GET", `${R.artifacts}?limit=100`)),
        );
        const notes = list.items.find((a) => a.title === "Meeting notes");
        expect(notes?.access).toBe("manager");
        expect(notes?.space).toMatchObject({
          kind: "shared",
          name: "Engineering",
        });
        expect(notes?.can).toMatchObject({ move: true, transfer: false });
        const mine = list.items.find((a) => a.title === "Landing page");
        expect(mine?.space).toMatchObject({ kind: "personal", id: me.user.id });
        expect(mine?.can?.transfer).toBe(true);
        // The viewer row is Bob's editors-only guide: no data writes either.
        const viewer = list.items.find((a) => a.access === "viewer");
        expect(viewer?.can).toMatchObject({ edit: false, dataWrite: false });
        const hits = PageSchema(Strict.SearchHit).parse(
          await json(await d.call("GET", `${R.search}?q=notes`)),
        );
        expect(hits.items[0]?.space?.name).toBe("Engineering");

        // Move: one's own personal space is refused, someone else's is 404; a
        // viewer-role space is forbidden; Engineering works.
        const bob = fixtures.members[1]?.id as string;
        const toBob = await d.call("POST", R.moveArtifact(mine?.id as string), {
          spaceId: bob,
        });
        expect(toBob.status).toBe(404);
        const toPersonal = await d.call(
          "POST",
          R.moveArtifact(mine?.id as string),
          {
            spaceId: me.user.id,
          },
        );
        expect(toPersonal.status).toBe(400);
        expect((await errCode(toPersonal)).code).toBe("space_personal");
        const exec = me.spaces?.find((s) => s.name === "Exec")?.id as string;
        const forbidden = await d.call(
          "POST",
          R.moveArtifact(mine?.id as string),
          {
            spaceId: exec,
          },
        );
        expect(forbidden.status).toBe(403);
        expect((await errCode(forbidden)).code).toBe("space_forbidden");
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        const moved = Strict.ArtifactSummary.parse(
          await json(
            await d.call("POST", R.moveArtifact(mine?.id as string), {
              spaceId: eng,
            }),
          ),
        );
        expect(moved).toMatchObject({ access: "manager", space: { id: eng } });
      },
    );

    t(
      "code flow: no_pending, expiry after 5 tries, turnstile, rate limits",
      async () => {
        await d.fresh({ hosted: { turnstile: true } });
        const none = await d.call("POST", AUTH.codeVerify, { code: "1" });
        expect((await errCode(none)).details).toEqual({ reason: "no_pending" });
        const missing = await d.call("POST", AUTH.codeRequest, {
          email: "x@example.com",
        });
        expect(missing.status).toBe(400);
        expect(await errCode(missing)).toMatchObject({
          code: "turnstile_required",
          details: { field: "turnstile", required: true },
        });
        const rejected = await d.call("POST", AUTH.codeRequest, {
          email: "x@example.com",
          turnstileToken: "fail",
        });
        expect((await errCode(rejected)).code).toBe("turnstile_failed");
        const req = { email: "g@outside.org", turnstileToken: "ok" };
        expect((await d.call("POST", AUTH.codeRequest, req)).status).toBe(202);
        for (let i = 0; i < 4; i++)
          await d.call("POST", AUTH.codeVerify, { code: "11111111" });
        const dead = await d.call("POST", AUTH.codeVerify, {
          code: "11111111",
        });
        expect((await errCode(dead)).details).toEqual({ reason: "expired" });
        for (let i = 0; i < 4; i++) await d.call("POST", AUTH.codeRequest, req);
        const limited = await d.call("POST", AUTH.codeRequest, req);
        expect(limited.status).toBe(429);
        expect(
          CodeRateLimitedDetailsSchema.parse((await errCode(limited)).details)
            .scope,
        ).toBe("email");
      },
    );

    t("guest sign-in is read-only and can't publish", async () => {
      await d.fresh({ hosted: true });
      await d.call("POST", AUTH.codeRequest, { email: "guest@outside.org" });
      const v = Strict.CodeVerified.parse(
        await json(
          await d.call("POST", AUTH.codeVerify, { code: await d.code() }),
        ),
      );
      expect(v.user.role).toBe("guest");
      const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
      expect(me.auth).toMatchObject({ readOnly: true, cap: "guest" });
      const list = await json(await d.call("GET", R.artifacts));
      expect(list.items[0].can.dataWrite).toBe(false);
      const pub = await d.call("POST", R.artifacts, {
        title: "t",
        format: "html",
        content: "x",
      });
      expect((await errCode(pub)).code).toBe("space_forbidden");
    });

    t(
      'a shared space named "Personal" (trimmed, any case) is 400 space_name_reserved on create and rename',
      async () => {
        await d.fresh({ hosted: true });
        const reserved = {
          code: "space_name_reserved",
          message: SPACE_NAME_RESERVED_MESSAGE,
          details: { field: "name" },
        };
        for (const name of ["Personal", "  personal ", "PERSONAL"]) {
          const r = await d.call("POST", R.spaces, { name });
          expect(r.status).toBe(400);
          expect(await errCode(r)).toEqual(reserved);
        }
        const sales = Strict.Space.parse(
          await json(await d.call("POST", R.spaces, { name: "Sales" })),
        );
        const rename = await d.call("PATCH", R.space(sales.id), {
          name: " Personal",
        });
        expect(rename.status).toBe(400);
        expect(await errCode(rename)).toEqual(reserved);
        expect(
          Strict.Space.parse(await json(await d.call("GET", R.space(sales.id))))
            .name,
        ).toBe("Sales");
        // Only the whole name is reserved.
        const ok = Strict.Space.parse(
          await json(
            await d.call("PATCH", R.space(sales.id), {
              name: "Personal finance",
            }),
          ),
        );
        expect(ok.name).toBe("Personal finance");
      },
    );

    t("spaces, members, mappings, directory, transfer", async () => {
      await d.fresh({ hosted: true });
      const spaces = PageSchema(Strict.Space).parse(
        await json(await d.call("GET", R.spaces)),
      );
      expect(spaces.items[0]?.kind).toBe("personal");
      const clients = spaces.items.find((s) => s.name === "Clients");
      expect(clients?.myRole).toBeNull();
      const created = Strict.Space.parse(
        await json(await d.call("POST", R.spaces, { name: "Sales" })),
      );
      expect(created).toMatchObject({
        kind: "shared",
        publicLinks: true,
        myRole: null,
      });
      const bob = fixtures.members[1]?.id as string;
      const m = Strict.SpaceMember.parse(
        await json(
          await d.call("PUT", R.spaceMember(created.id, bob), {
            role: "editor",
          }),
        ),
      );
      expect(m).toMatchObject({
        userId: bob,
        role: "editor",
        source: "manual",
      });
      expect(
        Strict.GroupMapping.parse(
          await json(
            await d.call("PUT", R.spaceMapping(created.id, "gSales03"), {
              role: "viewer",
            }),
          ),
        ).name,
      ).toBe("Sales");
      const patched = Strict.Space.parse(
        await json(
          await d.call("PATCH", R.space(created.id), { publicLinks: false }),
        ),
      );
      expect(patched.publicLinks).toBe(false);
      expect((await d.call("DELETE", R.space(created.id))).status).toBe(204);
      const personal = await d.call(
        "PATCH",
        R.space(fixtures.members[0]?.id as string),
        { name: "x" },
      );
      expect((await errCode(personal)).code).toBe("space_personal");

      const st = Strict.SyncStatus.parse(
        await json(await d.call("GET", R.directory)),
      );
      expect(st).toMatchObject({
        mode: "google",
        healthy: true,
        customerMismatch: null,
      });
      expect(st.held).toHaveLength(1);
      expect(
        (await d.call("POST", R.directoryHeldConfirm("gSales03"))).status,
      ).toBe(202);
      expect((await d.call("POST", R.directorySync)).status).toBe(202);

      const departed = await json(
        await d.call("GET", `${R.members}?status=suspended,removed`),
      );
      expect(departed.map((x: { status: string }) => x.status)).toEqual([
        "suspended",
      ]);
      const carol = departed[0].id as string;
      expect(
        Strict.TransferSummary.parse(
          await json(await d.call("GET", R.memberTransfer(carol))),
        ),
      ).toEqual({
        live: 2,
        deleted: 1,
      });
      const toPersonal = await d.call("POST", R.memberTransfer(carol), {
        to: { kind: "space", spaceId: bob },
      });
      expect((await errCode(toPersonal)).code).toBe("space_personal");
      const toCarol = await d.call("POST", R.memberTransfer(carol), {
        to: { kind: "user", userId: carol },
      });
      expect((await errCode(toCarol)).code).toBe("invalid_successor");
      expect(
        Strict.TransferResult.parse(
          await json(
            await d.call("POST", R.memberTransfer(carol), {
              to: { kind: "user", userId: bob },
            }),
          ),
        ),
      ).toEqual({ moved: 3, remaining: 0, nextCursor: null });
      const active = await d.call("POST", R.memberTransfer(bob), {
        to: { kind: "user", userId: bob },
      });
      expect((await errCode(active)).code).toBe("member_active");
      expect((await d.call("GET", R.usage)).status).toBe(404);
    });

    t("frozen sync refuses mapping changes", async () => {
      await d.fresh({ hosted: { directory: "frozen" } });
      const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
      expect(me.instance.directory?.mode).toBe("frozen");
      // Engineering's fixture id: the server's Me has no spaces yet (item 2).
      const r = await d.call("PUT", R.spaceMapping(ENG, "x@example.com"), {
        role: "viewer",
      });
      expect(r.status).toBe(409);
      expect((await errCode(r)).code).toBe("directory_sync_off");
    });

    t("frozen sync, unhealthy for 2 h: the banner", async () => {
      await d.fresh({ hosted: { directory: "frozen", unhealthy: true } });
      const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
      expect(me.instance.directory).toMatchObject({
        mode: "frozen",
        healthy: false,
        banner: true,
        tokensUnverified: true,
      });
    });

    t("transfer of a personal artifact and spaceId on publish", async () => {
      await d.fresh({ hosted: true });
      const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
      const eng = me.spaces?.find((s) => s.name === "Engineering")
        ?.id as string;
      const exec = me.spaces?.find((s) => s.name === "Exec")?.id as string;
      const base = { title: "n", format: "html", content: "x" };
      expect(
        (await d.call("POST", R.artifacts, { ...base, spaceId: eng })).status,
      ).toBe(201);
      const forbidden = await d.call("POST", R.artifacts, {
        ...base,
        spaceId: exec,
      });
      expect((await errCode(forbidden)).code).toBe("space_forbidden");
      const id = fixtures.artifacts[0]?.id as string;
      const useMove = await d.call("POST", R.artifacts, {
        ...base,
        id,
        spaceId: eng,
      });
      expect((await errCode(useMove)).code).toBe("use_move");
      const bob = fixtures.members[1]?.id as string;
      const t = Strict.ArtifactSummary.parse(
        await json(
          await d.call("POST", R.transferArtifact(id), { userId: bob }),
        ),
      );
      expect(t).toMatchObject({
        access: "editor",
        space: { id: bob },
        owner: { id: bob },
      });
      expect(
        z
          .array(Strict.Member)
          .parse(await json(await d.call("GET", R.members)))[0]?.status,
      ).toBe("active");
    });

    t(
      "owner=me lists the caller's own; scope=mine with a shared spaceId is 400",
      async () => {
        await d.fresh({ hosted: true });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        const list = async (q: string) => {
          const r = await d.call("GET", `${R.artifacts}?${q}`);
          expect(r.status, q).toBe(200);
          return PageSchema(Strict.ArtifactSummary).parse(await json(r)).items;
        };
        const titles = (xs: { title: string }[]) => xs.map((a) => a.title);
        expect(titles(await list("scope=all&limit=100"))).toContain(
          "Shared draft",
        );
        const own = await list("scope=all&owner=me&limit=100");
        expect(own.length).toBeGreaterThan(0);
        expect(own.every((a) => a.owner.id === me.user.id)).toBe(true);
        expect(titles(own)).toEqual(
          expect.arrayContaining(["Landing page", "Meeting notes"]),
        );
        expect(titles(own)).not.toContain("Shared draft");
        // The literal "me" is the caller; an email still works.
        expect(
          titles(
            await list(
              `scope=all&owner=${encodeURIComponent(me.user.email)}&limit=100`,
            ),
          ).sort(),
        ).toEqual(titles(own).sort());
        // "Mine" inside a shared space: scope=space plus owner=me.
        expect(
          titles(await list(`scope=space&spaceId=${eng}&owner=me`)),
        ).toEqual(["Meeting notes"]);
        const bad = await d.call(
          "GET",
          `${R.artifacts}?scope=mine&spaceId=${eng}`,
        );
        expect(bad.status).toBe(400);
        const e = ApiErrorSchema.parse(await json(bad)).error;
        expect(e.code).toBe("bad_request");
        expect(e.details).toMatchObject({ path: "spaceId" });
        // The caller's own personal space is still fine with mine.
        expect(
          titles(
            await list(`scope=mine&spaceId=${me.personalSpaceId}&limit=100`),
          ),
        ).toContain("Landing page");
      },
    );
  });

  describe("trash (P4 item 9)", () => {
    const DAY = 86_400_000;
    const idOf = (title: string) =>
      fixtures.artifacts.find((a) => a.title === title)?.id as string;
    const trash = async (q = "") => {
      const r = await d.call("GET", `${R.trash}${q}`);
      expect(r.status, q).toBe(200);
      return PageSchema(Strict.TrashItem).parse(await json(r));
    };

    t(
      "trash lists personal and managed-space deletions, newest first; spaceId narrows",
      async () => {
        await d.fresh({ hosted: true });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        expect((await trash()).items).toEqual([]);
        for (const title of ["Landing page", "Meeting notes"])
          expect((await d.call("DELETE", R.artifact(idOf(title)))).status).toBe(
            204,
          );
        const all = await trash();
        // Newest deletedAt first (two deletes may share a millisecond: then id desc).
        const order = [...all.items].sort(
          (x, y) =>
            y.deletedAt.localeCompare(x.deletedAt) || (y.id < x.id ? -1 : 1),
        );
        expect(all.items).toEqual(order);
        expect(all.items.map((a) => a.title).sort()).toEqual([
          "Landing page",
          "Meeting notes",
        ]);
        const notes = all.items.find((a) => a.title === "Meeting notes");
        const landing = all.items.find((a) => a.title === "Landing page");
        expect(notes).toMatchObject({
          access: "manager",
          space: { id: eng, name: "Engineering", personal: false },
        });
        expect(landing).toMatchObject({
          access: "owner",
          space: { id: me.personalSpaceId, name: "Personal", personal: true },
        });
        for (const a of all.items)
          expect(Date.parse(a.purgeAt) - Date.parse(a.deletedAt)).toBe(
            30 * DAY,
          );
        // Pages of one, newest first.
        const titles = all.items.map((a) => a.title);
        const p1 = await trash("?limit=1");
        expect(p1.items.map((a) => a.title)).toEqual([titles[0]]);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await trash(
          `?limit=1&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
        );
        expect(p2.items.map((a) => a.title)).toEqual([titles[1]]);
        expect(p2.nextCursor).toBeNull();
        expect(
          (await trash(`?spaceId=${eng}`)).items.map((a) => a.title),
        ).toEqual(["Meeting notes"]);
        expect(
          (await trash(`?spaceId=${me.personalSpaceId}`)).items.map(
            (a) => a.title,
          ),
        ).toEqual(["Landing page"]);
        expect(
          (await d.call("GET", `${R.trash}?spaceId=SpNopeNpQrSt9uVw`)).status,
        ).toBe(404);
        expect((await d.call("GET", `${R.trash}?limit=101`)).status).toBe(400);
        // Bob is an editor in Engineering: not his to restore, so not listed;
        // asking for it is 404, as for a space he can't see.
        await d.signIn("bob@example.com");
        expect((await trash()).items.map((a) => a.title)).not.toContain(
          "Meeting notes",
        );
        expect((await d.call("GET", `${R.trash}?spaceId=${eng}`)).status).toBe(
          404,
        );
      },
    );

    t("spaces off: personal trash only; another spaceId is 400", async () => {
      await d.fresh();
      const me = await json(await d.call("GET", R.me));
      expect(
        (await d.call("DELETE", R.artifact(idOf("Landing page")))).status,
      ).toBe(204);
      const page = await trash();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        title: "Landing page",
        access: "owner",
        space: { id: me.user.id, name: "Personal", personal: true },
      });
      expect((await trash(`?spaceId=${me.user.id}`)).items).toHaveLength(1);
      const bad = await d.call("GET", `${R.trash}?spaceId=SpEngNpQrSt2uVwX`);
      expect(bad.status).toBe(400);
      expect(ApiErrorSchema.parse(await json(bad)).error.details).toMatchObject(
        {
          path: "spaceId",
        },
      );
    });
  });

  describe("hosted mocks: data writers", () => {
    t(
      "a viewer of an editors-only artifact gets can.dataWrite false",
      async () => {
        await d.fresh({ hosted: true });
        const get = async (title: string) => {
          const id = fixtures.artifacts.find((a) => a.title === title)
            ?.id as string;
          return Strict.ArtifactSummary.parse(
            await json(await d.call("GET", R.artifact(id))),
          );
        };
        const guide = await get("Onboarding guide");
        expect(guide).toMatchObject({
          access: "viewer",
          dataWriters: "editors",
        });
        expect(guide.can?.dataWrite).toBe(false);
        // The list says the same.
        const page = PageSchema(Strict.ArtifactSummary).parse(
          await json(await d.call("GET", `${R.artifacts}?scope=all&limit=100`)),
        );
        expect(page.items.find((a) => a.id === guide.id)?.can?.dataWrite).toBe(
          false,
        );
        // Owners keep it on an editors-only artifact.
        const landing = fixtures.artifacts.find(
          (a) => a.title === "Landing page",
        )?.id as string;
        const own = Strict.ArtifactSummary.parse(
          await json(
            await d.call("PATCH", R.artifact(landing), {
              dataWriters: "editors",
            }),
          ),
        );
        expect(own).toMatchObject({ access: "owner", dataWriters: "editors" });
        expect((await get("Landing page")).can?.dataWrite).toBe(true);
      },
    );
  });

  describe("hosted mocks: restriction, public links, admin self-add, audit", () => {
    const signIn = async (email: string) => {
      await d.call("POST", AUTH.codeRequest, { email });
      return Strict.CodeVerified.parse(
        await json(
          await d.call("POST", AUTH.codeVerify, { code: await d.code() }),
        ),
      );
    };

    t(
      "a restricted-group member is capped and gets no allMembersRole",
      async () => {
        await d.fresh({ hosted: { providers: ["email"] } });
        const v = await signIn("dan@example.com");
        expect(v.readOnly).toBe(true);
        expect(v.user.restriction?.groups.map((g) => g.groupId)).toEqual([
          "gCon04",
        ]);
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        expect(me.auth).toMatchObject({ readOnly: true, cap: "restricted" });
        // Engineering has allMembersRole viewer, which never reaches Dan.
        expect(me.spaces).toEqual([]);
        const pub = await d.call("POST", R.artifacts, {
          title: "t",
          format: "html",
          content: "x",
        });
        expect((await errCode(pub)).code).toBe("space_forbidden");
      },
    );

    t(
      "manual restricted flag: cap on space members, no successor, audited",
      async () => {
        await d.fresh({ hosted: { directory: "frozen" } });
        const bob = fixtures.members[1]?.id as string;
        const set = Strict.Member.parse(
          await json(await d.call("PUT", R.memberRestricted(bob))),
        );
        expect(set.restriction).toEqual({ manual: true, groups: [] });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        const ms = PageSchema(Strict.SpaceMember).parse(
          await json(await d.call("GET", R.spaceMembers(eng))),
        );
        expect(ms.items.find((m) => m.userId === bob)?.cap).toBe("restricted");
        const id = fixtures.artifacts[0]?.id as string;
        const t = await d.call("POST", R.transferArtifact(id), { userId: bob });
        expect((await errCode(t)).code).toBe("invalid_successor");
        const cleared = Strict.Member.parse(
          await json(await d.call("DELETE", R.memberRestricted(bob))),
        );
        expect(cleared.restriction).toBeNull();
        const audit = PageSchema(Strict.AuditEvent).parse(
          await json(await d.call("GET", R.audit)),
        );
        expect(audit.items.map((e) => e.action)).toEqual([
          "restricted.remove",
          "restricted.set",
        ]);
      },
    );

    t(
      "restricted groups by groupId: PUT 409 when frozen, DELETE allowed",
      async () => {
        await d.fresh({ hosted: { directory: "frozen" } });
        const list = z
          .array(Strict.RestrictedGroup)
          .parse(await json(await d.call("GET", R.restrictedGroups)));
        expect(list.map((g) => g.groupId)).toEqual(["gCon04"]);
        const put = await d.call("PUT", R.restrictedGroup("gSales03"));
        expect((await errCode(put)).code).toBe("directory_sync_off");
        expect(
          (await d.call("DELETE", R.restrictedGroup("gCon04"))).status,
        ).toBe(204);
      },
    );

    t(
      "restricted groups and the group picker with sync on",
      async () => {
        await d.fresh({ hosted: true });
        const g = Strict.RestrictedGroup.parse(
          await json(await d.call("PUT", R.restrictedGroup("gSales03"))),
        );
        expect(g).toMatchObject({
          groupId: "gSales03",
          email: "sales@example.com",
        });
        expect((await d.call("PUT", R.restrictedGroup("nope"))).status).toBe(
          404,
        );
        const picker = PageSchema(Strict.DirectoryGroup).parse(
          await json(await d.call("GET", `${R.directoryGroups}?q=eng`)),
        );
        expect(picker.items.map((x) => x.groupId)).toEqual(["gEng01"]);
      },
      "the group picker searches Google live (no fake Google directory here)",
    );

    t(
      "public in a space with publicLinks off is 403 public_links_off",
      async () => {
        await d.fresh({ hosted: true });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        expect(me.spaces?.find((s) => s.name === "Exec")?.publicLinks).toBe(
          false,
        );
        // The caller manages Engineering ("Meeting notes"); turn its public links off.
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        expect(
          (await d.call("PATCH", R.space(eng), { publicLinks: false })).status,
        ).toBe(200);
        const notes = fixtures.artifacts.find(
          (a) => a.title === "Meeting notes",
        )?.id as string;
        const r = await d.call("PATCH", R.artifact(notes), {
          visibility: "public",
        });
        expect(r.status).toBe(403);
        expect((await errCode(r)).code).toBe("public_links_off");
        const create = await d.call("POST", R.artifacts, {
          title: "t",
          format: "html",
          content: "x",
          spaceId: eng,
          visibility: "public",
        });
        expect((await errCode(create)).code).toBe("public_links_off");
      },
    );

    t(
      "public links off keeps an existing public artifact public (no rewrite)",
      async () => {
        await d.fresh({ hosted: true });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        const notes = fixtures.artifacts.find(
          (a) => a.title === "Meeting notes",
        )?.id as string;
        expect(
          (await d.call("PATCH", R.artifact(notes), { visibility: "public" }))
            .status,
        ).toBe(200);
        expect(
          (await d.call("PATCH", R.space(eng), { publicLinks: false })).status,
        ).toBe(200);
        const a = await json(await d.call("GET", R.artifact(notes)));
        expect(a).toMatchObject({
          visibility: "public",
          space: { id: eng, publicLinks: false },
        });
        // Echoing "public" on it passes (agents resend it); only a change is refused.
        expect(
          (await d.call("PATCH", R.artifact(notes), { visibility: "public" }))
            .status,
        ).toBe(200);
        // A new version is POST /versions (resending "public" passes there too).
        expect(
          (
            await d.call("POST", R.versions(notes), {
              format: "html",
              content: "y",
              visibility: "public",
            })
          ).status,
        ).toBe(201);
        // REST create never upserts: an existing id is 400 (use /versions).
        const upsert = await d.call("POST", R.artifacts, {
          id: notes,
          format: "html",
          content: "y",
        });
        expect(upsert.status).toBe(400);
        expect((await errCode(upsert)).code).toBe("bad_request");
      },
    );

    t(
      "space members: personal space 400 space_personal; PUT needs an existing, active target",
      async () => {
        await d.fresh({ hosted: true });
        const ada = fixtures.members[0]?.id as string;
        expect(
          (await errCode(await d.call("GET", R.spaceMembers(ada)))).code,
        ).toBe("space_personal");
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        // Carol is suspended; the other id names nobody.
        for (const userId of ["Cr7tNpQrSt8uVwXy", "Zz0nobodyZz0abcd"])
          expect(
            (
              await d.call("PUT", R.spaceMember(eng, userId), {
                role: "viewer",
              })
            ).status,
          ).toBe(404);
        const bob = fixtures.members[1]?.id as string;
        expect(
          (await d.call("PUT", R.spaceMember(eng, bob), { role: "viewer" }))
            .status,
        ).toBe(200);
      },
    );

    t("admin self-add to a shared space only, audited", async () => {
      await d.fresh({ hosted: true });
      const spaces = PageSchema(Strict.Space).parse(
        await json(await d.call("GET", R.spaces)),
      );
      const clients = spaces.items.find((s) => s.name === "Clients")
        ?.id as string;
      const r = await d.call("POST", R.spaceMemberSelf(clients), {
        role: "viewer",
      });
      expect(r.status).toBe(201);
      expect(Strict.SpaceMember.parse(await r.json())).toMatchObject({
        role: "viewer",
      });
      const personal = await d.call(
        "POST",
        R.spaceMemberSelf(fixtures.members[0]?.id as string),
        { role: "viewer" },
      );
      expect((await errCode(personal)).code).toBe("space_personal");
      const audit = PageSchema(Strict.AuditEvent).parse(
        await json(await d.call("GET", R.audit)),
      );
      expect(audit.items[0]).toMatchObject({
        action: "space.admin_self_add",
        spaceId: clients,
      });
    });

    t(
      "guests_read_only is reported from sign-in config, never from FEATURES",
      async () => {
        await d.fresh({
          hosted: { mode: "access", features: ["guests_read_only"] },
        });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        expect(me.instance.features).not.toContain("guests_read_only");
        await d.fresh({ hosted: true });
        const me2 = Strict.Me.parse(await json(await d.call("GET", R.me)));
        expect(me2.instance.features).toContain("guests_read_only");
      },
    );
  });

  describe("hosted mocks: move and public links", () => {
    t(
      "moving a public artifact into a space with publicLinks off makes it team",
      async () => {
        await d.fresh({ hosted: true });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        expect(
          (await d.call("PATCH", R.space(eng), { publicLinks: false })).status,
        ).toBe(200);
        const report = fixtures.artifacts.find((a) => a.title === "Q4 report");
        expect(report?.visibility).toBe("public");
        const moved = Strict.ArtifactSummary.parse(
          await json(
            await d.call("POST", R.moveArtifact(report?.id as string), {
              spaceId: eng,
            }),
          ),
        );
        expect(moved).toMatchObject({
          visibility: "team",
          space: { id: eng, publicLinks: false },
        });
      },
    );
  });

  describe("hosted mocks: owners and admins can't be restricted", () => {
    t(
      "PUT memberRestricted on the owner or an admin is 400 restrict_admin",
      async () => {
        await d.fresh({ hosted: true });
        const owner = fixtures.members[0]?.id as string;
        const r = await d.call("PUT", R.memberRestricted(owner));
        expect(r.status).toBe(400);
        expect((await errCode(r)).code).toBe("restrict_admin");
        const bob = fixtures.members[1]?.id as string;
        expect(
          (await d.call("PATCH", R.member(bob), { role: "admin" })).status,
        ).toBe(200);
        const admin = await d.call("PUT", R.memberRestricted(bob));
        expect((await errCode(admin)).code).toBe("restrict_admin");
        const ms = z
          .array(Strict.Member)
          .parse(await json(await d.call("GET", R.members)));
        expect(ms.find((m) => m.id === bob)?.restriction).toBeNull();
      },
    );
  });

  describe("hosted mocks: break-glass Me (P3 T18)", () => {
    t(
      "breakGlass answers GET R.me with 401 break_glass_required { fresh }",
      async () => {
        for (const [mode, isFresh] of [
          ["fresh", true],
          ["stale", false],
        ] as const) {
          await d.fresh({ hosted: { breakGlass: mode } });
          const r = await d.call("GET", R.me);
          expect(r.status).toBe(401);
          const e = await errCode(r);
          expect(e.code).toBe("break_glass_required");
          expect(BreakGlassRequiredDetailsSchema.parse(e.details)).toEqual({
            fresh: isFresh,
          });
        }
        await d.fresh({ hosted: true });
        expect((await d.call("GET", R.me)).status).toBe(200);
      },
    );
  });

  describe("hosted mocks: sync banner fields", () => {
    t("admins see state, staleAt and held sweeps", async () => {
      await d.fresh({
        hosted: {
          unhealthy: true,
          unhealthyState: "scope_missing",
          stale: true,
        },
      });
      const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
      const dir = me.instance.directory;
      expect(dir).toMatchObject({
        state: "scope_missing",
        heldSweeps: 1,
        banner: true,
      });
      const st = Strict.SyncStatus.parse(
        await json(await d.call("GET", R.directory)),
      );
      expect(st.state).toBe("scope_missing");
      expect(dir?.staleAt).toBe(st.staleAt);
      expect(
        Date.parse(dir?.staleAt as string) -
          Date.parse(st.lastSuccessAt as string),
      ).toBe(7 * 24 * 3600_000);
    });

    t("members can't read health", async () => {
      await d.fresh({ hosted: { unhealthy: true } });
      await d.signIn("bob@example.com");
      const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
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
    const signIn = d.signIn;
    const CLIENTS = "SpCliNpQrSt4uVwX";
    const ada = fixtures.members[0]?.id as string;
    const bob = fixtures.members[1]?.id as string;
    /** As Ada (owner): make Bob a manager of Engineering, then sign in as Bob. */
    const bobManagesEng = async () => {
      await d.call("PUT", R.spaceMember(ENG, bob), { role: "manager" });
      await signIn("bob@example.com");
    };

    t(
      "settings: spaceManagerMappings defaults on; PATCH is admin-only and audited",
      async () => {
        await d.fresh({ hosted: true });
        const s = SettingsSchema.strict().parse(
          await json(await d.call("GET", R.settings)),
        );
        expect(s.spaceManagerMappings).toBe(true);
        const off = SettingsSchema.strict().parse(
          await json(
            await d.call("PATCH", R.settings, { spaceManagerMappings: false }),
          ),
        );
        expect(off.spaceManagerMappings).toBe(false);
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        expect(me.instance).not.toHaveProperty("spaceManagerMappings");
        const audit = PageSchema(AuditEventSchema).parse(
          await json(await d.call("GET", R.audit)),
        );
        expect(audit.items[0]).toMatchObject({
          action: "settings.space_manager_mappings",
          detail: { spaceManagerMappings: false },
        });
        await signIn("bob@example.com");
        expect(
          (await d.call("PATCH", R.settings, { spaceManagerMappings: true }))
            .status,
        ).toBe(404);
      },
    );

    t("hosted off: settings carry no spaceManagerMappings", async () => {
      await d.fresh();
      expect(await (await d.call("GET", R.settings)).text()).not.toContain(
        "spaceManagerMappings",
      );
    });

    t(
      "a space manager maps viewer/editor; manager is space_forbidden",
      async () => {
        await d.fresh({ hosted: true });
        await bobManagesEng();
        const sp = Strict.Space.parse(
          await json(await d.call("GET", R.space(ENG))),
        );
        expect(sp.can).toEqual({ manageMappings: true });
        expect(
          z
            .array(Strict.GroupMapping)
            .parse(await json(await d.call("GET", R.spaceMappings(ENG)))),
        ).toHaveLength(1);
        const ok = Strict.GroupMapping.parse(
          await json(
            await d.call("PUT", R.spaceMapping(ENG, "gSales03"), {
              role: "viewer",
            }),
          ),
        );
        expect(ok).toMatchObject({ groupId: "gSales03", role: "viewer" });
        const mgr = await d.call("PUT", R.spaceMapping(ENG, "gSales03"), {
          role: "manager",
        });
        expect(mgr.status).toBe(403);
        expect((await errCode(mgr)).code).toBe("space_forbidden");
        // Exec: Bob has no role there, so mapping routes stay 404.
        expect(
          (
            await d.call(
              "PUT",
              R.spaceMapping("SpExcNpQrSt3uVwX", "gSales03"),
              {
                role: "viewer",
              },
            )
          ).status,
        ).toBe(404);
        expect(
          (await d.call("DELETE", R.spaceMapping(ENG, "gSales03"))).status,
        ).toBe(204);
        // Bob's own personal space: mappings don't exist there.
        const personal = await d.call("GET", R.spaceMappings(bob));
        expect(personal.status).toBe(400);
        expect((await errCode(personal)).code).toBe("space_personal");
      },
    );

    t(
      "a space manager can't change or remove a manager-role row an admin set",
      async () => {
        await d.fresh({ hosted: true });
        await d.call("PUT", R.spaceMapping(ENG, "gSales03"), {
          role: "manager",
        });
        await bobManagesEng();
        const demote = await d.call("PUT", R.spaceMapping(ENG, "gSales03"), {
          role: "viewer",
        });
        expect(demote.status).toBe(403);
        expect((await errCode(demote)).code).toBe("space_forbidden");
        const del = await d.call("DELETE", R.spaceMapping(ENG, "gSales03"));
        expect((await errCode(del)).code).toBe("space_forbidden");
      },
    );

    t(
      "setting off: a manager's PUT is 403 directory_mapping_off; list and remove still work",
      async () => {
        await d.fresh({ hosted: true });
        await d.call("PATCH", R.settings, { spaceManagerMappings: false });
        const eng = Strict.Space.parse(
          await json(await d.call("GET", R.space(ENG))),
        );
        expect(eng.can).toEqual({ manageMappings: true });
        await bobManagesEng();
        const sp = Strict.Space.parse(
          await json(await d.call("GET", R.space(ENG))),
        );
        expect(sp.can).toEqual({ manageMappings: false });
        const r = await d.call("PUT", R.spaceMapping(ENG, "gSales03"), {
          role: "viewer",
        });
        expect(r.status).toBe(403);
        expect((await errCode(r)).code).toBe("directory_mapping_off");
        expect(
          z
            .array(Strict.GroupMapping)
            .parse(await json(await d.call("GET", R.spaceMappings(ENG)))),
        ).toEqual([expect.objectContaining({ groupId: "gEng01" })]);
        expect(
          (await d.call("DELETE", R.spaceMapping(ENG, "gEng01"))).status,
        ).toBe(204);
      },
    );

    t(
      "an Every-space mapping is an effective role in every shared space, never Personal",
      async () => {
        await d.fresh({ hosted: true });
        expect(
          PageSchema(Strict.GroupMapping).parse(
            await json(await d.call("GET", R.orgMappings)),
          ),
        ).toEqual({ items: [], nextCursor: null });
        const m = Strict.GroupMapping.parse(
          await json(
            await d.call("PUT", R.orgMapping("gEng01"), { role: "editor" }),
          ),
        );
        expect(m).toMatchObject({ groupId: "gEng01", role: "editor" });
        // One row per group: a second PUT updates it.
        await d.call("PUT", R.orgMapping("gEng01"), { role: "editor" });
        expect(
          PageSchema(Strict.GroupMapping).parse(
            await json(await d.call("GET", `${R.orgMappings}?limit=1`)),
          ).items,
        ).toHaveLength(1);
        // Not expanded into per-space mapping rows.
        expect(
          await json(await d.call("GET", R.spaceMappings(CLIENTS))),
        ).toEqual([]);
        const members = PageSchema(Strict.SpaceMember).parse(
          await json(await d.call("GET", R.spaceMembers(CLIENTS))),
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
          await json(await d.call("GET", R.space(CLIENTS))),
        );
        expect(clients.myRole).toBe("editor");
        expect(clients.can).toEqual({ manageMappings: false });
        // Personal spaces: Bob's own stays manager; Ada's stays invisible.
        expect(
          Strict.Space.parse(await json(await d.call("GET", R.space(bob))))
            .myRole,
        ).toBe("manager");
        expect((await d.call("GET", R.space(ada))).status).toBe(404);
        expect((await d.call("GET", R.orgMappings)).status).toBe(404);
      },
    );

    t("org mappings: DELETE, sync off, audit", async () => {
      await d.fresh({ hosted: true });
      await d.call("PUT", R.orgMapping("gEng01"), { role: "viewer" });
      expect((await d.call("DELETE", R.orgMapping("gEng01"))).status).toBe(204);
      expect((await d.call("DELETE", R.orgMapping("gEng01"))).status).toBe(404);
      const audit = PageSchema(AuditEventSchema).parse(
        await json(await d.call("GET", R.audit)),
      );
      expect(audit.items.slice(0, 2)).toEqual([
        expect.objectContaining({ action: "mapping.remove", spaceId: null }),
        expect.objectContaining({ action: "mapping.set", spaceId: null }),
      ]);
      await d.fresh({ hosted: { directory: "frozen" } });
      const r = await d.call("PUT", R.orgMapping("gEng01"), { role: "viewer" });
      expect((await errCode(r)).code).toBe("directory_sync_off");
    });
  });

  describe("hosted contract: space People", () => {
    const signIn = d.signIn;
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
        await json(await d.call("GET", `${R.spaceMembers(space)}${qs}`)),
      );
    const forbidden = async (r: Response) => {
      expect(r.status).toBe(403);
      const e = await errCode(r);
      expect(e.code).toBe("space_forbidden");
      return SpaceForbiddenDetailsSchema.strict().parse(e.details).target;
    };

    t(
      "members: groups role/via, allMembers, total, q and group filters",
      async () => {
        await d.fresh({ hosted: true });
        // Dan is restricted: no allMembers.
        await d.call("PUT", R.spaceMember(ENG, dan), { role: "editor" });
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
        expect(
          (await list(ENG, "?q=ada%40")).items.map((m) => m.userId),
        ).toEqual([ada]);
        // Any word of the name: "build" finds Bob Builder; mid-word doesn't.
        expect(
          (await list(ENG, "?q=build")).items.map((m) => m.userId),
        ).toEqual([bob]);
        expect((await list(ENG, "?q=uilder")).total).toBe(0);
        const eng = await list(ENG, "?group=gEng01");
        expect(eng.items.map((m) => m.userId)).toEqual([bob]);
        expect(eng.total).toBe(1);
        expect(
          (await d.call("GET", `${R.spaceMembers(ENG)}?bogus=1`)).status,
        ).toBe(400);
        // An Every-space mapping shows as via "every".
        await d.call("PUT", R.orgMapping("gEng01"), { role: "viewer" });
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
      },
    );

    t(
      "a space manager can't grant or change Manager on a member (target member); mappings say target mapping",
      async () => {
        await d.fresh({ hosted: true });
        await d.call("PUT", R.spaceMember(ENG, bob), { role: "manager" });
        await signIn("bob@example.com");
        expect(
          await forbidden(
            await d.call("PUT", R.spaceMember(ENG, dan), { role: "manager" }),
          ),
        ).toBe("member");
        // Ada is a manager by hand: demoting her is changing the Manager role.
        expect(
          await forbidden(
            await d.call("PUT", R.spaceMember(ENG, ada), { role: "viewer" }),
          ),
        ).toBe("member");
        expect(
          StrictMember.parse(
            await json(
              await d.call("PUT", R.spaceMember(ENG, dan), { role: "editor" }),
            ),
          ),
        ).toMatchObject({ userId: dan, manualRole: "editor" });
        expect(
          await forbidden(
            await d.call("PUT", R.spaceMapping(ENG, "gSales03"), {
              role: "manager",
            }),
          ),
        ).toBe("mapping");
      },
    );

    t(
      "a space manager can't change or remove a peer manager (403 target member); org admins can",
      async () => {
        for (const directory of ["google", "frozen"] as const) {
          await d.fresh({ hosted: { directory } });
          // Bob becomes a manager of Engineering, where Ada is manager by hand.
          await d.call("PUT", R.spaceMember(ENG, bob), { role: "manager" });
          await d.call("PUT", R.spaceMember(ENG, dan), { role: "manager" });
          // Org admin (Ada) changes and removes a manager: allowed.
          expect(
            (await d.call("PUT", R.spaceMember(ENG, dan), { role: "editor" }))
              .status,
          ).toBe(200);
          expect((await d.call("DELETE", R.spaceMember(ENG, dan))).status).toBe(
            204,
          );
          await signIn("bob@example.com");
          expect(
            await forbidden(
              await d.call("PUT", R.spaceMember(ENG, ada), { role: "viewer" }),
            ),
          ).toBe("member");
          expect(
            await forbidden(await d.call("DELETE", R.spaceMember(ENG, ada))),
          ).toBe("member");
        }
      },
    );

    t(
      "PUT member validates the body before the target (400, not 404)",
      async () => {
        await d.fresh({ hosted: true });
        const r = await d.call("PUT", R.spaceMember(ENG, "Zz0nobodyZz0abcd"), {
          role: "owner",
        });
        expect(r.status).toBe(400);
      },
    );

    t(
      "PATCH space audits space.update only when name or allMembersRole changes",
      async () => {
        await d.fresh({ hosted: true });
        await d.call("PATCH", R.space(ENG), { publicLinks: false });
        await d.call("PATCH", R.space(ENG), { name: "Engineering" });
        const actions = async () =>
          PageSchema(Strict.AuditEvent)
            .parse(await json(await d.call("GET", R.audit)))
            .items.map((e) => e.action);
        expect(await actions()).toEqual(["space.public_links"]);
        await d.call("PATCH", R.space(ENG), { name: "Eng" });
        expect(await actions()).toEqual(["space.update", "space.public_links"]);
      },
    );

    t(
      "live sync: DELETE on a synced-only row is 409 member_synced",
      async () => {
        await d.fresh({ hosted: true });
        const r = await d.call("DELETE", R.spaceMember(ENG, bob));
        expect(r.status).toBe(409);
        expect((await errCode(r)).code).toBe("member_synced");
        expect((await list(ENG)).items.map((m) => m.userId)).toContain(bob);
      },
    );

    t(
      "frozen sync: raising a synced row is a manual grant (managers up to editor, admins any)",
      async () => {
        await d.fresh({ hosted: { directory: "frozen" } });
        // Admin raises Bob's synced editor (Engineering) to manager.
        expect(
          StrictMember.parse(
            await json(
              await d.call("PUT", R.spaceMember(ENG, bob), { role: "manager" }),
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
        await d.call("PUT", R.spaceMember(EXEC, bob), { role: "manager" });
        await signIn("bob@example.com");
        expect(
          await forbidden(
            await d.call("PUT", R.spaceMember(EXEC, ada), { role: "manager" }),
          ),
        ).toBe("member");
        expect(
          StrictMember.parse(
            await json(
              await d.call("PUT", R.spaceMember(EXEC, ada), { role: "editor" }),
            ),
          ),
        ).toMatchObject({
          role: "editor",
          source: "manual",
          manualRole: "editor",
          syncRole: null,
        });
      },
    );

    t(
      "frozen sync: DELETE removes a synced row; PUT may lower (manual override); audited",
      async () => {
        await d.fresh({ hosted: { directory: "frozen" } });
        const low = StrictMember.parse(
          await json(
            await d.call("PUT", R.spaceMember(ENG, bob), { role: "viewer" }),
          ),
        );
        expect(low).toMatchObject({
          role: "viewer",
          source: "manual",
          manualRole: "viewer",
          syncRole: null,
          groups: [],
        });
        expect((await d.call("DELETE", R.spaceMember(EXEC, ada))).status).toBe(
          204,
        );
        expect((await list(EXEC)).items).toEqual([]);
        const audit = PageSchema(AuditEventSchema).parse(
          await json(await d.call("GET", R.audit)),
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
      },
    );
  });

  describe("hosted mocks: list by space", () => {
    t(
      "scope=space lists one space; scope=spaces lists shared spaces; scope=space without spaceId is 400",
      async () => {
        await d.fresh({ hosted: true });
        const me = Strict.Me.parse(await json(await d.call("GET", R.me)));
        const eng = me.spaces?.find((s) => s.name === "Engineering")
          ?.id as string;
        const pub = await d.call("POST", R.artifacts, {
          title: "in eng",
          format: "html",
          content: "x",
          spaceId: eng,
        });
        expect(pub.status).toBe(201);
        const inEng = (await json(
          await d.call(
            "GET",
            `${R.artifacts}?scope=space&spaceId=${eng}&limit=100`,
          ),
        )) as { items: { title: string; space?: { id: string } }[] };
        expect(inEng.items.map((a) => a.title)).toContain("in eng");
        expect(inEng.items.every((a) => a.space?.id === eng)).toBe(true);
        const shared = (await json(
          await d.call("GET", `${R.artifacts}?scope=spaces&limit=100`),
        )) as { items: { space?: { kind: string } }[] };
        expect(shared.items.every((a) => a.space?.kind === "shared")).toBe(
          true,
        );
        expect((await d.call("GET", `${R.artifacts}?scope=space`)).status).toBe(
          400,
        );
      },
    );
  });

  describe("hosted contract: add-people candidates", () => {
    const EXEC = "SpExcNpQrSt3uVwX";
    const ada = fixtures.members[0]?.id as string;
    const bob = fixtures.members[1]?.id as string;
    const Page = PageSchema(Strict.SpaceCandidate).strict();
    const search = async (space: string, qs = "") => {
      const r = await d.call("GET", `${R.spaceCandidates(space)}${qs}`);
      expect(r.status).toBe(200);
      return Page.parse(await json(r));
    };
    const emails = (p: { items: { email: string }[] }) =>
      p.items.map((m) => m.email);

    t(
      "candidates: active org members by email, with restriction and spaceRole; q and paging",
      async () => {
        await d.fresh({ hosted: true });
        const all = await search(ENG);
        // Carol is suspended: never a candidate. Guests never are either.
        expect(emails(all)).toEqual([
          "ada@example.com",
          "bob@example.com",
          "dan@example.com",
          "erin@example.com",
        ]);
        expect(all.nextCursor).toBeNull();
        const by = (email: string) => all.items.find((m) => m.email === email);
        expect(by("ada@example.com")).toMatchObject({
          id: ada,
          role: "owner",
          restriction: null,
          spaceRole: "manager",
        });
        expect(by("bob@example.com")).toMatchObject({
          id: bob,
          name: "Bob Builder",
          role: "member",
          restriction: null,
          spaceRole: "editor",
        });
        expect(by("erin@example.com")).toMatchObject({
          role: "admin",
          restriction: null,
          spaceRole: null,
        });
        const dan = by("dan@example.com");
        expect(dan?.spaceRole).toBeNull();
        expect(dan?.restriction?.manual).toBe(false);
        expect(dan?.restriction?.groups.map((g) => g.groupId)).toEqual([
          "gCon04",
        ]);
        // q: email or any word of the name, by prefix, case-insensitive.
        expect(emails(await search(ENG, "?q=BO"))).toEqual(["bob@example.com"]);
        expect(emails(await search(ENG, "?q=build"))).toEqual([
          "bob@example.com",
        ]);
        expect(emails(await search(ENG, "?q=uilder"))).toEqual([]);
        // Paged by email, then id.
        const p1 = await search(ENG, "?limit=3");
        expect(emails(p1)).toEqual(emails(all).slice(0, 3));
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await search(
          ENG,
          `?limit=3&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
        );
        expect(emails(p2)).toEqual(emails(all).slice(3));
        expect(p2.nextCursor).toBeNull();
        // Bounded: SPACE_CANDIDATES_MAX (50).
        const big = await d.call("GET", `${R.spaceCandidates(ENG)}?limit=51`);
        expect((await errCode(big)).code).toBe("bad_request");
        // A personal space has no members.
        const own = await d.call("GET", R.spaceCandidates(ada));
        expect((await errCode(own)).code).toBe("space_personal");
      },
    );

    t(
      "candidates: the space's uncapped manager may search it; a member, another space and a capped manager get 404; GET /members stays admin-only",
      async () => {
        await d.fresh({ hosted: true });
        // Dan (restricted) as a manager: the cap makes him a viewer.
        const dan = "Dn8uPqRsTu9vWxYz";
        expect(
          (await d.call("PUT", R.spaceMember(ENG, dan), { role: "manager" }))
            .status,
        ).toBe(200);
        // The people list carries restriction too.
        const people = PageSchema(Strict.SpaceMember)
          .extend({ total: z.number() })
          .parse(await json(await d.call("GET", R.spaceMembers(ENG))));
        const row = (id: string) => people.items.find((m) => m.userId === id);
        expect(row(bob)?.restriction).toBeNull();
        expect(row(dan)?.restriction?.groups.map((g) => g.groupId)).toEqual([
          "gCon04",
        ]);

        // Bob is an editor in Engineering: no search, no member list.
        await d.signIn("bob@example.com");
        const asEditor = await d.call("GET", R.spaceCandidates(ENG));
        expect(asEditor.status).toBe(404);
        expect((await d.call("GET", R.members)).status).toBe(404);

        // Made a manager, he searches Engineering (only).
        await d.signIn("ada@example.com");
        expect(
          (await d.call("PUT", R.spaceMember(ENG, bob), { role: "manager" }))
            .status,
        ).toBe(200);
        await d.signIn("bob@example.com");
        expect(emails(await search(ENG, "?q=erin"))).toEqual([
          "erin@example.com",
        ]);
        expect((await d.call("GET", R.spaceCandidates(EXEC))).status).toBe(404);
        // GET /members stays org-admin only, for a space manager too.
        expect((await d.call("GET", R.members)).status).toBe(404);

        await d.signIn("dan@example.com");
        expect((await d.call("GET", R.spaceCandidates(ENG))).status).toBe(404);

        // An org admin with no role in the space may search it.
        await d.signIn("erin@example.com");
        expect(emails(await search(ENG, "?q=dan"))).toEqual([
          "dan@example.com",
        ]);
      },
    );

    t(
      "space people: restriction's detail only for a caller who can manage the space; others read null and the cap",
      async () => {
        await d.fresh({ hosted: true });
        const dan = "Dn8uPqRsTu9vWxYz";
        expect(
          (await d.call("PUT", R.spaceMember(ENG, dan), { role: "editor" }))
            .status,
        ).toBe(200);
        const danRow = async () => {
          const r = await d.call("GET", R.spaceMembers(ENG));
          expect(r.status).toBe(200);
          return PageSchema(Strict.SpaceMember)
            .extend({ total: z.number() })
            .parse(await json(r))
            .items.find((m) => m.userId === dan);
        };
        // The owner (org admin) sees the detail.
        const asOwner = await danRow();
        expect(asOwner?.cap).toBe("restricted");
        expect(asOwner?.restriction?.groups.map((g) => g.groupId)).toEqual([
          "gCon04",
        ]);
        // Bob, an editor: the cap only.
        await d.signIn("bob@example.com");
        expect(await danRow()).toMatchObject({
          cap: "restricted",
          restriction: null,
        });
        // Dan himself (capped): the cap only.
        await d.signIn("dan@example.com");
        expect(await danRow()).toMatchObject({
          cap: "restricted",
          restriction: null,
        });
        // Bob made a manager: the detail.
        await d.signIn("ada@example.com");
        expect(
          (await d.call("PUT", R.spaceMember(ENG, bob), { role: "manager" }))
            .status,
        ).toBe(200);
        await d.signIn("bob@example.com");
        expect(
          (await danRow())?.restriction?.groups.map((g) => g.groupId),
        ).toEqual(["gCon04"]);
      },
    );
  });

  describe("hosted mocks: reset a Google link", () => {
    const byEmail = async (email: string) =>
      (
        (await json(await d.call("GET", R.members))) as {
          id: string;
          email: string;
          identities?: string[];
        }[]
      ).find((m) => m.email === email);

    t("the owner resets an active member's and an admin's link", async () => {
      await d.fresh({ hosted: true });
      const bob = await byEmail("bob@example.com");
      const erin = await byEmail("erin@example.com");
      expect(bob?.identities).toEqual(["google"]);
      expect(erin?.identities).toEqual(["google"]);
      expect(
        (await d.call("DELETE", R.memberIdentity(bob?.id as string, "google")))
          .status,
      ).toBe(204);
      expect(
        (await d.call("DELETE", R.memberIdentity(erin?.id as string, "google")))
          .status,
      ).toBe(204);
    });

    t(
      "an admin can't reset a peer admin (owner_only) but can reset a member",
      async () => {
        await d.fresh({ hosted: { actAs: "admin" } });
        const bob = await byEmail("bob@example.com");
        const erin = await byEmail("erin@example.com");
        const r = await d.call(
          "DELETE",
          R.memberIdentity(erin?.id as string, "google"),
        );
        expect(r.status).toBe(403);
        expect((await errCode(r)).code).toBe("owner_only");
        expect(
          (
            await d.call(
              "DELETE",
              R.memberIdentity(bob?.id as string, "google"),
            )
          ).status,
        ).toBe(204);
      },
    );

    t(
      "an admin resetting an unlinked admin gets owner_only too (by role, not link)",
      async () => {
        await d.fresh({ hosted: { actAs: "admin" } });
        const dan = await byEmail("dan@example.com");
        expect(dan?.identities).toEqual([]);
        const id = dan?.id as string;
        // Before the promotion, an unlinked member is 404 (nothing to reset).
        expect(
          (await d.call("DELETE", R.memberIdentity(id, "google"))).status,
        ).toBe(404);
        expect(
          (await d.call("PATCH", R.member(id), { role: "admin" })).status,
        ).toBe(200);
        const r = await d.call("DELETE", R.memberIdentity(id, "google"));
        expect(r.status).toBe(403);
        expect((await errCode(r)).code).toBe("owner_only");
      },
    );

    t(
      "an admin resetting the owner's link gets owner_only; the owner's own stays 404",
      async () => {
        await d.fresh({ hosted: { actAs: "admin" } });
        const ada = await byEmail("ada@example.com");
        const r = await d.call(
          "DELETE",
          R.memberIdentity(ada?.id as string, "google"),
        );
        expect(r.status).toBe(403);
        expect((await errCode(r)).code).toBe("owner_only");
        await d.fresh({ hosted: true });
        expect(
          (
            await d.call(
              "DELETE",
              R.memberIdentity(ada?.id as string, "google"),
            )
          ).status,
        ).toBe(404);
      },
    );
  });

  describe("hosted mocks: acting on an owner or admin is owner-only (#475)", () => {
    const byEmail = async (email: string) =>
      (
        (await json(await d.call("GET", R.members))) as {
          id: string;
          email: string;
          role: string;
        }[]
      ).find((m) => m.email === email);

    t(
      "an admin can't change an admin's or the owner's role, or remove them (403 owner_only)",
      async () => {
        await d.fresh({ hosted: { actAs: "admin" } });
        const erin = await byEmail("erin@example.com");
        const ada = await byEmail("ada@example.com");
        for (const id of [erin?.id, ada?.id] as string[]) {
          const p = await d.call("PATCH", R.member(id), { role: "member" });
          expect(p.status).toBe(403);
          expect((await errCode(p)).code).toBe("owner_only");
          const del = await d.call("DELETE", R.member(id));
          expect(del.status).toBe(403);
          expect((await errCode(del)).code).toBe("owner_only");
        }
        expect((await byEmail("erin@example.com"))?.role).toBe("admin");
      },
    );

    t("an admin still manages members", async () => {
      await d.fresh({ hosted: { actAs: "admin" } });
      const bob = await byEmail("bob@example.com");
      const dan = await byEmail("dan@example.com");
      expect(
        (await d.call("PATCH", R.member(bob?.id as string), { role: "admin" }))
          .status,
      ).toBe(200);
      expect((await d.call("DELETE", R.member(dan?.id as string))).status).toBe(
        204,
      );
    });

    t(
      "the owner changes an admin's role and removes them; the owner on themselves stays 400",
      async () => {
        await d.fresh({ hosted: true });
        const erin = await byEmail("erin@example.com");
        const ada = await byEmail("ada@example.com");
        const p = await d.call("PATCH", R.member(erin?.id as string), {
          role: "member",
        });
        expect(p.status).toBe(200);
        expect(
          (
            await d.call("PATCH", R.member(erin?.id as string), {
              role: "admin",
            })
          ).status,
        ).toBe(200);
        expect(
          (await d.call("DELETE", R.member(erin?.id as string))).status,
        ).toBe(204);
        expect(
          (
            await d.call("PATCH", R.member(ada?.id as string), {
              role: "member",
            })
          ).status,
        ).toBe(400);
        expect(
          (await d.call("DELETE", R.member(ada?.id as string))).status,
        ).toBe(400);
      },
    );
  });

  return { names, mswOnly };
}
