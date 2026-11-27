// P3 T16: builds the matrix world described in expect.ts (workerd only).
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  OPTOUT_CHECK_PATH,
  OPTOUT_MINT_PATH,
} from "@oa/provisioning-contract/optouts";
import { newId } from "@oa/shared";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import { deleteUser } from "../../src/directory/apply.js";
import { type Health, HK, NEVER } from "../../src/directory/health.js";
import { K, UPSERT } from "../../src/directory/store.js";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";
import { oauthApi } from "../../src/mcp/oauth-api.js";
import { runtimeStub } from "../../src/runtime/do.js";
import { publish } from "../../src/services/artifacts.js";
import { busHub, busOn } from "../../src/services/bus.js";
import { getUser } from "../../src/services/users.js";
import { mailer, seedUser, uniq } from "../auth-helpers.js";
import { cachePlan, fakeBilling } from "../billing-helpers.js";
import { directEnv, hostedEnv, hostedProps } from "../directory-helpers.js";
import { fetchAndWait } from "../helpers.js";
import { oauthToken } from "../mcp-helpers.js";
import {
  ARTIFACTS,
  type ArtifactName,
  CALLERS,
  type CallerName,
  FOREIGN_CALLERS,
  type ForeignCaller,
  TRAITS,
} from "./expect.ts";
import { foreignCreds, installA, seedSubjectAtA } from "./foreign.ts";
import {
  type ArtifactReal,
  type Cred,
  type OrgReal,
  PROBE_SHARE_EMAIL,
  type ProbeIO,
} from "./surfaces.ts";

export const BASE = "https://app.localhost";
export const CONTENT = "http://content.localhost";
const DAY = 86_400_000;

/** Break-glass emails land here. */
export const mail = mailer();

/**
 * Rate limits never decide a cell: the matrix's anonymous limiter (RL_ANON:
 * sockets, data writes, anon ids) always admits, and every request carries
 * its own client IP. A 429 that still shows up fails the cell as
 * inconclusive (surfaces.ts), never allow or deny.
 */
const ADMIT = { limit: async () => ({ success: true }) };

/**
 * Red-line port: vitest.authz-hosted.config.ts binds AUTHZ_HOSTED, and the
 * same matrix runs with the settings staging gives red-line's install B
 * (rl-b, Business: cloud tests/redline/src/targets.ts), the install whose
 * own credentials the live per-route file (cloud
 * tests/redline/live/surfaces.test.ts) ran. All from the cloud repo's
 * committed staging config, no secret values:
 * - vars: packages/provision/src/metadata.ts userWorkerMetadata gives PLAN
 *   paid, ENVIRONMENT production, HOSTED 1, AUTH_DOMAIN_JOIN invite and the
 *   tier's FEATURES (Business: this world's own) plus spaces and usage_off.
 *   No bus: STAGING_BUS_ALL skips rl- slugs, and STAGING_BUS_SLUGS
 *   (apps/provisioner/wrangler.jsonc, env.staging) does not list rl-b.
 *   Staging's provisioner has OPTOUT_LIST "1", so packages/provision/src/
 *   wfp.ts adds OPTOUT_PLATFORM on, OPTOUT_UNSUBSCRIBE_URL and the
 *   OPTOUT_HASH_KEY secret (a test value here).
 * - props: apps/dispatch/wrangler.jsonc env.staging binds AUTH_BROKER,
 *   DIRECTORY_BROKER, BILLING and LOGIN with LOGIN_CHANGE "1", so
 *   apps/dispatch/src/login-gate.ts loginProps gives every install LOGIN and
 *   LOGIN_EDITABLE true (PROPS below).
 * A prod Business install differs: bus on (provisioner PROD_BUS_ALL "1",
 * slug not rl-), no LOGIN binding in prod's dispatch (so no LOGIN and no
 * LOGIN_EDITABLE), and OPTOUT_LIST "0" (no OPTOUT_PLATFORM). This run is
 * staging's, the setup the live file proved.
 */
export const HOSTED_RUN =
  (env as unknown as { AUTHZ_HOSTED?: string }).AUTHZ_HOSTED === "1";
const STAGING_SETTINGS: Partial<Env> = {
  ENVIRONMENT: "production",
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  FEATURES: "spaces,sync_google,content_revocation,usage_off",
  AUTH_BROKER_URL: "https://auth.h.test",
  OPTOUT_PLATFORM: "on",
  OPTOUT_HASH_KEY: "authz-hosted-test-key",
  OPTOUT_UNSUBSCRIBE_URL: "https://signup.h.test/unsubscribe",
};

/**
 * FinQore's flags, on the Paid plan (no fan-out caps in the way). A hosted
 * run is a hosted install's env (hostedEnv: the directory broker, no Google
 * client secret) with the login broker.
 */
export const E: Env = (HOSTED_RUN ? hostedEnv : directEnv)({
  PLAN: "paid",
  FEATURES: "spaces,sync_google,content_revocation",
  ...(HOSTED_RUN ? STAGING_SETTINGS : {}),
  ...mail.env,
  RL_ANON: ADMIT as never,
});

let ipSeq = 0;
/**
 * A fresh documentation address (RFC 3849) per request, in its own /48, so
 * even the /64 and /56 anonymous keys never repeat.
 */
const nextIp = () => {
  ipSeq = (ipSeq + 1) & 0xffff;
  return `2001:db8:${ipSeq.toString(16)}::1`;
};

/**
 * Staging's LoginGate, faked: the opt-out list answers "not opted out" and
 * mints a token (the shape of @oa/provisioning-contract's schemas), and any
 * other route, a login-domain change included, is the gate's 404. The matrix
 * never reaches a change (PUT stops at reauth_required).
 */
const fakeLoginGate = {
  fetch: async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === OPTOUT_CHECK_PATH) return Response.json({ optedOut: false });
    if (path === OPTOUT_MINT_PATH)
      return Response.json({ token: `${"T".repeat(31)}.${"m".repeat(43)}` });
    return Response.json(
      { error: "not_found" },
      { status: 404, headers: { "x-oa-gate": "1" } },
    );
  },
};

/**
 * A hosted run's ctx.props: what staging's dispatch gives every install (the
 * login and directory brokers, billing, the login gate and LOGIN_EDITABLE),
 * faked as the hosted tests fake them.
 */
const billing = HOSTED_RUN ? fakeBilling(E.INSTALL_ID) : null;
const PROPS = billing
  ? {
      ...hostedProps(),
      AUTH_BROKER: { fetch: async () => new Response(null, { status: 404 }) },
      ...billing.props,
      LOGIN: fakeLoginGate,
      LOGIN_EDITABLE: true,
    }
  : undefined;

/** The Worker as a remote target would be: both hosts, waitUntil awaited. */
export const io: ProbeIO = {
  contentBase: CONTENT,
  fetch: async (req) => {
    const h = new Headers(req.headers);
    // The edge sets it on every real request (anonymous socket and write
    // keys); one per request, so no limiter budget is shared across cells.
    if (!h.has("cf-connecting-ip")) h.set("cf-connecting-ip", nextIp());
    if (!PROPS)
      return fetchAndWait(worker as never, new Request(req, { headers: h }), E);
    // Writable, as the platform's are: the MCP route sets ctx.props to the
    // OAuth grant's.
    const ctx = createExecutionContext();
    Object.defineProperty(ctx, "props", { value: PROPS, writable: true });
    const r = await worker.fetch(
      new Request(req, { headers: h }) as never,
      E as never,
      ctx as never,
    );
    await waitOnExecutionContext(ctx);
    return r;
  },
};

const run = (q: string, ...a: unknown[]) =>
  env.DB.prepare(q)
    .bind(...a)
    .run();

async function epoch(uid: string) {
  return (
    (
      await env.DB.prepare("select session_epoch e from users where id = ?")
        .bind(uid)
        .first<{ e: number }>()
    )?.e ?? 0
  );
}
/** A session cookie for `uid`, issued `ageMs` ago. */
export async function cookieOf(uid: string, ageMs = 0) {
  return `${sessionCookieName(E)}=${await signSession(
    E,
    uid,
    Date.now() - ageMs,
    {
      provider: "access",
      epoch: await epoch(uid),
    },
  )}`;
}

/** A synced user: a Google identity bound to the connected directory. */
async function bind(sub: string) {
  await run(
    "update identities set directory_bound = 1 where provider = 'google' and subject = ?",
    sub,
  );
}

export const setHealth = (h: Partial<Health>) => {
  const v: Health = { ...NEVER, ...h };
  return env.DB.batch([
    env.DB.prepare(UPSERT).bind(HK.health, JSON.stringify(v)),
    env.DB.prepare(UPSERT).bind(HK.state, v.state),
  ]);
};
/** Sync unhealthy for 8 days: staleAt reported, access unchanged (T18). */
export const staleHealth = () =>
  setHealth({
    state: "backoff",
    unhealthySince: Date.now() - 8 * DAY,
    lastSuccessAt: Date.now() - 8 * DAY,
    staleAt: Date.now() - DAY,
    backoffN: 5,
  });
export const mismatchHealth = () =>
  setHealth({
    state: "customer_mismatch",
    unhealthySince: Date.now() - 60_000,
    lastSuccessAt: Date.now() - 120_000,
    customerMismatch: { expected: "C0123", actual: "C-other" },
  });

export type World = {
  ids: Record<ArtifactName, string>;
  creds: Record<CallerName, Cred>;
  users: Partial<Record<CallerName, string>>;
  /** Shared space S, links-off space L, and another member's personal space. */
  spaces: { S: string; L: string; otherPersonal: string };
  /** staleSynced's PAT (its creds carry the MCP OAuth grant). */
  staleSyncedPat: string;
  /** orgOwner and staleSynced are bound to the directory. */
  googleSubs: { orgOwner: string; staleSynced: string };
  /**
   * A throwaway copy of `art` (same space, visibility, trash and shares).
   * `noThumbnail`: none stored yet; `editorsOnly`: dataWriters "editors".
   */
  clone(art: ArtifactName, o?: CloneOpts): Promise<string>;
  /** The artifact surfaces' real-mode targets (ProbeIO.real). */
  artReal: ArtifactReal;
  /** Fresh throwaways for one real instance write by `who` (OrgReal). */
  orgReal(
    who: CallerName,
    needs: readonly (keyof OrgReal)[],
  ): Promise<Partial<OrgReal>>;
  /** The org owner's directory consent: live or already expired. */
  seedConsent(expired: boolean): Promise<void>;
  /** #681: a copy of each artifact with dataWriters "editors". */
  editorsOnly: Record<ArtifactName, string>;
  /** A throwaway copy of S: its members, plus viewer and manager mappings. */
  cloneSpace(): Promise<string>;
  groups: { every: string; viewer: string; manager: string; free: string };
  /**
   * #1137: install A (its own keys, D1 and OAuth store), which issued the
   * foreign callers' credentials, and the subject they name (B's org owner).
   */
  foreign: { a: Env; subject: string };
};

const isForeign = (c: CallerName): c is ForeignCaller =>
  (FOREIGN_CALLERS as readonly string[]).includes(c);

const tag = newId().slice(0, 6).toLowerCase();

export type CloneOpts = { noThumbnail?: boolean; editorsOnly?: boolean };

export async function buildWorld(): Promise<World> {
  // A hosted run: the install's tier is its billing row (business, active),
  // cached as billing would answer it.
  if (billing) await cachePlan(billing.s.row, Date.now(), E);
  const users: Partial<Record<CallerName, string>> = {};
  const emails: Partial<Record<CallerName, string>> = {};
  const subs = {
    orgOwner: `g-mx-owner-${tag}`,
    staleSynced: `g-mx-stale-${tag}`,
  };
  const role = (c: CallerName) =>
    c === "orgOwner"
      ? "owner"
      : c === "orgAdmin"
        ? "admin"
        : c === "guestShared" ||
            c === "guestMappedEditor" ||
            c === "everySpaceGuest"
          ? "guest"
          : "member";
  for (const c of CALLERS) {
    if (c === "anonymous" || c === "recycledEmailUser" || isForeign(c))
      continue;
    const guest = role(c) === "guest";
    const email = uniq(`mx-${c.toLowerCase()}`, guest ? "x.com" : "a.com");
    emails[c] = email;
    users[c] = await seedUser(email, role(c) as never, {
      ...(c === "orgOwner" || c === "staleSynced"
        ? { googleSub: subs[c] }
        : {}),
    });
  }
  await bind(subs.orgOwner);
  await bind(subs.staleSynced);
  const u = (c: CallerName) => users[c] as string;

  // Spaces.
  const S = newId();
  const L = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "insert into spaces (id, kind, name, owner_user_id, all_members_role, public_links, created_at) values (?, 'shared', ?, ?, null, 1, ?)",
    ).bind(S, `S ${tag}`, u("spaceManager"), now),
    env.DB.prepare(
      "insert into spaces (id, kind, name, owner_user_id, all_members_role, public_links, created_at) values (?, 'shared', ?, ?, 'editor', 0, ?)",
    ).bind(L, `L ${tag}`, u("spaceManager"), now),
  ]);
  const member = (space: string, c: CallerName, r: string, source = "manual") =>
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, ?, ?)",
    ).bind(space, u(c), r, source, now);
  await env.DB.batch([
    member(S, "spaceManager", "manager"),
    member(L, "spaceManager", "manager"),
    member(S, "spaceEditor", "editor"),
    member(S, "spaceViewer", "viewer"),
    member(S, "staleSynced", "editor", "sync"),
    member(S, "guestMappedEditor", "editor", "sync"),
    member(S, "restrictedContractor", "editor"),
    member(S, "suspendedUser", "manager"),
    member(S, "removedUser", "manager"),
  ]);
  // Directory groups: the Every-space one (editor), and three for the
  // mapping probes (viewer and manager mappings on space clones, one free).
  const groups = {
    every: `grp-every-${tag}`,
    viewer: `grp-v-${tag}`,
    manager: `grp-m-${tag}`,
    free: `grp-f-${tag}`,
  };
  await env.DB.batch([
    ...Object.values(groups).map((g) =>
      env.DB.prepare(
        "insert into directory_groups (group_id, email) values (?, ?)",
      ).bind(g, `${g}@a.com`),
    ),
    ...(["everySpaceMember", "everySpaceGuest"] as const).map((c) =>
      env.DB.prepare(
        "insert into directory_members (group_id, user_id) values (?, ?)",
      ).bind(groups.every, u(c)),
    ),
    env.DB.prepare(
      "insert into org_group_mappings (group_id, group_email, role) values (?, ?, 'editor')",
    ).bind(groups.every, `${groups.every}@a.com`),
  ]);
  // Artifacts: personal ones by personalOwner, space ones by spaceManager.
  const owner = await getUser(E, u("personalOwner"));
  const mgr = await getUser(E, u("spaceManager"));
  if (!owner || !mgr) throw new Error("fixture users");
  const ids = {} as Record<ArtifactName, string>;
  const SPACE_OF: Record<ArtifactName, string | null> = {
    personalPrivate: null,
    personalTeam: null,
    personalPublic: null,
    deletedPersonal: null,
    spacePrivate: S,
    spaceTeam: S,
    spacePublic: S,
    deletedSpace: S,
    spaceLinksOff: L,
  };
  const VIS: Record<ArtifactName, string> = {
    personalPrivate: "private",
    personalTeam: "team",
    personalPublic: "public",
    deletedPersonal: "team",
    spacePrivate: "private",
    spaceTeam: "team",
    spacePublic: "public",
    deletedSpace: "team",
    spaceLinksOff: "public",
  };
  for (const a of ARTIFACTS) {
    const space = SPACE_OF[a];
    const r = await publish(
      E,
      space ? mgr : owner,
      {
        title: a,
        format: "html",
        content: `<p>${a}</p>`,
        capabilities: { db: true, storage: true, viewer: true },
        // #2080: the matrix world keeps anyone-can-comment; signed-in-only
        // is covered by comments.access.2080.test.ts.
        comments: "everyone",
        ...(space && space !== L ? { spaceId: space } : {}),
      } as never,
      null,
      undefined,
      "create",
    );
    ids[a] = r.id;
  }
  for (const a of ARTIFACTS) {
    const id = ids[a];
    // L's toggle is already off: the public artifact predates it (SQL).
    await run(
      `update artifacts set visibility = ?, title = ?, has_thumbnail = 1, thumbnail_version = 1,
         space_id = coalesce(?, space_id), deleted_at = ? where id = ?`,
      VIS[a],
      `matrix ${id}`,
      SPACE_OF[a],
      a.startsWith("deleted") ? now : null,
      id,
    );
    await E.FILES.put(`thumbs/${id}.webp`, new Uint8Array([1, 2, 3, 4]));
    await runtimeStub(E, id).set("c", "d", { v: 1 }, `u:${u("spaceManager")}`);
  }
  // Search rows for all nine (the trash too: search must still drop it).
  await run(
    `insert or replace into artifact_search (rowid, artifact_id, title, description, body)
     select rowid, id, title, '', '' from artifacts where id in (select value from json_each(?))`,
    JSON.stringify(Object.values(ids)),
  );

  // Shares (by address).
  const share = (art: ArtifactName, email: string, r: string) =>
    env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, ?, ?, ?)",
    ).bind(ids[art], email, r, u("personalOwner"), now);
  await env.DB.batch([
    share("personalPrivate", emails.guestShared as string, "viewer"),
    share("spacePrivate", emails.guestShared as string, "editor"),
    share("personalPrivate", emails.restrictedContractor as string, "editor"),
    share("personalPrivate", emails.suspendedUser as string, "editor"),
    share("personalPrivate", emails.removedUser as string, "editor"),
  ]);

  // Recycled address: the old holder had a share and a manager role; the
  // directory removed them (deletion treatment) and a new person has it.
  const recycled = uniq("mx-recycled");
  const oldId = await seedUser(recycled, "member", {
    googleSub: `g-mx-old-${tag}`,
  });
  await env.DB.batch([
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'manager', 'manual', ?)",
    ).bind(S, oldId, now),
    share("personalPrivate", recycled, "editor"),
    share("spacePrivate", recycled, "editor"),
  ]);
  await deleteUser(E, oldId, "directory_new_id", () => {});
  users.recycledEmailUser = await seedUser(recycled, "member", {
    googleSub: `g-mx-new-${tag}`,
  });
  emails.recycledEmailUser = recycled;

  // Credentials: a fresh cookie and a PAT each (refused where the caller
  // can't connect agents); staleSynced also holds an MCP OAuth grant.
  const creds = {} as Record<CallerName, Cred>;
  for (const c of CALLERS) {
    if (c === "anonymous") {
      creds[c] = {};
      continue;
    }
    if (isForeign(c)) continue;
    const id = u(c);
    creds[c] = {
      cookie: await cookieOf(id),
      token: (await createPat(E, id, `mx-${c}`)).token,
      email: emails[c],
    };
  }
  const grant = await oauthToken(
    emails.staleSynced as string,
    "Matrix Agent",
    {
      cookie: creds.staleSynced.cookie as string,
      userId: u("staleSynced"),
    },
    E,
  );
  // The grant drives MCP; its PAT is checked on its own (matrix test).
  const staleSyncedPat = creds.staleSynced.token as string;
  creds.staleSynced = { ...creds.staleSynced, token: grant.accessToken };
  // #1137: install A's credentials for B's org owner, at B's epoch.
  const a = await installA(E);
  const subject = {
    id: u("orgOwner"),
    email: emails.orgOwner as string,
    epoch: await epoch(u("orgOwner")),
  };
  await seedSubjectAtA(a, subject);
  Object.assign(creds, await foreignCreds(a, subject));
  // Restricted after the PAT was minted (tokens.create refuses capped callers).
  await run(
    "update users set restricted_manual = 1 where id = ?",
    u("restrictedContractor"),
  );
  for (const [c, s] of [
    ["suspendedUser", "suspended"],
    ["removedUser", "removed"],
  ] as const)
    await run(
      "update users set status = ?, status_changed_at = ? where id = ?",
      s,
      Date.now(),
      u(c),
    );

  await staleHealth();

  const cols = async (t: string) =>
    (
      await env.DB.prepare(`select name from pragma_table_info('${t}')`).all<{
        name: string;
      }>()
    ).results.map((r) => r.name);
  const artCols = (await cols("artifacts")).filter((c) => c !== "id");
  const verCols = (await cols("versions")).filter((c) => c !== "artifact_id");
  const shareCols = (await cols("shares")).filter((c) => c !== "artifact_id");
  const clone = async (art: ArtifactName, o: CloneOpts = {}) => {
    const id = newId();
    const src = ids[art];
    await env.DB.batch([
      env.DB.prepare(
        `insert into artifacts (id, ${artCols}) select ?, ${artCols} from artifacts where id = ?`,
      ).bind(id, src),
      env.DB.prepare(
        `insert into versions (artifact_id, ${verCols}) select ?, ${verCols} from versions where artifact_id = ?`,
      ).bind(id, src),
      env.DB.prepare(
        `insert into shares (artifact_id, ${shareCols}) select ?, ${shareCols} from shares where artifact_id = ?`,
      ).bind(id, src),
      env.DB.prepare(
        "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
      ).bind(id, PROBE_SHARE_EMAIL, u("personalOwner"), Date.now()),
    ]);
    if (o.noThumbnail)
      await run(
        "update artifacts set has_thumbnail = 0, thumbnail_version = null where id = ?",
        id,
      );
    if (o.editorsOnly)
      await run(
        "update artifacts set data_writers = 'editors', allow_anonymous_writes = 0 where id = ?",
        id,
      );
    return id;
  };

  const cloneSpace = async () => {
    const id = newId();
    await env.DB.batch([
      env.DB.prepare(
        "insert into spaces (id, kind, name, owner_user_id, all_members_role, public_links, created_at) values (?, 'shared', ?, ?, null, 1, ?)",
      ).bind(id, `C ${id}`, u("spaceManager"), Date.now()),
      env.DB.prepare(
        "insert into space_members (space_id, user_id, role, source, created_at) select ?, user_id, role, source, created_at from space_members where space_id = ?",
      ).bind(id, S),
      env.DB.prepare(
        "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'viewer'), (?, ?, ?, 'manager')",
      ).bind(
        id,
        groups.viewer,
        `${groups.viewer}@a.com`,
        id,
        groups.manager,
        `${groups.manager}@a.com`,
      ),
    ]);
    return id;
  };

  const editorsOnly = {} as Record<ArtifactName, string>;
  for (const a of ARTIFACTS)
    editorsOnly[a] = await clone(a, { editorsOnly: true });

  // The refusal-mode space mapping probe re-puts this one at its role.
  await run(
    "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'viewer')",
    S,
    groups.viewer,
    `${groups.viewer}@a.com`,
  );

  const group = async () => {
    const g = `grp-x-${newId().slice(0, 8)}`;
    await run(
      "insert into directory_groups (group_id, email) values (?, ?)",
      g,
      `${g}@a.com`,
    );
    return g;
  };
  /** A grant of `uid`'s, made as the consent page makes one. */
  const newGrant = async (uid: string) => {
    const api = oauthApi(E);
    const client = await api.createClient({
      redirectUris: ["https://agent.example/cb"],
      clientName: "Matrix Probe",
      tokenEndpointAuthMethod: "none",
    });
    const { redirectTo } = await api.completeAuthorization({
      request: {
        responseType: "code",
        clientId: client.clientId,
        redirectUri: "https://agent.example/cb",
        scope: [],
        state: "s",
        // Public clients need PKCE; nothing redeems this code.
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        codeChallengeMethod: "S256",
      },
      userId: uid,
      metadata: { clientName: "Matrix Probe" },
      scope: [],
      props: { userId: uid, clientName: "Matrix Probe", issuedAt: Date.now() },
    });
    const code = new URL(redirectTo).searchParams.get("code") ?? "";
    const grantId = code.split(":")[1];
    if (!grantId) throw new Error("no grant id");
    return grantId;
  };
  const makers: {
    [K in keyof OrgReal]: (who: CallerName) => Promise<OrgReal[K]>;
  } = {
    memberId: () => seedUser(uniq("mx-real"), "member"),
    removedId: async () => {
      const id = await seedUser(uniq("mx-removed"), "member");
      await run("update users set status = 'removed' where id = ?", id);
      return id;
    },
    erasableId: async () => {
      const id = await seedUser(uniq("mx-erasable"), "member");
      await run("update users set status = 'removed' where id = ?", id);
      return id;
    },
    linkedId: (_who) =>
      seedUser(uniq("mx-linked"), "member", {
        googleSub: `g-mx-l-${newId().slice(0, 8)}`,
      }),
    restrictedId: async () => {
      const id = await seedUser(uniq("mx-restricted"), "member");
      await run("update users set restricted_manual = 1 where id = ?", id);
      return id;
    },
    groupId: group,
    restrictedGroupId: async () => {
      const g = await group();
      await run(
        "insert into restricted_groups (group_id, group_email, created_at) values (?, ?, ?)",
        g,
        `${g}@a.com`,
        Date.now(),
      );
      return g;
    },
    orgMappingGroupId: async () => {
      const g = await group();
      await run(
        "insert into org_group_mappings (group_id, group_email, role) values (?, ?, 'viewer')",
        g,
        `${g}@a.com`,
      );
      return g;
    },
    spaceId: () => cloneSpace(),
    spaceEditorId: async () => u("spaceEditor"),
    spaceGroupId: async () => groups.viewer,
    // Callers who resolve to no one (anonymous, suspended, removed) hold
    // none: a placeholder (their writes stop at the sign-in check).
    tokenId: async (who) =>
      TRAITS[who].session
        ? (await createPat(E, u(who), "mx-real")).id
        : "AAAAAAAAAAAAAAAA",
    grantId: async (who) =>
      TRAITS[who].session ? newGrant(u(who)) : "probe-grant",
    // #1291: a bus machine row of the caller's (never connected: no hub).
    busMachineId: async (who) => {
      if (!TRAITS[who].session) return "AAAAAAAAAAAAAAAA";
      const id = newId();
      await run(
        "insert into bus_machines (id, user_id, label, token_hash, created_at) values (?, ?, 'mx', ?, ?)",
        id,
        u(who),
        `mx-${id}`,
        Date.now(),
      );
      return id;
    },
    busRoleProposalId: async (who) => {
      if (!TRAITS[who].session || !busOn(E)) return "probe-proposal";
      const hub = busHub(E, u(who));
      if (!hub) throw new Error("Missing bus hub");
      const machineId = await makers.busMachineId(who);
      await run(
        "update bus_machines set last_used_at = ? where id = ?",
        Date.now(),
        machineId,
      );
      const namespace = "probe/ns";
      const name = `probe-${newId()}`;
      const role = await hub.putRole(namespace, name, null);
      if (!role.ok) throw new Error(role.reason);
      const proposal = await hub.proposeRole(
        { action: "clear", namespace, name, agent: null },
        newId(),
      );
      if (!proposal.ok) throw new Error(proposal.reason);
      return proposal.proposal.id;
    },
    subscriptionId: async (who) => {
      const id = newId();
      if (TRAITS[who].session)
        await run(
          "insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) values (?, ?, ?, 'fixture', 'fixture', ?)",
          id,
          u(who),
          `https://push.invalid/${id}`,
          Date.now(),
        );
      return id;
    },
    email: async () => uniq("mx-invite"),
    successorId: async () => u("otherMember"),
  };
  const orgReal = async (
    who: CallerName,
    needs: readonly (keyof OrgReal)[],
  ) => {
    const out: Partial<OrgReal> = {};
    for (const k of needs)
      (out as Record<string, string>)[k] = await makers[k](who);
    return out;
  };
  const seedConsent = async (expired: boolean) => {
    await env.DB.prepare(UPSERT)
      .bind(
        K.confirm,
        JSON.stringify({
          u: u("orgOwner"),
          exp: expired ? Date.now() - 60_000 : Date.now() + DAY,
          count: 0,
          capped: false,
        }),
      )
      .run();
  };

  return {
    ids,
    editorsOnly,
    artReal: { successorId: u("otherMember"), moveSpaceId: L },
    orgReal,
    seedConsent,
    cloneSpace,
    groups,
    creds,
    users,
    spaces: { S, L, otherPersonal: u("otherMember") },
    googleSubs: subs,
    staleSyncedPat,
    clone,
    foreign: { a, subject: subject.id },
  };
}

/** A Google session for a synced user, forced re-authentication (break-glass). */
export async function googleCookie(uid: string, ageMs = 60_000) {
  const iat = Date.now() - ageMs;
  return `${sessionCookieName(E)}=${await signSession(E, uid, iat, {
    provider: "google",
    tenant: "a.com",
    epoch: await epoch(uid),
    authAt: iat,
  })}`;
}
