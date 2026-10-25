// P3 T16: builds the matrix world described in expect.ts (workerd only).
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import { deleteUser } from "../../src/directory/apply.js";
import { type Health, HK, NEVER } from "../../src/directory/health.js";
import { UPSERT } from "../../src/directory/store.js";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";
import { runtimeStub } from "../../src/runtime/do.js";
import { publish } from "../../src/services/artifacts.js";
import { getUser } from "../../src/services/users.js";
import { mailer, seedUser, uniq } from "../auth-helpers.js";
import { directEnv } from "../directory-helpers.js";
import { fetchAndWait } from "../helpers.js";
import { oauthToken } from "../mcp-helpers.js";
import {
  ARTIFACTS,
  type ArtifactName,
  CALLERS,
  type CallerName,
} from "./expect.ts";
import { type Cred, PROBE_SHARE_EMAIL, type ProbeIO } from "./surfaces.ts";

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

/** FinQore's flags, on the Paid plan (no fan-out caps in the way). */
export const E: Env = directEnv({
  PLAN: "paid",
  FEATURES: "spaces,sync_google,content_revocation",
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

/** The Worker as a remote target would be: both hosts, waitUntil awaited. */
export const io: ProbeIO = {
  contentBase: CONTENT,
  fetch: (req) => {
    const h = new Headers(req.headers);
    // The edge sets it on every real request (anonymous socket and write
    // keys); one per request, so no limiter budget is shared across cells.
    if (!h.has("cf-connecting-ip")) h.set("cf-connecting-ip", nextIp());
    return fetchAndWait(worker as never, new Request(req, { headers: h }), E);
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
  /** A throwaway copy of `art` (same space, visibility, trash and shares). */
  clone(art: ArtifactName): Promise<string>;
  /** A throwaway copy of S: its members, plus viewer and manager mappings. */
  cloneSpace(): Promise<string>;
  groups: { every: string; viewer: string; manager: string; free: string };
};

const tag = newId().slice(0, 6).toLowerCase();

export async function buildWorld(): Promise<World> {
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
    if (c === "anonymous" || c === "recycledEmailUser") continue;
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
    const id = u(c);
    creds[c] = {
      cookie: await cookieOf(id),
      token: (await createPat(E, id, `mx-${c}`)).token,
      email: emails[c],
    };
  }
  const grant = await oauthToken(emails.staleSynced as string, "Matrix Agent", {
    cookie: creds.staleSynced.cookie as string,
    userId: u("staleSynced"),
  });
  // The grant drives MCP; its PAT is checked on its own (matrix test).
  const staleSyncedPat = creds.staleSynced.token as string;
  creds.staleSynced = { ...creds.staleSynced, token: grant.accessToken };
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
  const clone = async (art: ArtifactName) => {
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

  return {
    ids,
    cloneSpace,
    groups,
    creds,
    users,
    spaces: { S, L, otherPersonal: u("otherMember") },
    googleSubs: subs,
    staleSyncedPat,
    clone,
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
