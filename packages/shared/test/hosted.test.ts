// The hosted contract on the MSW mock: the schema cases here, and every
// request case (hosted-contract.ts) with the mock as the driver. The same
// request cases run against the real server in
// apps/server/test/hosted.contract.test.ts.
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ApiErrorSchema,
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
  GUEST_SHARES_NOTICE_LIMIT,
  HELD_SNOOZE_MS,
  HELD_SNOOZE_REASON_MAX,
  HealthzSchema,
  INVITE_UNREACHABLE_MESSAGE,
  InviteUnreachableDetailsSchema,
  ListQuerySchema,
  MemberInviteResultSchema,
  MemberOwnsArtifactsDetailsSchema,
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
  ShareResultSchema,
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

// #1077 item 3: the held-snooze handlers as the server answers
// (apps/server/src/routes/directory.ts, directory/sync.ts, health.ts heldAt).
describe("mock held snooze matches the server (#1077)", () => {
  const SALES = "gSales03";
  const CON = "gCon04";
  type Held = {
    groupId: string;
    snoozedUntil: string | null;
    snoozeReason: string | null;
  };
  const fresh = (o: Record<string, unknown> = {}) => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: { ...o } }));
  };
  const snooze = (g: string, body?: unknown) =>
    call("POST", R.directoryHeldSnooze(g), body);
  const heldOf = async (r: Response) =>
    ((await r.json()) as { held: Held[] }).held;
  const code = async (r: Response) =>
    ((await r.json()) as { error: { code: string; message: string } }).error;
  afterEach(() => vi.useRealTimers());

  it("refusals: unreadable or missing hold 409 conflict; admin 404", async () => {
    fresh({ heldUnreadable: true });
    const s = await snooze(CON);
    expect(s.status).toBe(409);
    expect(await code(s)).toEqual({
      code: "conflict",
      message:
        "This group has no held sweep to snooze, or it is being re-checked; try again after the next sync",
    });
    expect((await snooze("gNone")).status).toBe(409);
    const c = await call("POST", R.directoryHeldConfirm(CON));
    expect(c.status).toBe(409);
    expect(await code(c)).toEqual({
      code: "conflict",
      message:
        "This group has no held sweep to confirm; it can't be read from Google",
    });
    expect((await call("POST", R.directoryHeldConfirm("gNone"))).status).toBe(
      409,
    );
    // Body errors come before the hold check, as on the server.
    const bad = await snooze("gNone", { reason: 1 });
    expect(bad.status).toBe(400);
    expect((await code(bad)).message).toBe("Invalid request body");
    fresh({ actAs: "admin" });
    expect((await snooze(SALES)).status).toBe(404);
    expect((await call("DELETE", R.directoryHeldSnooze(SALES))).status).toBe(
      404,
    );
    expect((await call("POST", R.directoryHeldConfirm(SALES))).status).toBe(
      404,
    );
  });

  it("reason: cleaned, then capped by code points with an ellipsis", async () => {
    fresh();
    // Astral chars are 2 UTF-16 units each: a .slice cap would cut at 100.
    const astral = "\u{1F600}".repeat(HELD_SNOOZE_REASON_MAX);
    let [h] = await heldOf(await snooze(SALES, { reason: astral }));
    expect(h?.snoozeReason).toBe(astral);
    [h] = await heldOf(await snooze(SALES, { reason: `${astral}x` }));
    expect(Array.from(h?.snoozeReason ?? "")).toHaveLength(
      HELD_SNOOZE_REASON_MAX,
    );
    expect(h?.snoozeReason).toBe(
      `${"\u{1F600}".repeat(HELD_SNOOZE_REASON_MAX - 1)}…`,
    );
    // Unsafe chars become spaces, runs collapse, then trim.
    [h] = await heldOf(
      await snooze(SALES, { reason: "  a\n\u200Bb\u202E  c\t " }),
    );
    expect(h?.snoozeReason).toBe("a b c");
    [h] = await heldOf(await snooze(SALES, { reason: " \u0000\u2028 " }));
    expect(h?.snoozeReason).toBeNull();
  });

  it.each(["off", "frozen"] as const)(
    "directory %s: snooze and confirm 409 directory_sync_off; DELETE works",
    async (directory) => {
      fresh({ directory });
      for (const r of [
        await snooze(SALES),
        await call("POST", R.directoryHeldConfirm(SALES)),
      ]) {
        expect(r.status).toBe(409);
        expect(await code(r)).toEqual({
          code: "directory_sync_off",
          message: "Directory sync is off or frozen",
        });
      }
      expect((await call("DELETE", R.directoryHeldSnooze(SALES))).status).toBe(
        200,
      );
    },
  );

  it("an expired snooze reads as none (GET, /me heldSweeps, snooze replies)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-02T00:00:00.000Z");
    vi.setSystemTime(t0);
    fresh();
    const [h] = await heldOf(await snooze(SALES, { reason: "later" }));
    expect(h?.snoozedUntil).toBe(new Date(t0 + HELD_SNOOZE_MS).toISOString());
    const dir = async () => heldOf(await call("GET", R.directory));
    const dot = async () =>
      (
        (await (await call("GET", R.me)).json()) as {
          instance: { directory: { heldSweeps: number } };
        }
      ).instance.directory.heldSweeps;
    vi.setSystemTime(t0 + HELD_SNOOZE_MS - 1);
    expect((await dir())[0]?.snoozeReason).toBe("later");
    expect(await dot()).toBe(0);
    // until <= now: no longer snoozed.
    vi.setSystemTime(t0 + HELD_SNOOZE_MS);
    expect((await dir())[0]).toMatchObject({
      snoozedUntil: null,
      snoozeReason: null,
    });
    expect(await dot()).toBe(1);
    expect(
      (await heldOf(await call("POST", R.directorySync)))[0],
    ).toMatchObject({ snoozedUntil: null });
    // A snooze of the expired one is a renewal (the row is still there).
    await snooze(SALES);
    const audit = (await (await call("GET", R.audit)).json()) as {
      items: { action: string; detail: Record<string, unknown> | null }[];
    };
    const snoozed = audit.items.filter(
      (e) => e.action === "directory.sweep.snoozed",
    );
    expect(snoozed.map((e) => e.detail?.renewed)).toEqual([true, false]);
  });
});

describe("mock move after losing the space role (review of #792)", () => {
  it("a stale manager level can't move the artifact out", async () => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: true }));
    const me = (await (await call("GET", R.me)).json()) as {
      user: { id: string };
      spaces: { id: string; name: string }[];
    };
    const eng = me.spaces.find((s) => s.name === "Engineering")?.id as string;
    const notes = fixtures.artifacts.find((a) => a.title === "Meeting notes")
      ?.id as string;
    const to = (await (
      await call("POST", R.spaces, { name: "Sales" })
    ).json()) as { id: string };
    // Still a manager of Engineering: the move works, and back again.
    expect(
      (await call("POST", R.moveArtifact(notes), { spaceId: to.id })).status,
    ).toBe(200);
    expect(
      (await call("POST", R.moveArtifact(notes), { spaceId: eng })).status,
    ).toBe(200);
    // Removed from Engineering (allMembersRole viewer remains): 404.
    expect((await call("DELETE", R.spaceMember(eng, me.user.id))).status).toBe(
      204,
    );
    const r = await call("POST", R.moveArtifact(notes), { spaceId: to.id });
    expect(r.status).toBe(404);
  });

  // refresh() leaves a hidden artifact's last level (and so its can) as it
  // was: only the handlers' own checks refuse it.
  it("a hidden artifact (no role, share or visibility left) can't move", async () => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: true }));
    const me = (await (await call("GET", R.me)).json()) as {
      user: { id: string };
      spaces: { id: string; name: string }[];
    };
    const eng = me.spaces.find((s) => s.name === "Engineering")?.id as string;
    const sales = (await (
      await call("POST", R.spaces, { name: "Sales" })
    ).json()) as { id: string };
    const pub = await call("POST", R.artifacts, {
      title: "Plan",
      format: "html",
      content: "x",
      visibility: "private",
      spaceId: sales.id,
    });
    expect(pub.status).toBe(201);
    const { id } = (await pub.json()) as { id: string };
    expect(
      (await call("DELETE", R.spaceMember(sales.id, me.user.id))).status,
    ).toBe(204);
    const r = await call("POST", R.moveArtifact(id), { spaceId: eng });
    expect(r.status).toBe(404);
  });

  // A personal level isn't recomputed per caller: after signing in as Bob,
  // Ada's personal artifact still says owner (can.move, can.transfer).
  const asBob = async () => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: true }));
    await msw.signIn("bob@example.com");
    const me = (await (await call("GET", R.me)).json()) as {
      user: { email: string };
      spaces: { id: string; name: string }[];
    };
    expect(me.user.email).toBe("bob@example.com");
    const adas = fixtures.artifacts.find(
      (a) => a.access === "owner" && a.owner.id === fixtures.members[0]?.id,
    )?.id as string;
    return { me, adas };
  };

  it("someone else's personal artifact can't move, whatever its last can", async () => {
    const { me, adas } = await asBob();
    const eng = me.spaces.find((s) => s.name === "Engineering")?.id as string;
    const r = await call("POST", R.moveArtifact(adas), { spaceId: eng });
    expect(r.status).toBe(404);
  });

  it("someone else's personal artifact can't be transferred, whatever its last can", async () => {
    const { adas } = await asBob();
    const r = await call("POST", R.transferArtifact(adas), {
      userId: fixtures.members[0]?.id as string,
    });
    expect(r.status).toBe(404);
  });
});

describe("mock ShareResult.recipient (review item 37)", () => {
  const share = async (email: string, providers?: ("google" | "email")[]) => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: providers ? { providers } : {} }));
    const id = fixtures.artifacts.find((a) => a.access === "owner")?.id;
    const r = await call("PUT", R.shares(id ?? ""), {
      email,
      role: "viewer",
    });
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };

  it("in-domain non-member: needs_invite; a member or an outside guest: none", async () => {
    expect((await share("new@example.com")).recipient).toEqual({
      canSignIn: false,
      reason: "needs_invite",
    });
    expect((await share("guest@elsewhere.com")).recipient).toBeUndefined();
    expect((await share("guest@elsewhere.com", ["google"])).recipient).toEqual({
      canSignIn: false,
      reason: "outside_domains",
    });
  });
});

describe("mock signInMethods (#799)", () => {
  const use = (providers?: ("google" | "email")[]) => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: providers ? { providers } : {} }));
  };
  const shareTo = async (email: string) => {
    const id = fixtures.artifacts.find((a) => a.access === "owner")?.id;
    const r = await call("PUT", R.shares(id ?? ""), { email, role: "viewer" });
    return ShareResultSchema.parse(await r.json()).signInMethods;
  };
  const inviteTo = async (email: string) => {
    const r = await call("POST", R.members, { email, role: "member" });
    return MemberInviteResultSchema.parse(await r.json()).signInMethods;
  };

  it("matches the server's reach for each case, in SIGN_IN_METHOD_ORDER", async () => {
    use();
    expect(await shareTo("new@example.com")).toEqual([]);
    expect(await shareTo("guest@elsewhere.com")).toEqual(["email"]);
    expect(await inviteTo("in@example.com")).toEqual(["google"]);
    expect(await inviteTo("sec@secondary.com")).toEqual(["google"]);
    use(["email"]);
    expect(await inviteTo("in2@example.com")).toEqual(["email"]);
    use(["google"]);
    expect(await shareTo("guest@elsewhere.com")).toEqual([]);
  });
});

describe("mock invite reachability (review item 11)", () => {
  const use = (providers: ("google" | "email")[]) => {
    server.resetHandlers();
    server.use(...createHandlers({ hosted: { providers } }));
  };
  const invite = (email: string) =>
    call("POST", R.members, { email, role: "member" });

  it("email only, outside the domain: 400 invite_unreachable", async () => {
    use(["email"]);
    const r = await invite("out@elsewhere.com");
    expect(r.status).toBe(400);
    const { error } = ApiErrorSchema.parse(await r.json());
    expect(error.code).toBe("invite_unreachable");
    expect(InviteUnreachableDetailsSchema.parse(error.details)).toEqual({
      field: "email",
      reason: "outside_domains",
    });
    expect(error.message).toBe(INVITE_UNREACHABLE_MESSAGE.outside_domains);
  });

  it("Google on, outside the domain: 201 with signIn uncertain", async () => {
    use(["google", "email"]);
    const r = await invite("sec@secondary.com");
    expect(r.status).toBe(201);
    expect(MemberInviteResultSchema.parse(await r.json()).signIn).toEqual({
      status: "uncertain",
      reason: "outside_domains",
    });
  });

  it("in the domain: 201, no flag", async () => {
    use(["email"]);
    const r = await invite("new@example.com");
    expect(r.status).toBe(201);
    expect(
      MemberInviteResultSchema.parse(await r.json()).signIn,
    ).toBeUndefined();
  });
});

describe("mock lapsed guests (#829 review item 3)", () => {
  const LAPSED = "gone@elsewhere.com";
  const use = (providers: ("google" | "email")[]) => {
    server.resetHandlers();
    server.use(
      ...createHandlers({ hosted: { providers, lapsedGuests: [LAPSED] } }),
    );
  };

  it.each([[["google", "email"]], [["email"]]] as const)(
    "%j: inviting a lapsed guest is 409 guest_lapsed, never member_removed; nothing created",
    async (providers) => {
      use([...providers]);
      const r = await call("POST", R.members, {
        email: LAPSED,
        role: "member",
      });
      expect(r.status).toBe(409);
      const { error } = ApiErrorSchema.parse(await r.json());
      expect(error.code).toBe("guest_lapsed");
      expect(error.details).toBeUndefined();
      const all = MemberSchema.array().parse(
        await (await call("GET", `${R.members}?status=removed`)).json(),
      );
      expect(all.filter((m) => m.email === LAPSED)).toHaveLength(1);
    },
  );

  it("restoring a lapsed guest is 409 guest_lapsed; they stay a removed guest", async () => {
    use(["google", "email"]);
    const all = MemberSchema.array().parse(
      await (await call("GET", `${R.members}?status=removed`)).json(),
    );
    const g = all.find((m) => m.email === LAPSED);
    expect(g).toMatchObject({ role: "guest", status: "removed" });
    const r = await call("POST", R.memberRestore(g?.id ?? ""));
    expect(r.status).toBe(409);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
      "guest_lapsed",
    );
  });

  it("#1204 erase: a removed person with nothing left goes for good; idempotent; restore is member_erased", async () => {
    use(["google", "email"]);
    const removed = async () =>
      MemberSchema.array().parse(
        await (await call("GET", `${R.members}?status=removed`)).json(),
      );
    const g = (await removed()).find((m) => m.email === LAPSED);
    const id = g?.id ?? "";
    expect((await call("POST", R.memberErase(id))).status).toBe(204);
    expect((await call("POST", R.memberErase(id))).status).toBe(204);
    expect((await removed()).map((m) => m.id)).not.toContain(id);
    const r = await call("POST", R.memberRestore(id));
    expect(r.status).toBe(409);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
      "member_erased",
    );
    // The address is free: an invite makes a new person.
    const inv = await call("POST", R.members, {
      email: LAPSED,
      role: "member",
    });
    expect(inv.status).toBe(201);
    expect(MemberSchema.parse(await inv.json()).id).not.toBe(id);
  });

  it("#1204 erase refusals: member_active for an active or suspended person, 404 unknown", async () => {
    use(["google", "email"]);
    // Dan is active; Carol is suspended (not removed).
    for (const id of ["Dn8uPqRsTu9vWxYz", "Cr7tNpQrSt8uVwXy"]) {
      const r = await call("POST", R.memberErase(id));
      expect(r.status).toBe(409);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
        "member_active",
      );
    }
    expect((await call("POST", R.memberErase("Nobody0000000000"))).status).toBe(
      404,
    );
    // The details schema the server sends with member_owns_artifacts.
    expect(
      MemberOwnsArtifactsDetailsSchema.safeParse({ live: 2, deleted: -1 })
        .success,
    ).toBe(false);
  });
});

describe("mock guest share notices (parity 2)", () => {
  const notices = async () =>
    MeSchema.parse(await (await call("GET", R.me)).json()).notices;
  const dismiss = (id: "guest_shares" | "guest_summary") =>
    call("POST", R.noticeDismiss(id));

  it("Access-only self-host: the caller's shares, capped at the limit with more, until dismissed (per user)", async () => {
    server.use(
      ...createHandlers({
        hosted: {
          selfHosted: true,
          guestShares: GUEST_SHARES_NOTICE_LIMIT + 1,
        },
      }),
    );
    const n = (await notices())?.guestShares;
    expect(n?.items).toHaveLength(GUEST_SHARES_NOTICE_LIMIT);
    expect(n?.more).toBe(true);
    expect(n?.items[0]).toMatchObject({
      title: "Landing page",
      guestEmail: `guest${GUEST_SHARES_NOTICE_LIMIT + 1}@outside.example`,
      role: "editor",
    });
    expect((await dismiss("guest_shares")).status).toBe(204);
    const after = await notices();
    expect(after?.guestShares).toBeUndefined();
    // The owner's summary is separate: counts only, no titles.
    expect(after?.guestSummary).toEqual({
      shares: GUEST_SHARES_NOTICE_LIMIT + 1,
      owners: 1,
      guestOwners: [],
      more: false,
    });
    expect((await dismiss("guest_shares")).status).toBe(204);
  });

  it("guestOwners: the owner's summary lists guests who own artifacts, until dismissed; transfer takes a guest", async () => {
    server.use(
      ...createHandlers({ hosted: { selfHosted: true, guestOwners: 2 } }),
    );
    const n = await notices();
    expect(n?.guestShares).toBeUndefined();
    expect(n?.guestSummary).toEqual({
      shares: 0,
      owners: 0,
      guestOwners: [
        {
          userId: "Go0001AbCdEfGhIj",
          email: "owner1@outside.example",
          artifacts: 1,
          status: "active",
        },
        {
          userId: "Go0002AbCdEfGhIj",
          email: "owner2@outside.example",
          artifacts: 1,
          status: "active",
        },
      ],
      more: false,
    });
    // An active guest: no suspension needed.
    const sum = await call("GET", R.memberTransfer("Go0001AbCdEfGhIj"));
    expect(sum.status).toBe(200);
    expect(await sum.json()).toEqual({ live: 1, deleted: 0 });
    const t = await call("POST", R.memberTransfer("Go0001AbCdEfGhIj"), {
      to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" },
    });
    expect(t.status).toBe(200);
    expect((await notices())?.guestSummary?.guestOwners).toHaveLength(1);
    expect((await dismiss("guest_summary")).status).toBe(204);
    expect(await notices()).toBeUndefined();
  });

  it("spaces off: to user works; to space is 404 for a real, unknown or personal id; spaces routes are 404", async () => {
    const spaceOn = createHandlers({
      hosted: { selfHosted: true, guestOwners: 3, spaces: true },
    });
    server.use(...spaceOn);
    const ENG = "SpEngNpQrSt2uVwX";
    const go = (to: object, id = "Go0001AbCdEfGhIj") =>
      call("POST", R.memberTransfer(id), { to });
    expect((await go({ kind: "space", spaceId: ENG })).status).toBe(200);
    server.resetHandlers();
    server.use(
      ...createHandlers({ hosted: { selfHosted: true, guestOwners: 3 } }),
    );
    const me = MeSchema.parse(await (await call("GET", R.me)).json());
    expect(me.instance.features).not.toContain("spaces");
    expect(me.spaces).toBeUndefined();
    expect((await call("GET", R.spaces)).status).toBe(404);
    for (const spaceId of [ENG, "SpNoSuchSpaceXyz", "Ab3dEfGhJk4mNpQr"]) {
      const r = await go({ kind: "space", spaceId });
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: { code: "not_found" } });
    }
    expect(
      (await go({ kind: "user", userId: "Bc4eFgHjKm5nPqRs" })).status,
    ).toBe(200);
    // An active non-guest isn't a source.
    expect(
      (await call("GET", R.memberTransfer("Bc4eFgHjKm5nPqRs"))).status,
    ).toBe(409);
  });

  it("absent with no guest shares, on hosted, and on direct sign-in; admins get no summary (dismiss 404)", async () => {
    server.use(...createHandlers({ hosted: { selfHosted: true } }));
    expect(await notices()).toBeUndefined();
    server.resetHandlers();
    server.use(...createHandlers({ hosted: { guestShares: 2 } }));
    expect(await notices()).toBeUndefined();
    server.resetHandlers();
    server.use(
      ...createHandlers({
        hosted: { selfHosted: true, guestShares: 2, mode: "direct" },
      }),
    );
    expect(await notices()).toBeUndefined();
    server.resetHandlers();
    server.use(
      ...createHandlers({
        hosted: { selfHosted: true, guestShares: 2, actAs: "admin" },
      }),
    );
    const n = await notices();
    // The admin owns "Landing page" here, so they see their own shares.
    expect(n?.guestShares?.items).toHaveLength(2);
    expect(n?.guestSummary).toBeUndefined();
    expect((await dismiss("guest_summary")).status).toBe(404);
    expect((await dismiss("guest_shares")).status).toBe(204);
    expect((await call("POST", "/api/v1/notices/nope/dismiss")).status).toBe(
      404,
    );
  });

  it("transfer: an active member is 409 member_active; an admin on an admin source is 403 owner_only", async () => {
    server.use(...createHandlers({ hosted: { selfHosted: true } }));
    const dan = await call("GET", R.memberTransfer("Dn8uPqRsTu9vWxYz"));
    expect(dan.status).toBe(409);
    server.resetHandlers();
    server.use(...createHandlers({ hosted: { actAs: "admin" } }));
    const erin = await call("GET", R.memberTransfer("Er9vQrStUv0wXyZa"));
    expect(erin.status).toBe(403);
    expect(ApiErrorSchema.parse(await erin.json()).error.code).toBe(
      "owner_only",
    );
  });
});

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
    expect(
      artifactCan("viewer", { personal: false, dataWriters: "viewers" }),
    ).toEqual({
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
    // #681: dataWriters "editors" takes data writes from viewers only.
    const dw = (
      level: "viewer" | "editor" | "owner",
      d?: "editors" | "viewers",
    ) => artifactCan(level, { personal: true, dataWriters: d }).dataWrite;
    expect(dw("viewer", "editors")).toBe(false);
    expect(dw("viewer", "viewers")).toBe(true);
    // Left out: "editors" (fail closed), as the server's can().
    expect(dw("viewer")).toBe(false);
    expect(dw("editor")).toBe(true);
    expect(dw("editor", "editors")).toBe(true);
    expect(dw("owner", "editors")).toBe(true);
    expect(
      artifactCan("owner", {
        personal: true,
        cap: "guest",
        dataWriters: "viewers",
      }).dataWrite,
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
