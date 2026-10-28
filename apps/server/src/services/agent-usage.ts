import {
  type AgentBrowser,
  type AgentOs,
  type AgentRef,
  type ApprovedFrom,
  type RedirectKind,
  stripNameControls,
} from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

// Agent identity cards: what a grant or token is, where it was approved, and
// how it is used. Approval facts live in the grant's KV metadata (written
// once by completeAuthorization); usage lives in D1 (agent_grants, tokens).

/** The grant or token a request authenticated with. */
export type Via = { kind: "grant" | "token"; id: string };

/** An agent ref plus the grant or token behind it (server-internal; never serialized). */
export type AgentAttr = AgentRef & { via?: Via };

/** `versions.agent_via`: `g:<grantId>` or `t:<tokenId>`. */
export const viaKey = (v: Via) => `${v.kind === "grant" ? "g" : "t"}:${v.id}`;

export const USE_WRITE_MS = 60_000;

/** What the consent handler records in the grant's metadata. */
export type GrantIdentity = {
  /** Absent when the redirect URI can't be parsed. */
  redirectKind?: RedirectKind;
  redirectHost?: string;
  approvedFrom: ApprovedFrom;
};

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Where a redirect URI points, from the validated redirect_uri of this
 * authorization (never client metadata such as client_uri or logo_uri).
 * The card shows both as verified, so each needs proof:
 * - `computer` only for a loopback host (127.0.0.0/8, [::1], localhost):
 *   only loopback proves a local program;
 * - `hosted` with its host for https (or http) to any other host, except a
 *   `*.localhost` name, which is neither;
 * - neither field for a custom scheme (any app can claim one) or an
 *   unparseable URI.
 */
export function redirectInfo(
  uri: string,
): Pick<GrantIdentity, "redirectKind" | "redirectHost"> {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return {};
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return {};
  if (LOOPBACK.test(u.hostname)) return { redirectKind: "computer" };
  if (u.hostname.toLowerCase().endsWith(".localhost") || !u.hostname) return {};
  return { redirectKind: "hosted", redirectHost: u.hostname.toLowerCase() };
}

/** Longest User-Agent prefix looked at (bounds the regex work). */
const UA_MAX = 512;

/** Coarse browser and OS families from a User-Agent. Nothing else is kept. */
export function uaFamily(ua: string | null | undefined): ApprovedFrom {
  const s = (ua ?? "").slice(0, UA_MAX);
  let browser: AgentBrowser = "other";
  if (/\bEdg(e|A|iOS)?\//.test(s)) browser = "edge";
  else if (/\b(OPR|Opera|SamsungBrowser|YaBrowser|Vivaldi)\//.test(s))
    browser = "other";
  else if (/\b(Firefox|FxiOS)\//.test(s)) browser = "firefox";
  else if (/\b(Chrome|CriOS|Chromium)\//.test(s)) browser = "chrome";
  else if (/\bVersion\/[\d.]+.*\bSafari\//.test(s)) browser = "safari";
  let os: AgentOs = "other";
  if (/\b(iPhone|iPad|iPod)\b/.test(s)) os = "ios";
  else if (/\bAndroid\b/.test(s)) os = "android";
  else if (/\bCrOS\b/.test(s)) os = "chromeos";
  else if (/\b(Macintosh|Mac OS X)\b/.test(s)) os = "macos";
  else if (/\bWindows\b/.test(s)) os = "windows";
  else if (/\bLinux\b/.test(s)) os = "linux";
  return { browser, os };
}

// ------------------------------------------------------------- grant usage

/**
 * Last use and client version, as one conditional upsert: it changes the row
 * only when the stored use is over a minute old, so a burst of requests
 * writes at most once a minute. A new client version rides on that write.
 */
const TOUCH_GRANT = `insert into agent_grants (grant_id, user_id, last_used_at, client_version)
  values (?1, ?2, ?3, ?4)
  on conflict (grant_id) do update set
    last_used_at = excluded.last_used_at,
    client_version = coalesce(excluded.client_version, agent_grants.client_version)
  where agent_grants.user_id = excluded.user_id
    and (agent_grants.last_used_at is null
      or agent_grants.last_used_at <= excluded.last_used_at - ${USE_WRITE_MS})`;

/**
 * Per isolate: when the last touch was sent per grant (so most requests skip
 * D1 entirely) and the latest version seen since, sent with the next write.
 */
const touched = new Map<string, { at: number; version: string | null }>();
const TOUCHED_MAX = 1000;

/** Forget the per-isolate memo (tests). */
export const resetTouchMemo = () => touched.clear();

/**
 * Records a grant's use: nothing when this isolate already sent one within
 * the minute (a new version waits for the next minute's write), else the
 * conditional upsert. Run it in waitUntil, off the request. Returns D1 rows
 * written (0 when skipped).
 */
export async function touchGrant(
  env: Env,
  grantId: string,
  userId: string,
  clientVersion: string | null,
  now = Date.now(),
): Promise<number> {
  const seen = touched.get(grantId);
  const version = clientVersion ?? seen?.version ?? null;
  if (seen && seen.at > now - USE_WRITE_MS) {
    seen.version = version;
    return 0;
  }
  if (touched.size >= TOUCHED_MAX) touched.clear();
  touched.set(grantId, { at: now, version });
  const res = await stmt(env.DB, TOUCH_GRANT)
    .bind(grantId, userId, now, version)
    .run();
  return res.meta.rows_written;
}

/**
 * The client version as stored and shown: control, bidi and zero-width
 * characters stripped (a U+202E can't fake text on the card), trimmed,
 * bounded like AgentRef.version.
 */
export const clientVersionOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  return stripNameControls(v).trim().slice(0, 100) || null;
};

// ---------------------------------------------------------- publish count

/**
 * +1 published version for the grant or token, in the publish batch, only if
 * the version row it follows was written (this batch's current_version carries
 * this agent_via and timestamp: a PK lookup). A lost race writes nothing.
 */
export function countVersionStmt(
  db: D1Database,
  via: Via,
  userId: string,
  artifactId: string,
  now: number,
): D1PreparedStatement {
  const wrote = `exists (select 1 from versions v join artifacts a
      on v.artifact_id = a.id and v.version = a.current_version
    where a.id = ? and v.agent_via = ? and v.created_at = ?)`;
  if (via.kind === "token")
    return db
      .prepare(
        `update tokens set versions_published = versions_published + 1
         where id = ? and user_id = ? and ${wrote}`,
      )
      .bind(via.id, userId, artifactId, viaKey(via), now);
  return db
    .prepare(
      `insert into agent_grants (grant_id, user_id, versions_published)
       select ?, ?, 1 where ${wrote}
       on conflict (grant_id) do update set
         versions_published = agent_grants.versions_published + 1
       where agent_grants.user_id = excluded.user_id`,
    )
    .bind(via.id, userId, artifactId, viaKey(via), now);
}

// -------------------------------------------------------------- list reads

export type GrantUsage = {
  grantId: string;
  label: string | null;
  lastUsedAt: number | null;
  clientVersion: string | null;
  versionsPublished: number;
};

/** The usage rows of these grants of `userId` (one PK-driven read). */
export async function grantUsage(
  env: Env,
  userId: string,
  grantIds: string[],
): Promise<Map<string, GrantUsage>> {
  const out = new Map<string, GrantUsage>();
  if (grantIds.length === 0) return out;
  const { results } = await stmt(
    env.DB,
    `select grant_id as grantId, label, last_used_at as lastUsedAt,
       client_version as clientVersion, versions_published as versionsPublished
     from agent_grants
     where grant_id in (select value from json_each(?)) and user_id = ?`,
  )
    .bind(JSON.stringify(grantIds), userId)
    .all<GrantUsage>();
  for (const r of results) out.set(r.grantId, r);
  return out;
}

/** Sets (or, with null, clears) a grant's label. The caller checked ownership. */
export async function setGrantLabel(
  env: Env,
  grantId: string,
  userId: string,
  label: string | null,
): Promise<void> {
  await stmt(
    env.DB,
    `insert into agent_grants (grant_id, user_id, label) values (?1, ?2, ?3)
     on conflict (grant_id) do update set label = excluded.label
     where agent_grants.user_id = excluded.user_id`,
  )
    .bind(grantId, userId, label)
    .run();
}

/**
 * How long a usage row outlives its grant's absence from the KV listing:
 * a grant used within it may just be missing from a lagging list (review
 * item 40). Rows with no recorded use (labels, counts) carry no time and go.
 */
export const PRUNE_GRACE_MS = 3600_000;

/**
 * Deletes the user's usage rows whose grant is no longer in KV (revoked by
 * revokeAllGrants, expired, or removed elsewhere), except rows used within
 * PRUNE_GRACE_MS: one statement. Only call it with the user's complete
 * grant list.
 */
export async function pruneGrantUsage(
  env: Env,
  userId: string,
  liveGrantIds: string[],
  now = Date.now(),
): Promise<void> {
  await stmt(
    env.DB,
    `delete from agent_grants where user_id = ?
       and grant_id not in (select value from json_each(?))
       and (last_used_at is null or last_used_at < ?)`,
  )
    .bind(userId, JSON.stringify(liveGrantIds), now - PRUNE_GRACE_MS)
    .run();
}

/** Drops a revoked grant's usage row. */
export async function dropGrantUsage(
  env: Env,
  grantId: string,
  userId: string,
): Promise<void> {
  await stmt(
    env.DB,
    "delete from agent_grants where grant_id = ? and user_id = ?",
  )
    .bind(grantId, userId)
    .run();
}
