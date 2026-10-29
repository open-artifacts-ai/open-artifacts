/**
 * Hosted M1 MSW mocks, opt-in via createHandlers({ hosted }). Off (the
 * default), nothing here runs and every existing response is unchanged.
 *
 * In-memory store: spaces (a personal space per member, id = user id, plus
 * shared "Engineering" (caller manager), "Exec" (caller viewer, publicLinks
 * off) and "Clients" (no role: admin view)); space members keyed by user id;
 * group mappings; restricted groups; directory status; audit; a suspended
 * member (Carol) with personal artifacts to transfer. Every-space (org)
 * mappings are one row per group, merged into each shared space's members at
 * read time (never written as per-space rows). Settings.spaceManagerMappings
 * (default on) lets space managers map groups to viewer/editor. Every artifact gets
 * `space` and `can` (artifactCan) on each request; "Meeting notes" lives in
 * Engineering, so its access is "manager".
 *
 * Sign-in: AUTH.providers per options; the code flow accepts
 * HOSTED_MOCK_CODE for the last requested address (5 tries, then expired;
 * 10 failures per address, then 429; 6+ requests per address, then 429).
 * A successful verify signs the mock in as that address: an existing member,
 * a new member for MOCK_DOMAIN, else a guest (readOnly).
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import type { z } from "zod";
import { type ErrorCode, INVITE_UNREACHABLE_MESSAGE } from "../errors.js";
import {
  MembersQuerySchema,
  MoveArtifactInputSchema,
  TRANSFER_PAGE,
  TransferArtifactInputSchema,
  TransferInputSchema,
} from "../hosted/artifacts.js";
import {
  type AuthProviders,
  CODE_POLICY,
  CodeRequestSchema,
  CodeVerifySchema,
  normalizeCode,
} from "../hosted/auth.js";
import {
  BillingCheckoutInputSchema,
  type PlanRefusalDetails,
  type PlanView,
} from "../hosted/billing.js";
import {
  artifactCan,
  type CapReason,
  type DirectoryMode,
  type FeatureFlag,
  type GroupRef,
  type MySpace,
  orderSignInMethods,
  type SignInProviderId,
  type SpaceRef,
  type SpaceRole,
  type Tier,
} from "../hosted/core.js";
import type {
  AuditAction,
  AuditEvent,
  DirectoryGroup,
  SyncStatus,
} from "../hosted/directory.js";
import {
  type GroupMapping,
  GroupMappingPutSchema,
  MANAGED_BY_ORG_MAPPING_MESSAGE,
  type RestrictedGroup,
  SPACE_MANAGER_FIELDS,
  SPACE_MANAGER_MAPPING_ROLES,
  type Space,
  type SpaceCandidate,
  SpaceCandidatesQuerySchema,
  SpaceCreateSchema,
  type SpaceMember,
  type SpaceMemberGroup,
  SpaceMemberPutSchema,
  SpaceMembersQuerySchema,
  SpacePatchSchema,
} from "../hosted/spaces.js";
import { OtpLatestInputSchema } from "../hosted/test-hooks.js";
import { newId } from "../ids.js";
import type {
  AccessLevel,
  ArtifactSummary,
  Me,
  Member,
  PublishInput,
  Share,
  ShareRecipient,
} from "../schemas.js";
import { MemberInviteSchema, SettingsPatchSchema } from "../schemas.js";

/** The code the mock accepts (any address). */
export const HOSTED_MOCK_CODE = "24681357";
/** The mock's verified Workspace domain. */
export const MOCK_DOMAIN = "example.com";

export type HostedMockOptions = {
  /** Sign-in mode (default "direct"). "access" lists only Access. */
  mode?: "access" | "direct";
  /** A self-hosted install (AuthProviders.hosted and Me.instance.hosted false); default false (hosted). */
  selfHosted?: boolean;
  /** Direct-mode providers (default both). */
  providers?: ("google" | "email")[];
  /** Code requests need a Turnstile token (default false). Token "fail" is refused. */
  turnstile?: boolean;
  tier?: Tier | null;
  /** Directory binding mode (default "google"). */
  directory?: DirectoryMode;
  /** The failing state when unhealthy (default "backoff"). */
  unhealthyState?:
    | "backoff"
    | "auth_failed"
    | "customer_mismatch"
    | "scope_missing";
  /** Sync unhealthy for 2 h: banner and tokensUnverified (default false). */
  unhealthy?: boolean;
  /**
   * With unhealthy: the outage began, and the last success was, 8 d ago, so
   * staleAt (lastSuccessAt + 7 d) has passed and is reported (default false).
   */
  stale?: boolean;
  /**
   * The caller is the org owner refused by a customer_mismatch: GET R.me
   * answers 401 break_glass_required with details { fresh } ("fresh": the
   * session meets break-glass; "stale": sign in again with reauth=1).
   */
  breakGlass?: "fresh" | "stale";
  /** Act as the owner (default) or as an admin, e.g. to test owner-only actions. */
  actAs?: "owner" | "admin";
  /**
   * Start in pending_confirm with SyncStatus.pendingCustomerChange set: a
   * consent for another Google Workspace than the one a disconnect during
   * customer_mismatch removed.
   */
  pendingCustomerChange?: NonNullable<SyncStatus["pendingCustomerChange"]>;
  /**
   * Me.instance.billing (self-serve billing). Default: business, active, not
   * read-only. Owner and admins see status, dates and creatorsThisMonth; the
   * mock nulls them for everyone else, as the server does. With readOnly, or
   * tier "free" and a trial already used (trialEndsAt set), POST members
   * answers 403 plan_read_only / plan_required (details PlanRefusalDetails).
   */
  billing?: PlanView;
  /** POST R.billingCheckout / R.billingPortal / R.billingUsage answer 503 billing_unavailable. */
  billingDown?: boolean;
  /** Extra FEATURES flags beyond the defaults (spaces, content_revocation, usage_off, plus the sync flag). guests_read_only is ignored: it is reported from the sign-in config (on when google or email is enabled). */
  features?: FeatureFlag[];
};

type Body = <T extends z.ZodType>(
  req: Request,
  schema: T,
) => Promise<
  | { error: Response; data?: undefined }
  | { data: z.infer<T>; error?: undefined }
>;

export type HostedCtx = {
  me: Me;
  members: Member[];
  artifacts: ArtifactSummary[];
  shares: Record<string, Share[]>;
  err: (code: ErrorCode, message: string, details?: unknown) => Response;
  body: Body;
  isAnon: (req: Request) => boolean;
};

type SpaceRow = {
  id: string;
  kind: "personal" | "shared";
  name: string;
  ownerId: string | null;
  allMembersRole: SpaceRole | null;
  publicLinks: boolean;
  createdAt: string;
};
type MemberRow = {
  userId: string;
  manualRole: SpaceRole | null;
  syncRole: SpaceRole | null;
  groups: GroupRef[];
};

const T0 = "2026-01-01T00:00:00.000Z";
const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, manager: 3 };
const maxRole = (...r: (SpaceRole | null | undefined)[]): SpaceRole | null =>
  r.reduce<SpaceRole | null>(
    (a, b) => (b && (!a || RANK[b] > RANK[a]) ? b : a),
    null,
  );
const iso = () => new Date().toISOString();
const noContent = () => new HttpResponse(null, { status: 204 });
const page = <T>(all: T[], q: URLSearchParams, def = 50) => {
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || def));
  const start = Number(q.get("cursor") ? atob(q.get("cursor") as string) : 0);
  const next = start + limit;
  return HttpResponse.json({
    items: all.slice(start, next),
    nextCursor: next < all.length ? btoa(String(next)) : null,
  });
};
const mask = (email: string) => {
  const [l = "", d = ""] = email.split("@");
  return `${l.slice(0, 1)}***@${d}`;
};

export type HostedMock = ReturnType<typeof createHostedMock>;

export function createHostedMock(o: HostedMockOptions, c: HostedCtx) {
  const { me, members, artifacts, shares, err } = c;
  const notFound = () => err("not_found", "Not found");
  const directoryMode: DirectoryMode = o.directory ?? "google";
  const mode = o.mode ?? "direct";
  const providerIds = o.providers ?? ["google", "email"];

  // ---- members: status, identities, a departed member --------------------
  for (const m of members) {
    m.status = "active";
    // Owners and active members are Google-linked, so reset can be shown.
    m.identities = m.role === "guest" ? [] : ["google"];
    // A Google link means they have signed in (Bob: two days before Ada).
    if (m.identities.length && !m.lastSeenAt)
      m.lastSeenAt = "2026-01-01T10:00:00.000Z";
  }
  const erin: Member = {
    id: "Er9vQrStUv0wXyZa",
    email: "erin@example.com",
    name: "Erin Admin",
    role: "admin",
    lastSeenAt: "2026-01-02T09:00:00.000Z",
    status: "active",
    identities: ["google"],
  };
  const carol: Member = {
    id: "Cr7tNpQrSt8uVwXy",
    email: "carol@example.com",
    name: "Carol Departed",
    role: "member",
    lastSeenAt: "2025-12-01T10:00:00.000Z",
    status: "suspended",
    identities: ["google"],
  };
  const dan: Member = {
    id: "Dn8uPqRsTu9vWxYz",
    email: "dan@example.com",
    name: "Dan Contractor",
    role: "member",
    lastSeenAt: null,
    status: "active",
    identities: [],
  };
  members.push(carol, dan, erin);
  if (o.actAs === "admin") me.user.role = "admin";
  /** Departed members' personal artifacts, counts only (admins never see titles). */
  const departed = new Map([[carol.id, { live: 2, deleted: 1 }]]);

  // ---- spaces --------------------------------------------------------------
  const spaces: SpaceRow[] = members.map((m) => ({
    id: m.id,
    kind: "personal",
    name: m.name ?? m.email,
    ownerId: m.id,
    allMembersRole: null,
    publicLinks: true,
    createdAt: T0,
  }));
  const shared = (id: string, name: string, x: Partial<SpaceRow> = {}) =>
    spaces.push({
      id,
      kind: "shared",
      name,
      ownerId: null,
      allMembersRole: null,
      publicLinks: true,
      createdAt: T0,
      ...x,
    });
  const ENG = "SpEngNpQrSt2uVwX";
  const EXEC = "SpExcNpQrSt3uVwX";
  const CLIENTS = "SpCliNpQrSt4uVwX";
  shared(ENG, "Engineering", { allMembersRole: "viewer" });
  shared(EXEC, "Exec", { publicLinks: false });
  shared(CLIENTS, "Clients");
  const ada = members[0] as Member;
  const bob = members[1] as Member;
  const G = {
    eng: { groupId: "gEng01", email: "eng@example.com", name: "Engineering" },
    exec: { groupId: "gExec02", email: "exec@example.com", name: "Exec" },
    sales: { groupId: "gSales03", email: "sales@example.com", name: "Sales" },
    contractors: {
      groupId: "gCon04",
      email: "contractors@example.com",
      name: "Contractors",
    },
  } satisfies Record<string, GroupRef>;
  /** Directory group membership (user ids), as sync would see it. */
  const groupMembers = new Map<string, string[]>([
    [G.eng.groupId, [bob.id]],
    [G.exec.groupId, [ada.id]],
    [G.sales.groupId, []],
    [G.contractors.groupId, [dan.id]],
  ]);
  /** Manual restricted flags (R.memberRestricted). */
  const manualRestricted = new Set<string>();
  const rows = new Map<string, MemberRow[]>([
    [
      ENG,
      [
        { userId: ada.id, manualRole: "manager", syncRole: null, groups: [] },
        {
          userId: bob.id,
          manualRole: null,
          syncRole: "editor",
          groups: [G.eng],
        },
      ],
    ],
    [
      EXEC,
      [
        {
          userId: ada.id,
          manualRole: null,
          syncRole: "viewer",
          groups: [G.exec],
        },
      ],
    ],
    [CLIENTS, []],
  ]);
  const mappings = new Map<string, GroupMapping[]>([
    [
      ENG,
      [
        {
          ...G.eng,
          role: "editor",
          memberCount: 1,
          lastSyncedAt: T0,
        },
      ],
    ],
    [
      EXEC,
      [
        {
          ...G.exec,
          role: "viewer",
          memberCount: 1,
          lastSyncedAt: T0,
        },
      ],
    ],
  ]);
  /** "Every space" mappings: one row per group. */
  const orgMappings: GroupMapping[] = [];
  /** Settings.spaceManagerMappings (hosted default on). */
  let spaceManagerMappings = true;
  const restricted: RestrictedGroup[] = [
    { ...G.contractors, memberCount: 1, createdAt: T0 },
  ];
  const groups: DirectoryGroup[] = [
    { ...G.eng, memberCount: 1 },
    { ...G.exec, memberCount: 1 },
    { ...G.sales, memberCount: 4 },
    { ...G.contractors, memberCount: 1 },
  ];
  const audit: AuditEvent[] = [];
  const log = (
    action: AuditAction,
    target: AuditEvent["target"],
    spaceId: string | null = null,
    detail: Record<string, unknown> | null = null,
  ) =>
    audit.unshift({
      id: newId(),
      at: iso(),
      actor: { kind: "user", id: me.user.id, email: me.user.email },
      action,
      target,
      spaceId,
      reason: null,
      detail,
    });

  const unhealthySince = o.unhealthy
    ? new Date(Date.now() - (o.stale ? 8 * 24 : 2) * 3600_000).toISOString()
    : null;
  const sync: SyncStatus = {
    mode: directoryMode,
    binding:
      directoryMode === "off"
        ? null
        : {
            provider: "google",
            customerId: "C01mock",
            domain: MOCK_DOMAIN,
            connectedBy: ada.email,
            connectedAt: T0,
          },
    healthy: directoryMode === "off" ? null : !o.unhealthy,
    state:
      directoryMode === "off"
        ? "never"
        : o.unhealthy
          ? (o.unhealthyState ?? "backoff")
          : "ok",
    unhealthySince,
    lastSuccessAt: directoryMode === "off" ? null : (unhealthySince ?? iso()),
    lastError: o.unhealthy
      ? { at: iso(), message: "Google returned 503" }
      : null,
    nextRunAt: null,
    staleAt: null,
    alertedAt: null,
    customerMismatch: null,
    pendingCount: null,
    pendingCountCapped: false,
    pendingExpiresAt: null,
    pendingCustomerChange: null,
    liftsPaused: [],
    held:
      directoryMode === "google"
        ? [
            {
              ...G.sales,
              wouldRemove: 4,
              members: 4,
              since: T0,
            },
          ]
        : [],
  };

  // A consent for another Workspace, after a disconnect during a mismatch:
  // the confirm step's "different Google Workspace" notice.
  if (o.pendingCustomerChange) {
    Object.assign(sync, {
      binding: null,
      healthy: false,
      state: "pending_confirm",
      lastSuccessAt: null,
      held: [],
      pendingCount: 12,
      pendingExpiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      pendingCustomerChange: o.pendingCustomerChange,
    } satisfies Partial<SyncStatus>);
  }

  // staleAt: lastSuccessAt + 7 d once that has passed, else null.
  if (sync.lastSuccessAt) {
    const at = Date.parse(sync.lastSuccessAt) + 7 * 24 * 3600_000;
    if (at <= Date.now()) sync.staleAt = new Date(at).toISOString();
  }

  // ---- derived views --------------------------------------------------------
  const isAdmin = () => me.user.role === "owner" || me.user.role === "admin";
  const billing: PlanView = o.billing ?? {
    tier: "business",
    status: "active",
    trialEndsAt: null,
    graceUntil: null,
    creatorsThisMonth: 1,
    readOnly: false,
  };
  /** Me.instance.billing: the details for the owner and admins only. */
  const billingView = (): PlanView | undefined => {
    if (o.selfHosted) return undefined;
    if (isAdmin()) return { ...billing };
    const { creatorsThisMonth: _, ...rest } = billing;
    return { ...rest, status: null, trialEndsAt: null, graceUntil: null };
  };
  /** The server's plan refusal for an invite, or null. */
  const planRefusal = (): Response | null => {
    if (o.selfHosted) return null;
    if (billing.readOnly)
      return err("plan_read_only", "Team features are read-only", {
        tier: billing.tier,
        reason: billing.reason ?? "lapsed",
      } satisfies PlanRefusalDetails);
    if (billing.tier === "free" && billing.trialEndsAt !== null)
      return err("plan_required", "Inviting people needs a team plan", {
        tier: "free",
        reason: "solo",
      } satisfies PlanRefusalDetails);
    return null;
  };
  const billingUrl = (kind: "checkout" | "portal") =>
    HttpResponse.json({
      url: `https://checkout.stripe.com/c/pay/cs_test_mock_${kind}`,
    });
  /**
   * R.directoryDisconnect / DELETE R.directory: the binding and health go,
   * memberships stay (frozen). Nothing connected: no change, no audit row.
   */
  const disconnect = () => {
    if (!sync.binding && sync.state !== "pending_confirm") return;
    Object.assign(sync, {
      binding: null,
      healthy: sync.mode === "off" ? null : false,
      // Disconnected during a mismatch: synced users stay denied.
      state: sync.state === "customer_mismatch" ? "customer_mismatch" : "never",
      unhealthySince: null,
      lastSuccessAt: null,
      lastError: null,
      nextRunAt: null,
      staleAt: null,
      alertedAt: null,
      customerMismatch: null,
      held: [],
      liftsPaused: [],
      pendingCount: null,
      pendingCountCapped: false,
      pendingExpiresAt: null,
      pendingCustomerChange: null,
    } satisfies Partial<SyncStatus>);
    log("directory.disconnect", { type: "directory", id: "google" });
  };
  /**
   * Changing an owner's or admin's role, removing them or resetting their
   * Google link needs the uncapped owner (#475): 403 owner_only otherwise.
   */
  const needsOwner = (m: Member) =>
    (m.role === "owner" || m.role === "admin") &&
    (me.user.role !== "owner" || cap() !== null);
  const findSpace = (id: unknown) => spaces.find((s) => s.id === id);
  const memberOf = (id: string) => members.find((m) => m.id === id);
  /** guests_read_only: P2's authConfig.guestsReadOnly, true whenever google or email sign-in is on. */
  const guestsReadOnly = () => mode === "direct" && providerIds.length > 0;
  const restrictionOf = (userId: string) => {
    const gs = restricted
      .filter((g) => groupMembers.get(g.groupId)?.includes(userId))
      .map((g) => ({ groupId: g.groupId, email: g.email, name: g.name }));
    const manual = manualRestricted.has(userId);
    return manual || gs.length > 0 ? { manual, groups: gs } : null;
  };
  const capOf = (u: Member | undefined): CapReason | null =>
    !u
      ? null
      : u.role === "guest" && guestsReadOnly()
        ? "guest"
        : restrictionOf(u.id)
          ? "restricted"
          : null;
  const cap = (): CapReason | null => capOf(me.user);
  /** A shared space's member rows plus org mappings, merged at read time (copies; personal: none). */
  const rowsOf = (s: SpaceRow): MemberRow[] => {
    const base = rows.get(s.id) ?? [];
    const live = (x: MemberRow) => !!(x.manualRole || x.syncRole);
    if (s.kind === "personal" || orgMappings.length === 0)
      return base.filter(live);
    const out = new Map(
      base.map((r) => [r.userId, { ...r, groups: [...r.groups] }]),
    );
    for (const m of orgMappings)
      for (const userId of groupMembers.get(m.groupId) ?? []) {
        // Every space roles are resolved at read time, as the server's
        // authz: no change to a space's rows (frozen included) drops them.
        const r = out.get(userId) ?? {
          userId,
          manualRole: null,
          syncRole: null,
          groups: [],
        };
        r.syncRole = maxRole(r.syncRole, m.role);
        if (!r.groups.some((g) => g.groupId === m.groupId))
          r.groups.push({ groupId: m.groupId, email: m.email, name: m.name });
        out.set(userId, r);
      }
    return [...out.values()].filter(live);
  };
  /** The stored (per-space) row for a user, created empty when missing. */
  const baseRow = (s: SpaceRow, userId: string): MemberRow => {
    const list = rows.get(s.id) ?? [];
    rows.set(s.id, list);
    let row = list.find((x) => x.userId === userId);
    if (!row) {
      row = { userId, manualRole: null, syncRole: null, groups: [] };
      list.push(row);
    }
    return row;
  };
  /** Frozen sync: drop the space's own rows (manual and synced) by hand; Every space roles stay. */
  const detach = (row: MemberRow) => {
    row.manualRole = null;
    row.syncRole = null;
    row.groups = [];
  };
  /** Their Every space role: the best org mapping role over their groups. */
  const everyRoleOf = (userId: string): SpaceRole | null =>
    maxRole(
      ...orgMappings
        .filter((m) => groupMembers.get(m.groupId)?.includes(userId))
        .map((m) => m.role),
    );
  /** 409 managed_by_org_mapping: an Every space group gives them everyRole here. */
  const managedByOrgMapping = (userId: string, everyRole: SpaceRole) =>
    err("managed_by_org_mapping", MANAGED_BY_ORG_MAPPING_MESSAGE, {
      userId,
      everyRole,
    });
  const roleIn = (s: SpaceRow, userId = me.user.id): SpaceRole | null => {
    if (s.kind === "personal") return s.ownerId === userId ? "manager" : null;
    const u = memberOf(userId);
    const r = rowsOf(s).find((x) => x.userId === userId);
    // allMembersRole never reaches guests or restricted members.
    const all =
      u && u.role !== "guest" && !restrictionOf(u.id) ? s.allMembersRole : null;
    return maxRole(r?.manualRole, r?.syncRole, all);
  };
  /** Shared-space artifacts the signed-in caller has no level on (refresh). */
  const hidden = new Set<string>();
  /**
   * decide() for a live artifact in shared space `s`, as the caller: a
   * manager role; else the better of their space role and share; else team
   * visibility for uncapped members; else public; else none. A cap lowers any
   * level to viewer.
   */
  const sharedLevel = (a: ArtifactSummary, s: SpaceRow): AccessLevel | null => {
    const capped = cap() !== null;
    const member = me.user.role !== "guest";
    const role = roleIn(s);
    const share =
      c.shares[a.id]?.find(
        (x) => x.email.toLowerCase() === me.user.email.toLowerCase(),
      )?.role ?? null;
    let l: AccessLevel | null;
    if (role === "manager") l = "manager";
    else {
      const best = maxRole(role, share);
      l =
        best === "editor" || best === "viewer"
          ? best
          : a.visibility === "team" && member && !capped
            ? "viewer"
            : a.visibility === "public"
              ? "viewer"
              : null;
    }
    return l && capped ? "viewer" : l;
  };
  const ref = (s: SpaceRow): SpaceRef => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    publicLinks: s.publicLinks,
  });
  const view = (s: SpaceRow): Space => ({
    ...ref(s),
    owner: (() => {
      const u = s.ownerId ? memberOf(s.ownerId) : undefined;
      return u ? { id: u.id, email: u.email, name: u.name } : null;
    })(),
    allMembersRole: s.allMembersRole,
    myRole: roleIn(s),
    memberCount: s.kind === "personal" ? 1 : rowsOf(s).length,
    artifactCount: artifacts.filter(
      (a) => a.space?.id === s.id && a.deletedAt === null,
    ).length,
    createdAt: s.createdAt,
    can: {
      manageMappings:
        s.kind === "shared" &&
        (isAdmin() || (roleIn(s) === "manager" && spaceManagerMappings)),
    },
  });
  /** groups[] with the role each mapping grants: the space's own (via "space") and Every space (via "every"). */
  const groupsView = (s: SpaceRow, r: MemberRow): SpaceMemberGroup[] =>
    r.groups.flatMap((g) => {
      const own = mappings.get(s.id)?.find((m) => m.groupId === g.groupId);
      const every = orgMappings.find((m) => m.groupId === g.groupId);
      const out: SpaceMemberGroup[] = [];
      if (own) out.push({ ...g, role: own.role, via: "space" });
      if (every) out.push({ ...g, role: every.role, via: "every" });
      return out.length > 0
        ? out
        : [{ ...g, role: r.syncRole ?? "viewer", via: "space" as const }];
    });
  const memberView = (s: SpaceRow, r: MemberRow): SpaceMember | null => {
    const u = memberOf(r.userId);
    if (!u) return null;
    const role = maxRole(r.manualRole, r.syncRole) as SpaceRole;
    return {
      userId: u.id,
      user: { id: u.id, email: u.email, name: u.name },
      status: u.status ?? "active",
      role,
      source:
        r.manualRole && RANK[r.manualRole] >= RANK[role] ? "manual" : "sync",
      manualRole: r.manualRole,
      syncRole: r.syncRole,
      groups: groupsView(s, r),
      cap: capOf(u),
      // As roleIn: allMembersRole never reaches guests or restricted members.
      allMembers:
        s.kind === "shared" && u.role !== "guest" && !restrictionOf(u.id)
          ? s.allMembersRole
          : null,
      // The detail only for a caller who can manage the space (cap still says restricted).
      restriction:
        cap() === null && (isAdmin() || roleIn(s) === "manager")
          ? restrictionOf(u.id)
          : null,
    };
  };
  /** Can the caller see this shared space (member or org admin)? */
  const visible = (s: SpaceRow) =>
    s.kind === "personal" ? s.ownerId === me.user.id : !!roleIn(s) || isAdmin();
  const levelIn = (s: SpaceRow): AccessLevel | null => {
    if (s.kind === "personal") return s.ownerId === me.user.id ? "owner" : null;
    const r = roleIn(s);
    return r === "manager" ? "manager" : r;
  };

  /**
   * The server's move source rule: the caller's own personal space, or a
   * shared space where they are an uncapped manager now (so an artifact they
   * lost their role on can't move, whatever its last can said).
   */
  const mayLeave = (a: ArtifactSummary) => {
    const s = findSpace(a.space?.id);
    if (!s) return false;
    if (s.kind === "personal") return s.id === me.user.id;
    return cap() === null && roleIn(s) === "manager";
  };

  const features = (): FeatureFlag[] => [
    ...new Set<FeatureFlag>([
      "spaces",
      ...(guestsReadOnly() ? (["guests_read_only"] as const) : []),
      "content_revocation",
      "usage_off",
      ...(directoryMode === "google"
        ? (["sync_google"] as const)
        : directoryMode === "frozen"
          ? (["sync_frozen"] as const)
          : []),
      // FEATURES can't set guests_read_only.
      ...(o.features ?? []).filter((f) => f !== "guests_read_only"),
    ]),
  ];
  const providers = (): AuthProviders =>
    mode === "access"
      ? {
          mode,
          providers: [{ id: "access", start: "/auth/login" }],
          hosted: !o.selfHosted,
        }
      : {
          mode,
          hosted: !o.selfHosted,
          providers: [
            ...(providerIds.includes("google")
              ? [
                  {
                    id: "google" as const,
                    start: "/auth/login/google",
                    domains: [MOCK_DOMAIN],
                  },
                ]
              : []),
            ...(providerIds.includes("email")
              ? [
                  {
                    id: "email" as const,
                    domainCodes: !providerIds.includes("google"),
                    guests: true,
                    ...(o.turnstile
                      ? { turnstileSiteKey: "1x00000000000000000000AA" }
                      : {}),
                  },
                ]
              : []),
          ],
        };

  /** Refresh Me's hosted fields and every artifact's space/can. Runs before each request. */
  const refresh = () => {
    me.instance.hosted = !o.selfHosted;
    me.instance.tier = o.tier === undefined ? "business" : o.tier;
    me.instance.billing = billingView();
    me.instance.signIn = {
      mode,
      providers: providers().providers.map((p) => p.id),
    };
    me.instance.features = features();
    const unhealthy = sync.healthy === false;
    me.instance.directory = {
      mode: directoryMode,
      healthy: sync.healthy,
      unhealthySince: sync.unhealthySince,
      banner: unhealthy && isAdmin(),
      tokensUnverified: unhealthy && isAdmin(),
      state: isAdmin() ? sync.state : null,
      staleAt: isAdmin() ? sync.staleAt : null,
      heldSweeps: isAdmin() ? sync.held.length : 0,
    };
    for (const m of members) m.restriction = restrictionOf(m.id);
    const myCap = cap();
    me.auth = {
      method: me.auth?.method ?? (mode === "access" ? "access" : "google"),
      readOnly: myCap !== null,
      cap: myCap,
      expiresAt: me.auth?.expiresAt ?? "2026-12-31T00:00:00.000Z",
    };
    me.personalSpaceId = me.user.id;
    me.spaces = spaces
      .filter((s) => s.kind === "shared" && roleIn(s))
      .map((s): MySpace => ({ ...ref(s), myRole: roleIn(s) as SpaceRole }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const a of artifacts) {
      const s =
        findSpace(a.space?.id) ??
        findSpace(a.owner.id) ??
        (spaces[0] as SpaceRow);
      a.space = ref(s);
      // A shared space's live artifact: the caller's level, decide()'s order
      // (never a stale access); none hides it (404, unlisted).
      if (s.kind === "shared" && a.deletedAt === null) {
        const l = sharedLevel(a, s);
        if (l) {
          a.access = l;
          hidden.delete(a.id);
        } else hidden.add(a.id);
      }
      a.can = artifactCan(a.access, {
        personal: s.kind === "personal",
        cap: cap(),
        dataWriters: a.dataWriters,
      });
    }
  };

  // Seed: "Meeting notes" in Engineering, where the caller is manager.
  // (refresh recomputes every shared-space level per caller: sharedLevel.)
  const notes = artifacts.find((a) => a.title === "Meeting notes");
  if (notes) {
    notes.space = ref(findSpace(ENG) as SpaceRow);
    notes.access = "manager";
  }
  // Bob's "Onboarding guide" (the caller is a viewer): data writes are editors-only.
  const guide = artifacts.find((a) => a.title === "Onboarding guide");
  if (guide) guide.dataWriters = "editors";
  refresh();

  // ---- code flow state -----------------------------------------------------
  let pending: { email: string; attempts: number; next: string } | null = null;
  const requests = new Map<string, number>();
  const fails = new Map<string, number>();

  // ---- publish hook (used by POST R.artifacts) -----------------------------
  /** Checks spaceId; returns a refusal, or the space to place a new artifact in. */
  const checkPublish = (
    input: PublishInput & { spaceId?: string },
    existing: ArtifactSummary | undefined,
  ): Response | { space: SpaceRow | null } => {
    if (input.spaceId === undefined)
      return {
        space: existing
          ? null
          : cap()
            ? null
            : (findSpace(me.user.id) as SpaceRow),
      };
    if (existing)
      return err("use_move", "spaceId is only valid when creating; use move");
    const s = findSpace(input.spaceId);
    if (!s || !visible(s)) return notFound();
    const r = roleIn(s);
    if (cap() || !r || r === "viewer")
      return err("space_forbidden", "You can't publish to this space");
    return { space: s };
  };
  const placeNew = (a: ArtifactSummary, s: SpaceRow | null) => {
    if (cap() && !s) return;
    const sp = s ?? (findSpace(me.user.id) as SpaceRow);
    a.space = ref(sp);
    a.access = levelIn(sp) ?? "owner";
    refresh();
  };
  /**
   * Making an artifact public in a space whose publicLinks is off: 403
   * public_links_off. Echoing "public" on an artifact that already is public
   * passes, as on the server.
   */
  const refusePublic = (
    space: { publicLinks: boolean } | null | undefined,
    visibility: string | undefined,
    current?: string,
  ) =>
    visibility === "public" &&
    current !== "public" &&
    space &&
    !space.publicLinks
      ? err("public_links_off", "Public links are off in this space")
      : null;
  /** A create by a capped caller (no spaceId) is refused too. */
  const refuseCappedCreate = () =>
    cap() ? err("space_forbidden", "Read-only accounts can't publish") : null;

  // ---- handlers --------------------------------------------------------------
  const authed =
    (
      fn: (ctx: {
        request: Request;
        params: Record<string, unknown>;
      }) => Response | Promise<Response>,
    ) =>
    (ctx: { request: Request; params: Record<string, unknown> }) =>
      c.isAnon(ctx.request)
        ? err("unauthorized", "Authentication required")
        : fn(ctx);
  const sharedSpace = (id: unknown): SpaceRow | Response => {
    const s = findSpace(id);
    if (!s || !visible(s)) return notFound();
    return s;
  };
  const syncOff = () =>
    directoryMode !== "google"
      ? err("directory_sync_off", "Directory sync is off or frozen")
      : null;
  /**
   * Space mapping gate: org admins pass; else the space's manager (no role:
   * 404). PUT (add or change) needs spaceManagerMappings on (403
   * directory_mapping_off); list and remove never do. Every role touched (PUT
   * body, the existing row) must be viewer|editor (403 space_forbidden).
   */
  const mappingGate = (
    s: SpaceRow,
    op: "list" | "put" | "remove",
    roles: (SpaceRole | undefined)[] = [],
  ): Response | null => {
    if (isAdmin()) return null;
    if (roleIn(s) !== "manager") return notFound();
    if (op === "put" && !spaceManagerMappings)
      return err(
        "directory_mapping_off",
        "Space managers can't change group mappings on this install",
      );
    if (
      roles.some(
        (r) =>
          r && !(SPACE_MANAGER_MAPPING_ROLES as readonly string[]).includes(r),
      )
    )
      return err(
        "space_forbidden",
        "Only an admin can change a manager mapping",
        { target: "mapping" },
      );
    return null;
  };
  const settingsView = () => ({
    name: me.instance.name,
    defaultVisibility: me.instance.defaultVisibility,
    spaceManagerMappings,
  });
  const sp = "*/api/v1/spaces/:id";
  const validSuccessor = (u: Member | undefined): u is Member =>
    !!u &&
    u.role !== "guest" &&
    (u.status ?? "active") === "active" &&
    !restrictionOf(u.id);

  const handlers: HttpHandler[] = [
    http.all("*", () => {
      refresh();
      return undefined;
    }),
    // -- break-glass (P3 T18): the mismatch owner's Me
    ...(o.breakGlass
      ? [
          http.get("*/api/v1/me", () =>
            c.err(
              "break_glass_required",
              "Directory sync is blocked by a Google Workspace mismatch",
              { fresh: o.breakGlass === "fresh" },
            ),
          ),
        ]
      : []),
    // -- sign-in
    http.get("*/auth/providers", () => HttpResponse.json(providers())),
    http.get("*/auth/login/google", ({ request }) => {
      if (mode !== "direct" || !providerIds.includes("google"))
        return notFound();
      const next = new URL(request.url).searchParams.get("next") ?? "/";
      return new HttpResponse(null, {
        status: 302,
        headers: {
          location: `https://accounts.google.com/o/oauth2/v2/auth?mock=1&next=${encodeURIComponent(next)}`,
        },
      });
    }),
    // Mock only: the Google round trip, done. ?mock_email signs that active
    // member in (method google) and 302s to /; anyone else to SIGN_IN_PAGE.
    http.get("*/auth/callback/google", ({ request }) => {
      if (mode !== "direct" || !providerIds.includes("google"))
        return notFound();
      const email = new URL(request.url).searchParams
        .get("mock_email")
        ?.toLowerCase();
      const u = members.find(
        (m) => m.email === email && m.status === "active" && m.role !== "guest",
      );
      if (!u)
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "/sign-in?error=no_access&via=google" },
        });
      me.user = u;
      me.auth = {
        method: "google",
        readOnly: false,
        cap: null,
        expiresAt: new Date(Date.now() + 168 * 3600_000).toISOString(),
      };
      refresh();
      return new HttpResponse(null, {
        status: 302,
        headers: { location: "/" },
      });
    }),
    http.post("*/auth/code/request", async ({ request }) => {
      if (mode !== "direct" || !providerIds.includes("email"))
        return notFound();
      const r = await c.body(request, CodeRequestSchema);
      if (r.error) return r.error;
      if (o.turnstile && !r.data.turnstileToken)
        return err("turnstile_required", "Complete the verification", {
          field: "turnstile",
          required: true,
        });
      if (o.turnstile && r.data.turnstileToken === "fail")
        return err("turnstile_failed", "Verification failed; try again");
      const email = r.data.email.toLowerCase();
      const n = (requests.get(email) ?? 0) + 1;
      requests.set(email, n);
      if (n > 5)
        return err("rate_limited", "Too many codes requested", {
          retryAfter: 3600,
          scope: "email",
        });
      // A domain member with domainCodes off signs in with Google: the same
      // 202, but no code is sent (as the server).
      const domainCodes = !providerIds.includes("google");
      pending =
        !domainCodes && email.endsWith(`@${MOCK_DOMAIN}`)
          ? null
          : { email, attempts: 0, next: r.data.next ?? "/" };
      return HttpResponse.json(
        {
          maskedEmail: mask(email),
          expiresIn: CODE_POLICY.ttlSec,
          resendAfter: CODE_POLICY.resendAfterSec,
          codeLength: CODE_POLICY.length,
        },
        { status: 202 },
      );
    }),
    http.post("*/auth/code/verify", async ({ request }) => {
      const r = await c.body(request, CodeVerifySchema);
      if (r.error) return r.error;
      if (!pending)
        return err("unauthorized", "Start over", { reason: "no_pending" });
      const p = pending;
      if ((fails.get(p.email) ?? 0) >= 10)
        return err("rate_limited", "Too many attempts", {
          retryAfter: 3600,
          scope: "email",
        });
      if (normalizeCode(r.data.code) !== HOSTED_MOCK_CODE) {
        p.attempts++;
        fails.set(p.email, (fails.get(p.email) ?? 0) + 1);
        if (p.attempts >= CODE_POLICY.maxAttempts) {
          pending = null;
          return err("unauthorized", "Code expired", { reason: "expired" });
        }
        return err("unauthorized", "Wrong code", {
          reason: "invalid_code",
          attemptsLeft: CODE_POLICY.maxAttempts - p.attempts,
        });
      }
      pending = null;
      let u = members.find((m) => m.email === p.email);
      if (!u) {
        u = {
          id: newId(),
          email: p.email,
          name: null,
          role: p.email.endsWith(`@${MOCK_DOMAIN}`) ? "member" : "guest",
          lastSeenAt: null,
          status: "active",
          identities: [],
        };
        members.push(u);
        spaces.push({
          id: u.id,
          kind: "personal",
          name: u.email,
          ownerId: u.id,
          allMembersRole: null,
          publicLinks: true,
          createdAt: iso(),
        });
      }
      if (u.status !== "active")
        return err("unauthorized", "Wrong code", {
          reason: "invalid_code",
          attemptsLeft: 0,
        });
      me.user = u;
      me.auth = {
        method: "code",
        readOnly: false,
        cap: null,
        expiresAt: new Date(
          Date.now() + (u.role === "guest" ? 24 : 168) * 3600_000,
        ).toISOString(),
      };
      refresh();
      return HttpResponse.json({
        next: p.next,
        user: u,
        readOnly: me.auth.readOnly,
      });
    }),
    http.post("*/__test/otp/latest", async ({ request }) => {
      const r = await c.body(request, OtpLatestInputSchema);
      if (r.error) return r.error;
      return pending && pending.email === r.data.email.toLowerCase()
        ? HttpResponse.json({ code: HOSTED_MOCK_CODE })
        : notFound();
    }),
    // -- usage_off
    http.get("*/api/v1/usage", () =>
      features().includes("usage_off") ? notFound() : undefined,
    ),
    // -- members: acting on an owner or admin is owner-only (#475); anything
    // else falls through to the base handlers.
    ...(["patch", "delete"] as const).map((method) =>
      http[method]("*/api/v1/members/:id", ({ request, params }) => {
        const m = memberOf(params.id as string);
        if (c.isAnon(request) || !m || !isAdmin() || !needsOwner(m))
          return undefined;
        return err("owner_only", "Only the owner can manage an owner or admin");
      }),
    ),
    // -- invite reachability (review item 11), the server's rules for the
    // mock's providers: Google admits MOCK_DOMAIN (outside it, only maybe: a
    // Workspace secondary domain, so signIn "uncertain"); codes admit
    // MOCK_DOMAIN only while Google is off (domainCodes). Reachable invites
    // fall through to the base handler.
    // -- self-serve billing: Checkout, Portal and the usage report (owner
    // and admins; others 404), and the plan refusal on invites.
    http.post("*/api/v1/billing/checkout", async ({ request }) => {
      if (o.selfHosted || c.isAnon(request) || !isAdmin()) return notFound();
      const r = await c.body(request, BillingCheckoutInputSchema);
      if (r.error) return r.error;
      if (o.billingDown)
        return err("billing_unavailable", "Billing is unavailable");
      return billingUrl("checkout");
    }),
    http.post("*/api/v1/billing/portal", ({ request }) => {
      if (o.selfHosted || c.isAnon(request) || !isAdmin()) return notFound();
      if (o.billingDown)
        return err("billing_unavailable", "Billing is unavailable");
      return billingUrl("portal");
    }),
    http.post("*/api/v1/billing/usage", ({ request }) => {
      if (o.selfHosted || c.isAnon(request) || !isAdmin()) return notFound();
      if (o.billingDown)
        return err("billing_unavailable", "Billing is unavailable");
      return HttpResponse.json({
        month: new Date().toISOString().slice(0, 7),
        count: billing.creatorsThisMonth ?? 0,
      });
    }),
    http.post("*/api/v1/members", async ({ request }) => {
      if (!c.isAnon(request) && isAdmin()) {
        const refused = planRefusal();
        if (refused) return refused;
      }
      if (mode === "access" || c.isAnon(request)) return undefined;
      const r = await c.body(request.clone(), MemberInviteSchema);
      if (r.error) return undefined;
      const email = r.data.email.toLowerCase();
      const inDomain = email.endsWith(`@${MOCK_DOMAIN}`);
      const google = providerIds.includes("google");
      if (inDomain && (google || providerIds.includes("email")))
        return undefined;
      if (!google) {
        const reason = inDomain ? "no_sign_in_method" : "outside_domains";
        return err("invite_unreachable", INVITE_UNREACHABLE_MESSAGE[reason], {
          field: "email",
          reason,
        });
      }
      if (members.some((m) => m.email === email))
        return err("conflict", "Already a member");
      const m: Member = {
        id: newId(),
        email,
        name: null,
        role: r.data.role,
        lastSeenAt: null,
        status: "active",
      };
      members.push(m);
      return HttpResponse.json(
        {
          ...m,
          emailed: false,
          signIn: { status: "uncertain", reason: "outside_domains" },
          signInMethods: ["google"],
        },
        { status: 201 },
      );
    }),
    // -- members (status filter), departed transfer, identity reset
    http.get(
      "*/api/v1/members",
      authed(({ request }) => {
        const q = new URL(request.url).searchParams;
        const r = MembersQuerySchema.safeParse(
          q.has("status") ? { status: q.get("status") } : {},
        );
        if (!r.success)
          return err("bad_request", "Invalid query", r.error.issues);
        // Org owners and admins only, as the server (members.manage): space
        // managers search R.spaceCandidates instead.
        if (!isAdmin()) return notFound();
        return HttpResponse.json(
          members.filter((m) => r.data.status.includes(m.status ?? "active")),
        );
      }),
    ),
    http.get(
      "*/api/v1/members/:id/transfer",
      authed(({ params }) => {
        const m = memberOf(params.id as string);
        if (!m || !isAdmin()) return notFound();
        return HttpResponse.json(departed.get(m.id) ?? { live: 0, deleted: 0 });
      }),
    ),
    http.post(
      "*/api/v1/members/:id/transfer",
      authed(async ({ request, params }) => {
        const m = memberOf(params.id as string);
        if (!m || !isAdmin()) return notFound();
        const r = await c.body(request, TransferInputSchema);
        if (r.error) return r.error;
        if ((m.status ?? "active") === "active")
          return err("member_active", "Suspend or remove the member first");
        const to = r.data.to;
        if (to.kind === "user") {
          const u = memberOf(to.userId);
          if (!validSuccessor(u))
            return err("invalid_successor", "Pick an active member");
        } else {
          const s = findSpace(to.spaceId);
          if (!s) return notFound();
          if (s.kind === "personal")
            return err("space_personal", "Pick a shared space");
        }
        const left = departed.get(m.id) ?? { live: 0, deleted: 0 };
        const total = left.live + left.deleted;
        const moved = Math.min(TRANSFER_PAGE, total);
        const liveMoved = Math.min(moved, left.live);
        left.live -= liveMoved;
        left.deleted -= moved - liveMoved;
        departed.set(m.id, left);
        log("artifact.transfer", { type: "user", id: m.id }, null, {
          moved,
        });
        const remaining = left.live + left.deleted;
        return HttpResponse.json({
          moved,
          remaining,
          nextCursor: remaining > 0 ? btoa(String(moved)) : null,
        });
      }),
    ),
    ...(["put", "delete"] as const).map((method) =>
      http[method](
        "*/api/v1/members/:id/restricted",
        authed(({ params }) => {
          const m = memberOf(params.id as string);
          if (!m || !isAdmin()) return notFound();
          const on = method === "put";
          if (on && (m.role === "owner" || m.role === "admin"))
            return err(
              "restrict_admin",
              "Owners and admins can't be restricted",
            );
          if (on !== manualRestricted.has(m.id)) {
            if (on) manualRestricted.add(m.id);
            else manualRestricted.delete(m.id);
            log(on ? "restricted.set" : "restricted.remove", {
              type: "user",
              id: m.id,
            });
          }
          refresh();
          return HttpResponse.json(m);
        }),
      ),
    ),
    http.delete(
      "*/api/v1/members/:id/identities/:provider",
      authed(({ params }) => {
        const m = memberOf(params.id as string);
        if (!m || !isAdmin() || params.provider !== "google") return notFound();
        // Resetting an admin's link signs a peer admin out: owner only. By
        // role, before the link, so a refusal never reveals one (#475).
        if (needsOwner(m))
          return err("owner_only", "Only the owner can reset an admin's link");
        if (m.role === "owner" || !m.identities?.includes("google"))
          return notFound();
        m.identities = (m.identities ?? []).filter((x) => x !== "google");
        log("identity.reset", { type: "user", id: m.id });
        return noContent();
      }),
    ),
    // -- move and transfer
    http.post(
      "*/api/v1/artifacts/:id/move",
      authed(async ({ request, params }) => {
        const a = artifacts.find(
          (x) => x.id === params.id && x.deletedAt === null,
        );
        // As the server: never a stale can (an artifact the caller no longer
        // reaches): a shared source needs the caller's manager role there now.
        if (!a?.can?.move || !mayLeave(a)) return notFound();
        const r = await c.body(request, MoveArtifactInputSchema);
        if (r.error) return r.error;
        const s = findSpace(r.data.spaceId);
        if (!s) return notFound();
        // Someone else's personal space is 404 (no user-id oracle); one's
        // own is 400 space_personal.
        if (s.kind === "personal" && s.id !== me.user.id) return notFound();
        if (s.kind === "personal")
          return err(
            "space_personal",
            "Artifacts move into shared spaces only",
          );
        if (!visible(s)) return notFound();
        const role = roleIn(s);
        if (!role || role === "viewer")
          return err("space_forbidden", "You can't publish to this space");
        a.space = ref(s);
        a.access = levelIn(s) as AccessLevel;
        // Public links off in the target: public becomes team in the same
        // batch (the server also closes its anonymous sockets).
        if (!s.publicLinks && a.visibility === "public") a.visibility = "team";
        log("artifact.move", { type: "artifact", id: a.id }, s.id);
        refresh();
        return HttpResponse.json(a);
      }),
    ),
    http.post(
      "*/api/v1/artifacts/:id/transfer",
      authed(async ({ request, params }) => {
        const a = artifacts.find(
          (x) => x.id === params.id && x.deletedAt === null,
        );
        // As the server: only the caller's own personal artifact, now.
        if (!a?.can?.transfer || a.space?.id !== me.user.id) return notFound();
        const r = await c.body(request, TransferArtifactInputSchema);
        if (r.error) return r.error;
        const u = memberOf(r.data.userId);
        if (!validSuccessor(u) || u.id === me.user.id)
          return err("invalid_successor", "Pick an active member");
        const s = findSpace(u.id) as SpaceRow;
        a.space = ref(s);
        a.owner = { id: u.id, email: u.email, name: u.name };
        a.access = "editor";
        const list = shares[a.id] ?? [];
        shares[a.id] = list;
        if (me.user.email && !list.some((x) => x.email === me.user.email))
          list.push({ email: me.user.email, role: "editor", createdAt: iso() });
        log("artifact.transfer", { type: "artifact", id: a.id }, s.id);
        refresh();
        return HttpResponse.json(a);
      }),
    ),
    // -- spaces
    http.get(
      "*/api/v1/spaces",
      authed(({ request }) => {
        const q = new URL(request.url).searchParams;
        const kind = q.get("kind");
        const list = spaces
          .filter((s) => visible(s) && (!kind || s.kind === kind))
          .map(view)
          .sort((a, b) =>
            a.kind === b.kind
              ? a.name.localeCompare(b.name)
              : a.kind === "personal"
                ? -1
                : 1,
          );
        return page(list, q);
      }),
    ),
    http.post(
      "*/api/v1/spaces",
      authed(async ({ request }) => {
        if (!isAdmin()) return notFound();
        const r = await c.body(request, SpaceCreateSchema);
        if (r.error) return r.error;
        const { addMe, ...data } = r.data;
        const s: SpaceRow = {
          id: newId(),
          kind: "shared",
          ownerId: null,
          createdAt: iso(),
          ...data,
        };
        spaces.push(s);
        // addMe (the default): the creator is a manual manager; false: no row.
        rows.set(
          s.id,
          addMe
            ? [
                {
                  userId: me.user.id,
                  manualRole: "manager",
                  syncRole: null,
                  groups: [],
                },
              ]
            : [],
        );
        log("space.create", { type: "space", id: s.id }, s.id);
        if (addMe)
          log("space.member.add", { type: "user", id: me.user.id }, s.id, {
            role: "manager",
          });
        refresh();
        return HttpResponse.json(view(s), { status: 201 });
      }),
    ),
    http.get(
      sp,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        return s instanceof Response ? s : HttpResponse.json(view(s));
      }),
    ),
    http.patch(
      sp,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces can't be changed");
        const r = await c.body(request, SpacePatchSchema);
        if (r.error) return r.error;
        const manager = roleIn(s) === "manager";
        const keys = Object.keys(r.data);
        const allowed = isAdmin()
          ? true
          : manager &&
            keys.every((k) =>
              (SPACE_MANAGER_FIELDS as readonly string[]).includes(k),
            );
        if (!allowed) return notFound();
        if (
          r.data.publicLinks !== undefined &&
          r.data.publicLinks !== s.publicLinks
        ) {
          // Off refuses NEW public links only (decided): existing public
          // artifacts, their links and sockets keep working; nothing is rewritten.
          log("space.public_links", { type: "space", id: s.id }, s.id, {
            publicLinks: r.data.publicLinks,
          });
        }
        // As the server: space.update only when name or allMembersRole
        // actually changes (publicLinks has its own space.public_links).
        const fields = [
          ...(r.data.name !== undefined && r.data.name !== s.name
            ? ["name"]
            : []),
          ...(r.data.allMembersRole !== undefined &&
          r.data.allMembersRole !== s.allMembersRole
            ? ["allMembersRole"]
            : []),
        ];
        Object.assign(s, r.data);
        if (fields.length)
          log("space.update", { type: "space", id: s.id }, s.id, {
            fields,
            ...(r.data.allMembersRole !== undefined
              ? { allMembersRole: r.data.allMembersRole }
              : {}),
          });
        refresh();
        return HttpResponse.json(view(s));
      }),
    ),
    http.delete(
      sp,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces can't be deleted");
        if (!isAdmin()) return notFound();
        if (artifacts.some((a) => a.space?.id === s.id))
          return err(
            "space_not_empty",
            "Move or delete its artifacts first. Deleted artifacts count until the trash clears them, 30 days after deletion.",
          );
        spaces.splice(spaces.indexOf(s), 1);
        log("space.delete", { type: "space", id: s.id }, s.id);
        return noContent();
      }),
    ),
    http.get(
      `${sp}/members`,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no members");
        const qs = new URL(request.url).searchParams;
        const raw: Record<string, string> = {};
        qs.forEach((v, k) => {
          raw[k] = v;
        });
        const q = SpaceMembersQuerySchema.safeParse(raw);
        if (!q.success)
          return err("bad_request", "Invalid query", q.error.issues);
        const needle = q.data.q?.toLowerCase();
        const list = rowsOf(s)
          .map((r) => memberView(s, r))
          .filter((x): x is SpaceMember => x !== null)
          .filter(
            (m) =>
              (!needle ||
                (m.user.email ?? "").toLowerCase().startsWith(needle) ||
                (m.user.name ?? "")
                  .toLowerCase()
                  .split(/\s+/)
                  .some((w) => w.startsWith(needle))) &&
              (!q.data.group ||
                m.groups.some((g) => g.groupId === q.data.group)),
          );
        const res = page(list, qs);
        // Page<SpaceMember> plus the filtered total.
        return HttpResponse.json({ ...(await res.json()), total: list.length });
      }),
    ),
    http.get(
      `${sp}/candidates`,
      authed(({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no members");
        // An uncapped org admin or an uncapped manager of this space.
        if (!isAdmin() && (roleIn(s) !== "manager" || cap() !== null))
          return notFound();
        const qs = new URL(request.url).searchParams;
        const raw: Record<string, string> = {};
        qs.forEach((v, k) => {
          raw[k] = v;
        });
        const q = SpaceCandidatesQuerySchema.safeParse(raw);
        if (!q.success)
          return err("bad_request", "Invalid query", q.error.issues);
        const needle = q.data.q?.toLowerCase();
        const here = rowsOf(s);
        const list = members
          .filter(
            (m) =>
              m.role !== "guest" &&
              (m.status ?? "active") === "active" &&
              (!needle ||
                m.email.toLowerCase().startsWith(needle) ||
                (m.name ?? "")
                  .toLowerCase()
                  .split(/\s+/)
                  .some((w) => w.startsWith(needle))),
          )
          .sort((a, b) =>
            a.email === b.email
              ? a.id < b.id
                ? -1
                : 1
              : a.email < b.email
                ? -1
                : 1,
          )
          .map((m): SpaceCandidate => {
            const r = here.find((x) => x.userId === m.id);
            return {
              id: m.id,
              email: m.email,
              name: m.name,
              role: m.role,
              restriction: restrictionOf(m.id),
              spaceRole: r ? maxRole(r.manualRole, r.syncRole) : null,
            };
          });
        return page(list, qs, 20);
      }),
    ),
    http.post(
      `${sp}/members/self`,
      authed(async ({ request, params }) => {
        const s = findSpace(params.id);
        if (!s || !isAdmin()) return notFound();
        if (s.kind === "personal")
          return err(
            "space_personal",
            "Admins can add themselves to shared spaces only",
          );
        const r = await c.body(request, SpaceMemberPutSchema);
        if (r.error) return r.error;
        const list = rows.get(s.id) ?? [];
        rows.set(s.id, list);
        let row = list.find((x) => x.userId === me.user.id);
        if (!row) {
          row = {
            userId: me.user.id,
            manualRole: null,
            syncRole: null,
            groups: [],
          };
          list.push(row);
        }
        row.manualRole = r.data.role;
        // The server also notifies the space's managers.
        log("space.admin_self_add", { type: "user", id: me.user.id }, s.id, {
          role: r.data.role,
        });
        refresh();
        return HttpResponse.json(memberView(s, row), { status: 201 });
      }),
    ),
    http.put(
      `${sp}/members/:userId`,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no members");
        if (!isAdmin() && roleIn(s) !== "manager") return notFound();
        // The body first, then an existing, active member (as the server): else 404.
        const r = await c.body(request, SpaceMemberPutSchema);
        if (r.error) return r.error;
        const u = memberOf(params.userId as string);
        if (!u || (u.status ?? "active") !== "active") return notFound();
        const cur = rowsOf(s).find((x) => x.userId === u.id);
        // Only an org admin grants Manager or changes a peer manager (a
        // manager row by hand or synced; the frozen override included).
        if (
          !isAdmin() &&
          (r.data.role === "manager" ||
            cur?.manualRole === "manager" ||
            cur?.syncRole === "manager")
        )
          return err(
            "space_forbidden",
            "Only an admin can grant or change the Manager role",
            { target: "member" },
          );
        // The space's own rows (manual, synced), without Every space roles.
        const own = rows.get(s.id)?.find((x) => x.userId === u.id);
        // An Every space group's role is a floor (sync live or frozen):
        // below it 409; equal to it with no row here, a no-op.
        const every = everyRoleOf(u.id);
        if (every && RANK[r.data.role] < RANK[every])
          return managedByOrgMapping(u.id, every);
        if (cur && r.data.role === every && !own?.manualRole && !own?.syncRole)
          return HttpResponse.json(memberView(s, cur));
        // Frozen, synced row: any role (raise or lower, manual rules above) is a manual override.
        const frozenSynced = directoryMode === "frozen" && !!own?.syncRole;
        const row = baseRow(s, u.id);
        if (frozenSynced) {
          // Manual override; the next reconcile after unfreezing replaces it.
          detach(row);
          row.manualRole = r.data.role;
          log("space.member.role", { type: "user", id: u.id }, s.id, {
            syncFrozen: true,
            role: r.data.role,
          });
        } else {
          log(
            cur ? "space.member.role" : "space.member.add",
            { type: "user", id: u.id },
            s.id,
          );
          row.manualRole = r.data.role;
        }
        refresh();
        const out = rowsOf(s).find((x) => x.userId === u.id) ?? row;
        return HttpResponse.json(memberView(s, out));
      }),
    ),
    http.delete(
      `${sp}/members/:userId`,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (!isAdmin() && roleIn(s) !== "manager") return notFound();
        const userId = params.userId as string;
        const cur = rowsOf(s).find((x) => x.userId === userId);
        if (!cur) return notFound();
        // A peer manager (by hand or synced) is an org admin's to remove.
        if (
          !isAdmin() &&
          (cur.manualRole === "manager" || cur.syncRole === "manager")
        )
          return err("space_forbidden", "Only an admin can remove a manager", {
            target: "member",
          });
        // The space's own rows (manual, synced), without Every space roles.
        const own = rows.get(s.id)?.find((x) => x.userId === userId);
        const every = everyRoleOf(userId);
        // Only an Every space group puts them here: nothing to remove.
        if (every && !own?.manualRole && !own?.syncRole)
          return managedByOrgMapping(userId, every);
        // Still here after the removal (Every space, or a live synced row):
        // 200 with the role they keep; else 204.
        const kept = () => {
          const k = rowsOf(s).find((x) => x.userId === userId);
          return k ? HttpResponse.json(memberView(s, k)) : noContent();
        };
        if (directoryMode === "frozen" && own?.syncRole) {
          // Removing access is always allowed, synced rows included.
          detach(baseRow(s, userId));
          log("space.member.remove", { type: "user", id: userId }, s.id, {
            syncFrozen: true,
          });
          refresh();
          return kept();
        }
        if (!own?.manualRole)
          return own?.syncRole && directoryMode === "google"
            ? err(
                "member_synced",
                "This person comes from a Google group. Remove them from the group in Google, or change their role here.",
              )
            : notFound();
        const row = baseRow(s, userId);
        row.manualRole = null;
        log("space.member.remove", { type: "user", id: userId }, s.id);
        refresh();
        return kept();
      }),
    ),
    http.get(
      `${sp}/mappings`,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no mappings");
        const denied = mappingGate(s, "list");
        if (denied) return denied;
        return HttpResponse.json(mappings.get(s.id) ?? []);
      }),
    ),
    http.put(
      `${sp}/mappings/:groupId`,
      authed(async ({ request, params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no mappings");
        const denied = mappingGate(s, "put");
        if (denied) return denied;
        const r = await c.body(request, GroupMappingPutSchema);
        if (r.error) return r.error;
        const existing = mappings
          .get(s.id)
          ?.find((x) => x.groupId === params.groupId);
        const forbidden = mappingGate(s, "put", [r.data.role, existing?.role]);
        if (forbidden) return forbidden;
        const off = syncOff();
        if (off) return off;
        const g = groups.find((x) => x.groupId === params.groupId);
        if (!g) return notFound();
        const list = mappings.get(s.id) ?? [];
        mappings.set(s.id, list);
        let m = list.find((x) => x.groupId === g.groupId);
        if (!m) {
          m = {
            groupId: g.groupId,
            email: g.email,
            name: g.name,
            role: r.data.role,
            memberCount: g.memberCount,
            lastSyncedAt: null,
          };
          list.push(m);
        }
        m.role = r.data.role;
        log("mapping.set", { type: "mapping", id: m.groupId }, s.id);
        return HttpResponse.json(m);
      }),
    ),
    http.delete(
      `${sp}/mappings/:groupId`,
      authed(({ params }) => {
        const s = sharedSpace(params.id);
        if (s instanceof Response) return s;
        if (s.kind === "personal")
          return err("space_personal", "Personal spaces have no mappings");
        const denied = mappingGate(s, "remove");
        if (denied) return denied;
        const list = mappings.get(s.id) ?? [];
        const i = list.findIndex((x) => x.groupId === params.groupId);
        if (i < 0) return notFound();
        const forbidden = mappingGate(s, "remove", [list[i]?.role]);
        if (forbidden) return forbidden;
        const off = syncOff();
        if (off) return off;
        list.splice(i, 1);
        log(
          "mapping.remove",
          { type: "mapping", id: params.groupId as string },
          s.id,
        );
        return noContent();
      }),
    ),
    // -- settings (hosted adds spaceManagerMappings; settings.manage = org owner, admin)
    http.get(
      "*/api/v1/settings",
      authed(() => HttpResponse.json(settingsView())),
    ),
    http.patch(
      "*/api/v1/settings",
      authed(async ({ request }) => {
        if (!isAdmin()) return notFound();
        const r = await c.body(request, SettingsPatchSchema);
        if (r.error) return r.error;
        const { spaceManagerMappings: next, ...rest } = r.data;
        Object.assign(me.instance, rest);
        if (next !== undefined && next !== spaceManagerMappings) {
          spaceManagerMappings = next;
          log(
            "settings.space_manager_mappings",
            { type: "directory", id: "settings" },
            null,
            { spaceManagerMappings: next },
          );
        }
        return HttpResponse.json(settingsView());
      }),
    ),
    // -- "Every space" mappings (org admin; never personal spaces)
    http.get(
      "*/api/v1/directory/org-mappings",
      authed(({ request }) =>
        isAdmin()
          ? page(orgMappings, new URL(request.url).searchParams)
          : notFound(),
      ),
    ),
    http.put(
      "*/api/v1/directory/org-mappings/:groupId",
      authed(async ({ request, params }) => {
        if (!isAdmin()) return notFound();
        const r = await c.body(request, GroupMappingPutSchema);
        if (r.error) return r.error;
        const off = syncOff();
        if (off) return off;
        const g = groups.find((x) => x.groupId === params.groupId);
        if (!g) return notFound();
        let m = orgMappings.find((x) => x.groupId === g.groupId);
        if (!m) {
          m = {
            groupId: g.groupId,
            email: g.email,
            name: g.name,
            role: r.data.role,
            memberCount: g.memberCount,
            lastSyncedAt: null,
          };
          orgMappings.push(m);
        }
        m.role = r.data.role;
        log("mapping.set", { type: "mapping", id: m.groupId }, null, {
          scope: "org",
          role: m.role,
        });
        refresh();
        return HttpResponse.json(m);
      }),
    ),
    http.delete(
      "*/api/v1/directory/org-mappings/:groupId",
      authed(({ params }) => {
        if (!isAdmin()) return notFound();
        const off = syncOff();
        if (off) return off;
        const i = orgMappings.findIndex((x) => x.groupId === params.groupId);
        if (i < 0) return notFound();
        orgMappings.splice(i, 1);
        log(
          "mapping.remove",
          { type: "mapping", id: params.groupId as string },
          null,
          { scope: "org" },
        );
        refresh();
        return noContent();
      }),
    ),
    // -- directory
    http.get(
      "*/api/v1/directory/restricted-groups",
      authed(() => (isAdmin() ? HttpResponse.json(restricted) : notFound())),
    ),
    http.put(
      "*/api/v1/directory/restricted-groups/:groupId",
      authed(({ params }) => {
        if (!isAdmin()) return notFound();
        const off = syncOff();
        if (off) return off;
        const d = groups.find((x) => x.groupId === params.groupId);
        if (!d) return notFound();
        let g = restricted.find((x) => x.groupId === d.groupId);
        if (!g) {
          g = {
            groupId: d.groupId,
            email: d.email,
            name: d.name,
            memberCount: d.memberCount,
            createdAt: iso(),
          };
          restricted.push(g);
          log("restricted.set", { type: "group", id: g.groupId });
        }
        refresh();
        return HttpResponse.json(g);
      }),
    ),
    http.delete(
      "*/api/v1/directory/restricted-groups/:groupId",
      authed(({ params }) => {
        if (!isAdmin()) return notFound();
        // Any mode: frozen restrictions stay in force until an admin lifts them.
        const i = restricted.findIndex((x) => x.groupId === params.groupId);
        if (i < 0) return notFound();
        restricted.splice(i, 1);
        log("restricted.remove", {
          type: "group",
          id: params.groupId as string,
        });
        refresh();
        return noContent();
      }),
    ),
    http.get(
      "*/api/v1/directory/groups",
      authed(({ request }) => {
        if (!isAdmin()) return notFound();
        const q = new URL(request.url).searchParams;
        const needle = (q.get("q") ?? "").toLowerCase();
        return page(
          groups.filter(
            (g) =>
              !needle ||
              g.email.includes(needle) ||
              g.name.toLowerCase().includes(needle),
          ),
          q,
          30,
        );
      }),
    ),
    http.get(
      "*/api/v1/directory/connect",
      authed(() =>
        me.user.role === "owner"
          ? new HttpResponse(null, {
              status: 302,
              headers: {
                location:
                  "https://accounts.google.com/o/oauth2/v2/auth?mock=directory",
              },
            })
          : notFound(),
      ),
    ),
    http.post(
      "*/api/v1/directory/sync",
      authed(() => {
        if (me.user.role !== "owner") return notFound();
        if (directoryMode !== "google")
          return err("directory_sync_off", "Directory sync is off or frozen");
        sync.nextRunAt = iso();
        return HttpResponse.json(sync, { status: 202 });
      }),
    ),
    http.post(
      "*/api/v1/directory/confirm",
      authed(() => {
        if (me.user.role !== "owner" || sync.state !== "pending_confirm")
          return notFound();
        Object.assign(sync, {
          state: "never",
          pendingCount: null,
          pendingCountCapped: false,
          pendingExpiresAt: null,
          pendingCustomerChange: null,
        });
        log("directory.connect", { type: "directory", id: "google" });
        return HttpResponse.json(sync);
      }),
    ),
    http.post(
      "*/api/v1/directory/cancel",
      authed(() => {
        if (me.user.role !== "owner" || sync.state !== "pending_confirm")
          return notFound();
        Object.assign(sync, {
          state: "never",
          binding: null,
          pendingCount: null,
          pendingCountCapped: false,
          pendingExpiresAt: null,
          pendingCustomerChange: null,
        });
        log("directory.disconnect", { type: "directory", id: "google" });
        return noContent();
      }),
    ),
    http.post(
      "*/api/v1/directory/held/:groupId/confirm",
      authed(({ params }) => {
        if (me.user.role !== "owner") return notFound();
        const i = sync.held.findIndex((h) => h.groupId === params.groupId);
        if (i < 0) return notFound();
        sync.held.splice(i, 1);
        log("directory.sweep.confirmed", {
          type: "group",
          id: params.groupId as string,
        });
        return HttpResponse.json(sync, { status: 202 });
      }),
    ),
    http.get(
      "*/api/v1/directory",
      authed(() => (isAdmin() ? HttpResponse.json(sync) : notFound())),
    ),
    http.post(
      "*/api/v1/directory/disconnect",
      authed(() => {
        if (me.user.role !== "owner") return notFound();
        disconnect();
        return HttpResponse.json(sync);
      }),
    ),
    http.delete(
      "*/api/v1/directory",
      authed(() => {
        if (me.user.role !== "owner") return notFound();
        disconnect();
        return noContent();
      }),
    ),
    http.get(
      "*/api/v1/audit",
      authed(({ request }) =>
        isAdmin() ? page(audit, new URL(request.url).searchParams) : notFound(),
      ),
    ),
  ];

  /**
   * The hosted list scopes (ListQuerySchema): "space" lists one shared
   * space, or the caller's own personal space; "spaces" lists every shared
   * space. Another user's personal space is refused (400 space_personal); an
   * unknown one, or a shared one where the caller has no role, is 404.
   */
  const listScope = (
    scope: string,
    spaceId: string | undefined,
  ):
    | Response
    | ((space: { id: string; kind: string } | null | undefined) => boolean)
    | null => {
    if (scope === "spaces") return (sp) => sp?.kind === "shared";
    if (scope === "mine" && spaceId !== undefined) {
      const sp = findSpace(spaceId);
      if (!sp) return notFound();
      if (sp.kind === "personal" && sp.id !== me.user.id)
        return err("space_personal", "Pick a shared space");
      if (sp.kind === "shared" && !roleIn(sp)) return notFound();
      if (sp.id !== me.user.id)
        return err(
          "bad_request",
          'scope "mine" is the personal space; use owner=me',
          { path: "spaceId", reason: "invalid" },
        );
      return null;
    }
    if (scope !== "space") return null;
    const sp = findSpace(spaceId);
    if (!sp) return notFound();
    if (sp.kind === "personal" && sp.id !== me.user.id)
      return err("space_personal", "Pick a shared space");
    // No role there: 404, as an unknown id (no existence oracle).
    if (sp.kind === "shared" && !roleIn(sp)) return notFound();
    return (a) => a?.id === spaceId;
  };

  /**
   * R.trash's shared part: a refusal for `spaceId`, or which artifacts'
   * spaces the caller manages (uncapped manager or org admin), as the row's
   * `space` (null: not a managed shared space; the caller's personal trash is
   * the core handler's).
   */
  const trashScope = (
    spaceId: string | undefined,
  ):
    | Response
    | ((a: ArtifactSummary) => {
        id: string;
        name: string;
        personal: false;
      } | null) => {
    const manages = (s: SpaceRow | undefined) =>
      !!s && s.kind === "shared" && cap() === null && roleIn(s) === "manager";
    if (spaceId !== undefined && spaceId !== me.user.id) {
      if (!manages(findSpace(spaceId))) return notFound();
    }
    return (a) => {
      const s = findSpace(a.space?.id);
      if (!s || !manages(s)) return null;
      if (spaceId !== undefined && s.id !== spaceId) return null;
      return { id: s.id, name: s.name, personal: false };
    };
  };

  /**
   * ShareResult.recipient (review item 37), the server's rules for the mock's
   * providers (invite-only): an in-domain non-member needs an invite; outside
   * the domain, guests sign in with codes, so only a Google-only mock flags.
   */
  const shareRecipient = (email: string): ShareRecipient | undefined => {
    if (mode === "access") return undefined;
    if (members.some((m) => m.email === email)) return undefined;
    if (email.endsWith(`@${MOCK_DOMAIN}`))
      return { canSignIn: false, reason: "needs_invite" };
    return providerIds.includes("email")
      ? undefined
      : { canSignIn: false, reason: "outside_domains" };
  };

  /**
   * signInMethods (#799) for an invite (a member row about to exist) or a
   * share, the server's reach rules for the mock's providers, in
   * SIGN_IN_METHOD_ORDER; [] when they can't sign in. An uncertain Google
   * invite (outside the domain) names Google.
   */
  const signInMethods = (
    email: string,
    kind: "invite" | "share",
  ): SignInProviderId[] => {
    if (mode === "access") return ["access"];
    const google = providerIds.includes("google");
    const codes = providerIds.includes("email");
    const inDomain = email.endsWith(`@${MOCK_DOMAIN}`);
    const member =
      kind === "invite" ||
      members.some((m) => m.email === email && m.role !== "guest");
    const guest = !member;
    const out: SignInProviderId[] = [];
    if (google && (inDomain ? member : kind === "invite")) out.push("google");
    // Codes: domain codes (Google off) in the domain; guests outside it.
    if (codes && (inDomain ? !google && member : guest)) out.push("email");
    return orderSignInMethods(out);
  };

  return {
    handlers,
    refresh,
    trashScope,
    /** No level for the signed-in caller: 404 and unlisted (sharedLevel). */
    hidden: (id: string) => hidden.has(id),
    shareRecipient,
    signInMethods,
    checkPublish,
    placeNew,
    refuseCappedCreate,
    refusePublic,
    listScope,
  };
}
