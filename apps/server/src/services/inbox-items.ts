// #2512 S2: the stored half of the For you inbox: updates (mentions of your
// agent, replies, comments, shares, decisions). Asks live in artifact_asks;
// a mention held for "Allow" is #2577's own Needs-you item, not one here.
// Writes are best effort, run after the comment is stored, and idempotent on
// (user, key), so a retry or a repeat writes one row. Never throws.
import { type Member, newId, stripNameControls } from "@oa/shared";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  accessLevels,
  type Caller,
  callerOf,
  capOfCaller,
  listFilterSql,
} from "../auth/authz.js";
import { capsReads } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { artifacts, inboxItems } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { takeAll } from "../email/send.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logWarn } from "../log.js";
import type { StoredActor, StoredComment } from "../runtime/comments-store.js";
import { runtimeStub } from "../runtime/do.js";
import { queueMentionPush } from "./push.js";
import { getUsers } from "./users.js";
import { pushOn } from "./web-push.js";

/** Person-mention Needs-you items one sender may cause per day (#2770). */
export const PERSON_MENTIONS_PER_DAY = 200;
/** The most characters of a comment an item keeps. */
export const EXCERPT_MAX = 120;
/** The items one page of Updates holds. */
export const UPDATES_PAGE = 30;
/** D1 allows 100 bound values per statement. */
const CHUNK = 90;

export type ItemKind = "mention" | "reply" | "comment" | "share" | "decision";

/** Plain text, at most EXCERPT_MAX characters: control, bidi and zero-width characters stripped, whitespace collapsed. */
export const itemExcerpt = (s: string): string => {
  const t = stripNameControls(s.replace(/\s+/g, " ")).trim();
  const cps = [...t];
  return cps.length <= EXCERPT_MAX
    ? t
    : `${cps.slice(0, EXCERPT_MAX - 1).join("")}…`;
};

export type NewItem = {
  userId: string;
  kind: ItemKind;
  /** The idempotency key, unique per person: "reply:<comment id>". */
  key: string;
  artifactId: string;
  threadId?: string;
  commentId?: string;
  actor: StoredActor;
  excerpt: string;
  /** A mention's agent. */
  agentName?: string;
  at: number;
};

/** Personal mentions belong in Needs you. Mentions of the recipient's agent belong in Updates. */
const isPersonalMention = (item: NewItem) =>
  item.kind === "mention" && item.key.startsWith("person:");

/**
 * Writes the items whose person can still read the artifact now (a member,
 * not read-capped). Never the actor's own. One insert-or-ignore each.
 */
export async function writeInboxItems(
  env: Env,
  items: NewItem[],
): Promise<void> {
  try {
    // Who can still read what: one batch of member reads and one batch of
    // access reads per artifact, not a D1 call per recipient.
    const candidates = items.filter(
      (it) => !(it.actor.kind === "user" && it.actor.ref === it.userId),
    );
    const users = await getUsers(env, [
      ...new Set(candidates.map((it) => it.userId)),
    ]);
    const byArtifact = new Map<string, Set<string>>();
    for (const it of candidates) {
      if (!users.has(it.userId)) continue;
      const set = byArtifact.get(it.artifactId) ?? new Set<string>();
      set.add(it.userId);
      byArtifact.set(it.artifactId, set);
    }
    const ok = new Set<string>();
    for (const [artifactId, ids] of byArtifact) {
      const list = [...ids].filter((id) => {
        const u = users.get(id);
        return u ? !capsReads(capOfCaller(callerOf(u))) : false;
      });
      const levels = await accessLevels(
        env,
        list.map((id) => callerOf(users.get(id) as Member)),
        artifactId,
      );
      list.forEach((id, i) => {
        if (levels[i]?.artifact) ok.add(`${id}|${artifactId}`);
      });
    }
    const rows = candidates.filter((it) =>
      ok.has(`${it.userId}|${it.artifactId}`),
    );
    const mentions: NewItem[] = [];
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const inserted = await env.DB.batch(
        batch.map((r) =>
          stmt(
            env.DB,
            `insert or ignore into inbox_items (id, user_id, kind, level, key, artifact_id, thread_id, comment_id, actor, excerpt, agent_name, created_at, read_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)`,
          ).bind(
            newId(),
            r.userId,
            r.kind,
            isPersonalMention(r) ? "needs_you" : "update",
            r.key,
            r.artifactId,
            r.threadId ?? null,
            r.commentId ?? null,
            JSON.stringify(r.actor),
            r.excerpt,
            r.agentName ?? null,
            r.at,
          ),
        ),
      );
      for (const [index, row] of batch.entries()) {
        if (inserted[index]?.meta.changes && isPersonalMention(row))
          mentions.push(row);
      }
    }
    // A replay of an already indexed mention must not send another push.
    if (!pushOn(env) || mentions.length === 0) return;
    const enrolled = await stmt(
      env.DB,
      "select distinct user_id from push_subscriptions where user_id in (select value from json_each(?1))",
    )
      .bind(JSON.stringify([...new Set(mentions.map((r) => r.userId))]))
      .all<{ user_id: string }>();
    const hasDevice = new Set(enrolled.results.map((r) => r.user_id));
    for (const r of mentions) {
      if (!hasDevice.has(r.userId)) continue;
      await queueMentionPush(env, r.userId, {
        key: r.key,
        artifactId: r.artifactId,
        threadId: r.threadId ?? "",
        askerName: r.actor.agent?.name ?? r.actor.name ?? "Someone",
        excerpt: r.excerpt,
      });
    }
  } catch (e) {
    logWarn("inbox_items_write_failed", e);
  }
}

const ORDER: ItemKind[] = ["mention", "reply", "comment"];

/**
 * A new thread or reply: the owner hears of a comment, the people already in a
 * thread hear of a reply, an agent's owner hears of an @-mention of it. One
 * item per person, the most specific kind. Never the author; a guest's comment
 * mentions no one and tells no agent's owner; an agent's comment does not
 * count as its person being "in the thread".
 */
export async function recordCommentItems(
  env: Env,
  j: {
    artifactId: string;
    threadId: string;
    comment: StoredComment;
    reply: boolean;
  },
): Promise<void> {
  try {
    const c = j.comment;
    const heldFor = heldOwners(c);
    const by = new Map<ItemKind, Set<string>>(
      ORDER.map((k) => [k, new Set<string>()]),
    );
    // A mention of your agent, by someone else, once per owner. The item
    // keeps the agent's name ("{author} mentioned {agent} on {page}"); its
    // excerpt stays the comment's text. Your own mention of your own agent: writeInboxItems skips the
    // actor. A guest author gives none.
    const agentOf = new Map<string, string>();
    if (c.author.kind !== "guest")
      for (const m of c.mentions ?? [])
        if (m.owner) {
          by.get("mention")?.add(m.owner);
          if (!agentOf.has(m.owner)) agentOf.set(m.owner, m.name);
        }
    if (j.reply) {
      const t = await runtimeStub(env, j.artifactId).commentsGet(j.threadId);
      for (const x of t.comments)
        if (x.author.kind === "user" && !x.author.agent)
          by.get("reply")?.add(x.author.ref);
    }
    const owner = await stmt(
      env.DB,
      "select owner_id as o from artifacts where id = ?",
    )
      .bind(j.artifactId)
      .first<{ o: string }>();
    if (owner) by.get("comment")?.add(owner.o);
    const seen = new Set<string>();
    const items: NewItem[] = [];
    const at = Date.parse(c.createdAt);
    // #2770: a person @mentioned is a Needs-you item, and the one item they get from this comment.
    if (c.author.kind !== "guest")
      for (const userId of c.people ?? []) {
        if (seen.has(userId)) continue;
        // A sender's daily cap on these items: over it the comment stands, no more items are written.
        if (
          c.author.kind === "user" &&
          (await takeAll(env, [
            [
              `prefs:pm:${c.author.ref}`,
              PERSON_MENTIONS_PER_DAY,
              new Date().toISOString().slice(0, 10),
            ],
          ])) !== -1
        ) {
          logWarn("person_mention_capped", undefined, {
            artifactId: j.artifactId,
          });
          continue;
        }
        seen.add(userId);
        items.push({
          userId,
          kind: "mention",
          key: `person:${c.id}`,
          artifactId: j.artifactId,
          threadId: j.threadId,
          commentId: c.id,
          actor: c.author,
          excerpt: heldFor.has(userId) ? HELD_EXCERPT : itemExcerpt(c.body),
          at: Number.isNaN(at) ? Date.now() : at,
        });
      }
    for (const kind of ORDER)
      for (const userId of by.get(kind) ?? []) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        items.push({
          userId,
          kind,
          key: `${kind}:${c.id}`,
          artifactId: j.artifactId,
          threadId: j.threadId,
          commentId: c.id,
          actor: c.author,
          // #2577: never the words of a request held for this person; allow() fills them in.
          excerpt: heldFor.has(userId) ? HELD_EXCERPT : itemExcerpt(c.body),
          ...(kind === "mention"
            ? { agentName: itemExcerpt(agentOf.get(userId) ?? "your agent") }
            : {}),
          at: Number.isNaN(at) ? Date.now() : at,
        });
      }
    await writeInboxItems(env, items);
  } catch (e) {
    logWarn("inbox_items_record_failed", e);
  }
}

/**
 * A comment was deleted: its items go (a root takes its whole thread's items
 * with it). Best effort, never throws.
 */
export async function forgetCommentItems(
  env: Env,
  j: { artifactId: string; threadId: string; commentId: string; root: boolean },
): Promise<void> {
  try {
    if (j.root)
      await env.DB.batch([
        // #2770: a person's Later row for a mention goes with the item.
        stmt(
          env.DB,
          `delete from inbox_later where item_id in
             (select 'mention:' || id from inbox_items where artifact_id = ? and thread_id = ?)`,
        ).bind(j.artifactId, j.threadId),
        stmt(
          env.DB,
          "delete from inbox_items where artifact_id = ? and thread_id = ?",
        ).bind(j.artifactId, j.threadId),
        // #2512 S5: what was queued for push goes with it.
        stmt(
          env.DB,
          "delete from push_pending where artifact_id = ? and thread_id = ?",
        ).bind(j.artifactId, j.threadId),
      ]);
    else
      await env.DB.batch([
        stmt(
          env.DB,
          `delete from inbox_later where item_id in
             (select 'mention:' || id from inbox_items where artifact_id = ? and comment_id = ?)`,
        ).bind(j.artifactId, j.commentId),
        stmt(
          env.DB,
          "delete from inbox_items where artifact_id = ? and comment_id = ?",
        ).bind(j.artifactId, j.commentId),
        stmt(
          env.DB,
          `delete from push_pending where artifact_id = ?1 and key in
             ('ask:' || ?2, 'reply:' || ?2, 'comment:' || ?2, 'mention:' || ?2, 'person:' || ?2)`,
        ).bind(j.artifactId, j.commentId),
      ]);
  } catch (e) {
    logWarn("inbox_items_forget_failed", e);
  }
}

/** #2577: the excerpt of an item whose comment holds a request for its person, until they allow it. */
export const HELD_EXCERPT = "A request is waiting for you to allow it";

/** The people a comment holds a request for, in any state (held, releasing, lapsed). */
export const heldOwners = (c: { held?: { owner: string }[] }): Set<string> =>
  new Set((c.held ?? []).map((h) => h.owner));

/** A comment was edited: its mention, reply and comment items show the new text, except to people it holds a request for. */
export async function refreshCommentItems(
  env: Env,
  j: {
    artifactId: string;
    commentId: string;
    body: string;
    held?: { owner: string }[];
  },
): Promise<void> {
  try {
    const held = [...heldOwners(j)];
    const words = [
      itemExcerpt(j.body),
      j.artifactId,
      j.commentId,
      JSON.stringify(held),
      HELD_EXCERPT,
    ];
    await env.DB.batch([
      stmt(
        env.DB,
        `update inbox_items set excerpt = case when user_id in (select value from json_each(?4)) then ?5 else ?1 end
          where artifact_id = ?2 and comment_id = ?3 and kind in ('mention', 'reply', 'comment')`,
      ).bind(...words),
      // #2512 S5: what is queued for push shows the new words too.
      stmt(
        env.DB,
        `update push_pending set excerpt = case when user_id in (select value from json_each(?4)) then ?5 else ?1 end
          where artifact_id = ?2 and key in ('reply:' || ?3, 'comment:' || ?3, 'mention:' || ?3)`,
      ).bind(...words),
    ]);
  } catch (e) {
    logWarn("inbox_items_refresh_failed", e);
  }
}

/** A page shared with a member: one item for them. A non-member email has no inbox. */
export async function recordShareItem(
  env: Env,
  j: {
    artifactId: string;
    title: string;
    email: string;
    sharer: string;
    sharerName: string;
    createdAt: number;
  },
): Promise<void> {
  try {
    const to = await stmt(env.DB, "select id from users where email = ?")
      .bind(j.email)
      .first<{ id: string }>();
    if (!to) return;
    await writeInboxItems(env, [
      {
        userId: to.id,
        kind: "share",
        key: `share:${j.artifactId}:${j.createdAt}`,
        artifactId: j.artifactId,
        actor: { kind: "user", ref: j.sharer, name: j.sharerName },
        excerpt: itemExcerpt(j.title),
        at: j.createdAt,
      },
    ]);
  } catch (e) {
    logWarn("inbox_items_record_failed", e);
  }
}

/**
 * An ask was decided: each person who weighed in (their row closed before the
 * decision closed the rest) hears of it, except the one who decided. Call
 * before the decision closes the asks index rows.
 */
export async function recordDecisionItems(
  env: Env,
  j: {
    artifactId: string;
    threadId: string;
    commentId: string;
    question: string;
    by: StoredActor;
    decidedAt: string;
  },
): Promise<void> {
  try {
    const rows = await stmt(
      env.DB,
      "select addressee from artifact_asks where artifact_id = ? and comment_id = ? and open = 0 and answered = 1",
    )
      .bind(j.artifactId, j.commentId)
      .all<{ addressee: string }>();
    const at = Date.parse(j.decidedAt);
    await writeInboxItems(
      env,
      rows.results.map((r) => ({
        userId: r.addressee,
        kind: "decision" as const,
        key: `decision:${j.commentId}:${j.decidedAt}`,
        artifactId: j.artifactId,
        threadId: j.threadId,
        commentId: j.commentId,
        actor: j.by,
        excerpt: itemExcerpt(j.question),
        at: Number.isNaN(at) ? Date.now() : at,
      })),
    );
  } catch (e) {
    logWarn("inbox_items_record_failed", e);
  }
}

// ------------------------------------------------------------------- reads

type Me = Extract<Caller, { kind: "user" }>;

/** My item rows on a page I can still read (not deleted). */
const mineOn = (caller: Me, level: "needs_you" | "update") =>
  and(
    listFilterSql(caller, "all"),
    eq(inboxItems.userId, caller.user.id),
    eq(inboxItems.level, level),
    sql`${artifacts.deletedAt} is null`,
  );

export type ItemRow = {
  id: string;
  kind: ItemKind;
  artifactId: string;
  title: string;
  threadId: string | null;
  commentId: string | null;
  actor: string;
  excerpt: string;
  agentName: string | null;
  createdAt: number;
  readAt: number | null;
};

const cols = {
  id: inboxItems.id,
  kind: inboxItems.kind,
  artifactId: inboxItems.artifactId,
  title: artifacts.title,
  threadId: inboxItems.threadId,
  commentId: inboxItems.commentId,
  actor: inboxItems.actor,
  excerpt: inboxItems.excerpt,
  agentName: inboxItems.agentName,
  createdAt: inboxItems.createdAt,
  readAt: inboxItems.readAt,
};

/** The unread updates that arrived in [from, to) and the distinct pages they are on (#2512, "While you were away"). */
export async function awayCount(
  env: Env,
  caller: Me,
  from: number,
  to: number,
): Promise<{ count: number; pages: number }> {
  const r = await getDb(env)
    .select({
      n: sql<number>`count(*)`,
      p: sql<number>`count(distinct ${inboxItems.artifactId})`,
    })
    .from(inboxItems)
    .innerJoin(artifacts, eq(artifacts.id, inboxItems.artifactId))
    .where(
      and(
        mineOn(caller, "update"),
        isNull(inboxItems.readAt),
        sql`${inboxItems.createdAt} >= ${from} and ${inboxItems.createdAt} < ${to}`,
      ),
    );
  return { count: r[0]?.n ?? 0, pages: r[0]?.p ?? 0 };
}

/** The settings row that says which "While you were away" window the person has read (its start, ms). */
export const awayReadKey = (userId: string) => `inbox:away_read:${userId}`;

/** How many unread updates I have: one indexed query. */
export async function unreadUpdateCount(env: Env, caller: Me): Promise<number> {
  const r = await getDb(env)
    .select({ n: sql<number>`count(*)` })
    .from(inboxItems)
    .innerJoin(artifacts, eq(artifacts.id, inboxItems.artifactId))
    .where(and(mineOn(caller, "update"), isNull(inboxItems.readAt)));
  return r[0]?.n ?? 0;
}

const encodeCursor = (createdAt: number, id: string): string =>
  btoa(`${createdAt}:${id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeCursor = (s: string): { at: number; id: string } => {
  try {
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const i = raw.indexOf(":");
    const at = Number(raw.slice(0, i));
    const id = raw.slice(i + 1);
    if (i > 0 && Number.isInteger(at) && id) return { at, id };
  } catch {
    // falls through
  }
  throw new ApiError("bad_request", "Invalid cursor");
};

/** One page of my updates, newest first; `cursor` (opaque) continues after the last item of the previous page. */
export async function updatesPage(
  env: Env,
  caller: Me,
  cursor: string | undefined,
): Promise<{ rows: ItemRow[]; next: string | null }> {
  const at = cursor ? decodeCursor(cursor) : null;
  const rows = (await getDb(env)
    .select(cols)
    .from(inboxItems)
    .innerJoin(artifacts, eq(artifacts.id, inboxItems.artifactId))
    .where(
      and(
        mineOn(caller, "update"),
        at
          ? or(
              lt(inboxItems.createdAt, at.at),
              and(eq(inboxItems.createdAt, at.at), lt(inboxItems.id, at.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
    .limit(UPDATES_PAGE + 1)) as ItemRow[];
  const more = rows.length > UPDATES_PAGE;
  const page = rows.slice(0, UPDATES_PAGE);
  const last = page[page.length - 1];
  return {
    rows: page,
    next: more && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** #2770: the mentions of me still waiting in Needs you (unread), oldest first. */
export async function mentionsOfMe(env: Env, caller: Me): Promise<ItemRow[]> {
  return (await getDb(env)
    .select(cols)
    .from(inboxItems)
    .innerJoin(artifacts, eq(artifacts.id, inboxItems.artifactId))
    .where(and(mineOn(caller, "needs_you"), isNull(inboxItems.readAt)))
    .orderBy(inboxItems.createdAt, inboxItems.id)
    .limit(200)) as ItemRow[];
}

/** Marks my items read by id; others' ids, asks and unknown ids match nothing. Returns how many changed. */
export async function markRead(
  env: Env,
  userId: string,
  ids: string[],
): Promise<number> {
  const uniq = [...new Set(ids)].filter((id) => !id.startsWith("away:"));
  const now = Date.now();
  let n = 0;
  // "While you were away" is not a stored row: reading it keeps the window's start.
  for (const id of new Set(ids)) {
    if (!id.startsWith("away:")) continue;
    const at = Date.parse(id.slice("away:".length));
    if (Number.isNaN(at)) continue;
    const r = await env.DB.prepare(
      `insert into settings (key, value) values (?1, ?2)
       on conflict (key) do update set value = excluded.value
         where cast(settings.value as integer) < cast(excluded.value as integer)`,
    )
      .bind(awayReadKey(userId), String(at))
      .run();
    n += r.meta.changes ?? 0;
  }
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const part = uniq.slice(i, i + CHUNK);
    const r = await env.DB.prepare(
      `update inbox_items set read_at = ? where user_id = ? and read_at is null and id in (${part.map(() => "?").join(",")})`,
    )
      .bind(now, userId, ...part)
      .run();
    n += r.meta.changes ?? 0;
  }
  return n;
}

/** Marks all my updates read. A mention (Needs you) clears only when it is read by id. */
export async function markAllRead(env: Env, userId: string): Promise<number> {
  const r = await stmt(
    env.DB,
    "update inbox_items set read_at = ? where user_id = ? and level = 'update' and read_at is null",
  )
    .bind(Date.now(), userId)
    .run();
  return r.meta.changes ?? 0;
}
