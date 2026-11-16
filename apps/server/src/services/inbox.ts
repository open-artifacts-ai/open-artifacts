import type { CommentAuthor, Inbox, InboxItem } from "@oa/shared";
import { viewerPath } from "@oa/shared";
import { and, eq, sql } from "drizzle-orm";
import { type Caller, capOfCaller, listFilterSql } from "../auth/authz.js";
import { capsReads, isGuestRole } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { artifactAsks, artifacts } from "../db/schema.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import type { StoredActor } from "../runtime/comments-store.js";
import { agentsWaitingOn } from "./bus.js";
import { askerFaces, type CommentViewer, repairAsks } from "./comments.js";
import { getSettings } from "./members.js";
import { setUpNoticeKey } from "./onboarding.js";
import { getUser } from "./users.js";

/** The most items the Needs-you list holds (the contract's cap). */
export const NEEDS_YOU_MAX = 200;
/** The most question characters shown. */
const QUESTION_MAX = 200;
/** The most artifacts whose pre-#2512 rows are repaired from their Durable Object in one read. */
export const REPAIR_MAX = 10;

type Me = Extract<Caller, { kind: "user" }>;

/** The rows that make an ask "for me": the same conditions as the library's asksForYou, behind the same access filter. */
const forMe = (caller: Me) =>
  and(
    listFilterSql(caller, "all"),
    eq(artifactAsks.addressee, caller.user.id),
    eq(artifactAsks.open, 1),
    // A row not yet filled (before #2512) can't be shown, so it is not counted.
    sql`${artifactAsks.question} is not null`,
    sql`${artifacts.deletedAt} is null and ${artifacts.comments} = 1`,
  );

/** How many open asks wait for the caller (the /me badge): one indexed query. */
export async function needsYouCount(env: Env, caller: Me): Promise<number> {
  const r = await getDb(env)
    .select({ n: sql<number>`count(distinct ${artifactAsks.commentId})` })
    .from(artifactAsks)
    .innerJoin(artifacts, eq(artifacts.id, artifactAsks.artifactId))
    .where(forMe(caller));
  const held = await heldRequestRows(env, caller).catch(() => []);
  return Math.min((r[0]?.n ?? 0) + held.length, NEEDS_YOU_MAX);
}

type Row = {
  artifactId: string;
  title: string;
  threadId: string;
  commentId: string;
  question: string | null;
  asker: string | null;
  askedAt: string | null;
  confirm: number | null;
};

const readRows = (env: Env, caller: Me): Promise<Row[]> =>
  getDb(env)
    .select({
      artifactId: artifactAsks.artifactId,
      title: artifacts.title,
      threadId: artifactAsks.threadId,
      commentId: artifactAsks.commentId,
      question: artifactAsks.question,
      asker: artifactAsks.asker,
      askedAt: artifactAsks.askedAt,
      confirm: artifactAsks.confirm,
    })
    .from(artifactAsks)
    .innerJoin(artifacts, eq(artifacts.id, artifactAsks.artifactId))
    .where(forMe(caller))
    .orderBy(artifactAsks.askedAt)
    .limit(NEEDS_YOU_MAX * 2);

/** Rows to repair: mine and open, but never filled in (written before #2512). */
const unfilled = (env: Env, caller: Me): Promise<{ artifactId: string }[]> =>
  getDb(env)
    .select({ artifactId: artifactAsks.artifactId })
    .from(artifactAsks)
    .innerJoin(artifacts, eq(artifacts.id, artifactAsks.artifactId))
    .where(
      and(
        listFilterSql(caller, "all"),
        eq(artifactAsks.addressee, caller.user.id),
        eq(artifactAsks.open, 1),
        sql`${artifactAsks.question} is null`,
        sql`${artifacts.deletedAt} is null and ${artifacts.comments} = 1`,
      ),
    )
    .limit(NEEDS_YOU_MAX);

const iso = (s: string): string => {
  const t = Date.parse(s);
  return Number.isNaN(t)
    ? new Date(0).toISOString()
    : new Date(t).toISOString();
};

/**
 * The Needs-you list (#2512): the caller's open asks, a waiting agent's first,
 * then those that need a passkey or a risky confirm, then the rest, oldest
 * first in each group.
 */
export async function needsYou(env: Env, caller: Me): Promise<InboxItem[]> {
  const viewer: CommentViewer = {
    userId: caller.user.id,
    short: null,
    guest: isGuestRole(caller.user.role),
    capped: capsReads(capOfCaller(caller)),
  };
  // Rows written before the migration have no question. A full comments read
  // (it reconciles the index) repairs one artifact's rows, or drops the rows of
  // asks the DO no longer has; capped per request. A row still unfilled after
  // its artifact was read is not an open ask the DO knows: it is closed, so it
  // never costs another read.
  const old = [
    ...new Set((await unfilled(env, caller)).map((r) => r.artifactId)),
  ].slice(0, REPAIR_MAX);
  if (old.length > 0) {
    await Promise.all(
      old.map(async (id) => {
        try {
          // Only a complete, successful read can say the comment is no open ask.
          if (!(await repairAsks(env, id))) return;
          await env.DB.prepare(
            "update artifact_asks set open = 0 where artifact_id = ? and question is null",
          )
            .bind(id)
            .run();
        } catch (e) {
          logWarn("inbox_repair_failed", e, { artifactId: id });
        }
      }),
    );
  }
  const rows = await readRows(env, caller);
  const ready = rows.filter(
    (r): r is Row & { question: string; asker: string; askedAt: string } =>
      r.question !== null && r.asker !== null && r.askedAt !== null,
  );
  const actors = ready.map((r) => JSON.parse(r.asker) as StoredActor);
  const faces = await askerFaces(env, viewer, actors);
  // Only my own agents can wait on me: their status is in my hub.
  const mine = new Set<string>();
  for (const a of actors)
    if (a.ref === caller.user.id && a.agent?.identity)
      mine.add(a.agent.identity.identityId);
  const waiting = await agentsWaitingOn(env, caller.user.id, [...mine]);
  const items = ready.map((r, i): InboxItem & { rank: number } => {
    const actor = actors[i] as StoredActor;
    const face = faces[i] as CommentAuthor;
    const idn = actor.agent?.identity?.identityId;
    const since =
      idn && actor.ref === caller.user.id ? waiting.get(idn) : undefined;
    const urgency =
      since !== undefined ? "waiting" : r.confirm === 1 ? "approval" : "plain";
    return {
      id: `ask:${r.commentId}`,
      level: "needs_you",
      kind: "ask",
      urgency,
      ...(since !== undefined
        ? { waitingSince: new Date(since).toISOString() }
        : {}),
      artifact: { id: r.artifactId, title: r.title },
      actor: face,
      ...(face.kind === "agent" && idn && actor.ref === caller.user.id
        ? { agentKey: idn }
        : {}),
      text: `${face.name} asks: ${[...r.question].slice(0, QUESTION_MAX).join("")}`,
      href: `${viewerPath(r.artifactId)}?thread=${encodeURIComponent(r.threadId)}`,
      createdAt: iso(r.askedAt),
      readAt: null,
      rank: urgency === "waiting" ? 0 : urgency === "approval" ? 1 : 2,
    };
  });
  items.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
  // One item per ask: a person can hold the row twice only as asked and decider, which the key collapses.
  const seen = new Set<string>();
  const out: InboxItem[] = [];
  for (const { rank: _rank, ...item } of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= NEEDS_YOU_MAX) break;
  }
  return out;
}

/** How long a "member is set up" line stays (there is no read state for it yet). */
const SET_UP_DAYS = 30;

/**
 * #2632: "{name} is set up in {org}." for each member whose setup finished and
 * whose inviter (else the owner) is the caller; written once, at that moment.
 */
export async function memberSetUpUpdates(
  env: Env,
  caller: Me,
): Promise<InboxItem[]> {
  const rows = (
    await env.DB.prepare(
      "select key, value from settings where substr(key, 1, length(?1)) = ?1 order by cast(value as integer) desc limit 50",
    )
      .bind(setUpNoticeKey(caller.user.id, ""))
      .all<{ key: string; value: string }>()
  ).results;
  const since = Date.now() - SET_UP_DAYS * 86_400_000;
  const fresh = rows
    .map((r) => ({
      memberId: r.key.slice(setUpNoticeKey(caller.user.id, "").length),
      at: Number(r.value),
    }))
    .filter((r) => r.at >= since);
  if (!fresh.length) return [];
  const org = (await getSettings(env).catch(() => null))?.name ?? "your team";
  const out: InboxItem[] = [];
  for (const r of fresh) {
    const u = await getUser(env, r.memberId);
    if (!u) continue;
    out.push({
      id: `member_set_up:${u.id}`,
      level: "update",
      kind: "member_set_up",
      artifact: null,
      actor: { kind: "user", id: u.id, name: u.name ?? u.email, me: false },
      text: `${u.name ?? u.email} is set up in ${org}.`,
      href: "/settings/members",
      createdAt: new Date(r.at).toISOString(),
      readAt: null,
    });
  }
  return out;
}

/** The whole inbox response. Later and the cursor are the next slices. */
/** Requests to the caller's agents that wait for them, not quieted by "Not now": one row each. */
const heldRequestRows = async (env: Env, caller: Me, now = Date.now()) =>
  (
    await env.DB.prepare(
      `select r.id, r.sender_id, r.artifact_id, r.created_at, a.title as title
         from held_requests r join artifacts a on a.id = r.artifact_id and a.deleted_at is null
        where r.receiver_id = ?1 and (r.quiet_until is null or r.quiet_until <= ?2)
          and exists (select 1 from held_request_items i where i.request_id = r.id and i.state = 'held' and i.expires_at > ?2)
        order by r.last_at limit ?3`,
    )
      .bind(caller.user.id, now, NEEDS_YOU_MAX)
      .all<{
        id: string;
        sender_id: string;
        artifact_id: string;
        created_at: number;
        title: string;
      }>()
  ).results;

/**
 * #2577: someone asked one of the caller's agents; the request is held for them. One item per
 * (sender, page), however many requests: the words are read when it opens, never here.
 */
export async function heldRequestItems(
  env: Env,
  caller: Me,
): Promise<InboxItem[]> {
  const rows = await heldRequestRows(env, caller);
  if (rows.length === 0) return [];
  const viewer: CommentViewer = {
    userId: caller.user.id,
    short: null,
    guest: isGuestRole(caller.user.role),
    capped: capsReads(capOfCaller(caller)),
  };
  const faces = await askerFaces(
    env,
    viewer,
    rows.map((r): StoredActor => ({ kind: "user", ref: r.sender_id })),
  );
  return rows.map((r, i): InboxItem => {
    const face = faces[i] as CommentAuthor;
    return {
      id: `request:${r.id}`,
      level: "needs_you",
      kind: "request",
      urgency: "approval",
      waitingSince: iso(new Date(r.created_at).toISOString()),
      artifact: { id: r.artifact_id, title: r.title },
      actor: face,
      text: `${face.name} wants to ask your agent`,
      href: viewerPath(r.artifact_id),
      createdAt: new Date(r.created_at).toISOString(),
      readAt: null,
    };
  });
}

export async function inboxOf(env: Env, caller: Me): Promise<Inbox> {
  const asks = await needsYou(env, caller);
  const requests = await heldRequestItems(env, caller).catch((e) => {
    logWarn("inbox_held_requests_failed", e);
    return [];
  });
  // Waiting agents first, then what needs an approval (asks and requests, oldest first), then the rest.
  const byAge = (a: InboxItem, b: InboxItem) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  const list = [
    ...asks.filter((i) => i.urgency === "waiting"),
    ...[...asks.filter((i) => i.urgency === "approval"), ...requests].sort(
      byAge,
    ),
    ...asks.filter((i) => i.urgency !== "waiting" && i.urgency !== "approval"),
  ];
  const updates = await memberSetUpUpdates(env, caller).catch((e) => {
    logWarn("inbox_member_set_up_failed", e);
    return [];
  });
  return {
    needsYou: list,
    later: [],
    updates,
    cursor: null,
    counts: { needsYou: list.length, unreadUpdates: updates.length },
  };
}
