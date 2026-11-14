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
import { askerFaces, type CommentViewer, listComments } from "./comments.js";

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
    sql`${artifacts.deletedAt} is null and ${artifacts.comments} = 1`,
  );

/** How many open asks wait for the caller (the /me badge): one indexed query. */
export async function needsYouCount(env: Env, caller: Me): Promise<number> {
  const r = await getDb(env)
    .select({ n: sql<number>`count(distinct ${artifactAsks.commentId})` })
    .from(artifactAsks)
    .innerJoin(artifacts, eq(artifacts.id, artifactAsks.artifactId))
    .where(forMe(caller));
  return Math.min(r[0]?.n ?? 0, NEEDS_YOU_MAX);
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
    // The oldest are kept when over the cap's reach; rows still unfilled sort last.
    .orderBy(sql`${artifactAsks.askedAt} is null`, artifactAsks.askedAt)
    .limit(NEEDS_YOU_MAX * 2);

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
  let rows = await readRows(env, caller);
  // Rows written before the migration have no question: a full comments read
  // (it reconciles the index) repairs one artifact's rows; capped, then re-read.
  const old = [
    ...new Set(
      rows.filter((r) => r.question === null).map((r) => r.artifactId),
    ),
  ].slice(0, REPAIR_MAX);
  if (old.length > 0) {
    await Promise.all(
      old.map((id) =>
        listComments(env, id, "all", viewer).catch((e) =>
          logWarn("inbox_repair_failed", e, { artifactId: id }),
        ),
      ),
    );
    rows = await readRows(env, caller);
  }
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
      ...(face.kind === "agent" && idn ? { agentKey: idn } : {}),
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

/** The whole inbox response. Later, Updates and the cursor are the next slices. */
export async function inboxOf(env: Env, caller: Me): Promise<Inbox> {
  const list = await needsYou(env, caller);
  return {
    needsYou: list,
    later: [],
    updates: [],
    cursor: null,
    counts: { needsYou: list.length, unreadUpdates: 0 },
  };
}
