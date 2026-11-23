// #2512 S5, #3024: browser push for what needs a member. One set of account
// choices (notification prefs: Needs you, every ask, quiet hours, lock screen).
// A subscription row is one enrolled device (an address, keys, a label); an
// endpoint belongs to one member at a time. A new Needs-you item (or one back
// from Later) is queued for a member whose account Needs you is on and who has a
// device, and the cron tick sends what is due to every device: held for the
// 10-minute bundle and for quiet hours, one notification for everything due.
// Updates never push. The text is written here and never taken from a client:
// by default only "An agent is waiting for your answer"; the asker and the
// question show only with lockScreenDetail.
import {
  newId,
  type PushPayload,
  type PushSubscribeBody,
  type PushSubscriptionPatchBody,
  type PushSubscriptions,
  stripNameControls,
  viewerPath,
} from "@oa/shared";
import { accessLevels, callerOf, capOfCaller } from "../auth/authz.js";
import { capsReads } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import { orgName } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError, logWarn } from "../log.js";
import type { StoredActor } from "../runtime/comments-store.js";
import { agentsWaitingOn } from "./bus.js";
import { itemExcerpt } from "./inbox-items.js";
import { mutedSet } from "./inbox-mutes.js";
import { getSettings } from "./members.js";
import { getPrefs, quietState } from "./notification-prefs.js";
import { getUser } from "./users.js";
import { pushEndpointOk, pushKeysOk, pushOn, sendPush } from "./web-push.js";

/** Items that arrive within this long of the last push wait and go as one. */
export const BUNDLE_MS = 10 * 60_000;
/** Browsers one member may have; the oldest is dropped past it. */
export const MAX_SUBSCRIPTIONS = 10;
/** Members one tick sends to, and rows it reads. */
const TICK_MEMBERS = 50;
const TICK_ROWS = 500;
/** A pending row older than this is stale and dropped unsent. */
const STALE_MS = 24 * 3600_000;

export const DEFAULT_BODY = "An agent is waiting for your answer";

// ---------------------------------------------------------- subscriptions

export async function listSubscriptions(
  env: Env,
  userId: string,
): Promise<PushSubscriptions> {
  const { results } = await stmt(
    env.DB,
    "select id, label, created_at, last_sent_at from push_subscriptions where user_id = ?1 order by created_at, id",
  )
    .bind(userId)
    .all<{
      id: string;
      label: string | null;
      created_at: number;
      last_sent_at: number | null;
    }>();
  return {
    items: results.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: new Date(r.created_at).toISOString(),
      lastSentAt: r.last_sent_at
        ? new Date(r.last_sent_at).toISOString()
        : null,
      // Projected for the existing client: an enrolled device is on for
      // Needs you; Updates are list-only and never push.
      needsYou: true,
      updates: false,
    })),
  };
}

/**
 * Registers a browser for the member. The endpoint must be a known push
 * service (SSRF). If it was another member's, it is theirs no more: one
 * browser, one member. The same member subscribing again keeps their row and
 * takes the new keys. Resolves to the subscription's id.
 */
export async function addSubscription(
  env: Env,
  userId: string,
  body: PushSubscribeBody,
): Promise<string> {
  if (!pushEndpointOk(body.endpoint))
    throw new ApiError("bad_request", "That push service isn't supported", {
      path: "endpoint",
      reason: "unsupported",
    });
  if (!(await pushKeysOk(body.keys.p256dh, body.keys.auth)))
    throw new ApiError("bad_request", "Those push keys can't be used", {
      path: "keys",
      reason: "invalid",
    });
  const label = body.label
    ? stripNameControls(body.label).trim() || null
    : null;
  const id = newId();
  const now = Date.now();
  // Enrolling a device never touches the member's account choices.
  const [, , row] = await env.DB.batch([
    // Axe 1: gone from anyone else.
    stmt(
      env.DB,
      "delete from push_subscriptions where endpoint = ?1 and user_id <> ?2",
    ).bind(body.endpoint, userId),
    stmt(
      env.DB,
      `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       on conflict (endpoint) do update set
         p256dh = excluded.p256dh, auth = excluded.auth,
         label = coalesce(excluded.label, label)`,
    ).bind(
      id,
      userId,
      body.endpoint,
      body.keys.p256dh,
      body.keys.auth,
      label,
      now,
    ),
    stmt(env.DB, "select id from push_subscriptions where endpoint = ?1").bind(
      body.endpoint,
    ),
  ]);
  // Past the cap the oldest go.
  await stmt(
    env.DB,
    `delete from push_subscriptions where user_id = ?1 and id not in (
       select id from push_subscriptions where user_id = ?1 order by created_at desc, id limit ?2)`,
  )
    .bind(userId, MAX_SUBSCRIPTIONS)
    .run();
  return (row?.results[0] as { id: string } | undefined)?.id ?? id;
}

/**
 * The existing client's per-device switch (kept for it until its own UI change).
 * A device has no switches of its own: `needsYou: false` removes this caller's
 * device (and only it); anything else changes nothing. Resolves to the
 * projected switches (an enrolled device: Needs you on, Updates off), or
 * Needs you off once removed; null when the subscription isn't the member's.
 */
export async function patchSubscription(
  env: Env,
  userId: string,
  id: string,
  body: PushSubscriptionPatchBody,
): Promise<{ needsYou: boolean; updates: boolean } | null> {
  if (body.needsYou === false)
    return (await removeSubscription(env, userId, id))
      ? { needsYou: false, updates: false }
      : null;
  const mine = await stmt(
    env.DB,
    "select 1 as x from push_subscriptions where id = ?1 and user_id = ?2",
  )
    .bind(id, userId)
    .first();
  return mine ? { needsYou: true, updates: false } : null;
}

/** Removes the member's own subscription; false when it isn't theirs or isn't there. */
export async function removeSubscription(
  env: Env,
  userId: string,
  id: string,
): Promise<boolean> {
  const r = await stmt(
    env.DB,
    "delete from push_subscriptions where id = ?1 and user_id = ?2",
  )
    .bind(id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ------------------------------------------------------------------ queue

export type PushItem = {
  /** One row per (member, key): "ask:<comment id>", "later:<item id>:<until>". */
  key: string;
  /** Both are Needs-you: "ask" is new, "later" is back from Later. Updates never push. */
  kind: "ask" | "later";
  artifactId: string;
  threadId: string;
  askerName: string;
  /** The question, shown only when the member chose lock screen details. */
  excerpt: string;
  /** The asker, when it is an agent of the member: who waits on whom. */
  askerRef?: string | null;
  agentKey?: string | null;
};

const IN_CHUNK = 90;

type Recipient = { id: string; waiting: number | null; last: number | null };
type LaterRow = { user_id: string; item_id: string; until: number };

async function recipients(env: Env, ids: string[]): Promise<Recipient[]> {
  const marks = ids.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await env.DB.prepare(
    `select p.user_id as id,
       (select max(send_after) from push_pending q where q.user_id = p.user_id and q.kind <> 'update') as waiting,
       (select max(last_sent_at) from push_subscriptions s where s.user_id = p.user_id) as last
     from notification_prefs p
     where p.needs_you_browser = 1 and p.user_id in (${marks})
       and exists (select 1 from push_subscriptions s where s.user_id = p.user_id)`,
  )
    .bind(...ids)
    .all<Recipient>();
  return results;
}

async function pendingInsert(
  env: Env,
  to: Recipient,
  item: PushItem,
  now: number,
  later?: LaterRow,
): Promise<D1PreparedStatement> {
  const next =
    to.waiting ?? (to.last === null ? now : Math.max(now, to.last + BUNDLE_MS));
  const quiet = quietState(await getPrefs(env, to.id), now);
  return stmt(
    env.DB,
    `insert into push_pending
       (id, user_id, key, kind, artifact_id, thread_id, asker_name, excerpt, asker_ref, agent_key, send_after, created_at)
     select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
     where ?13 is null or exists (
       select 1 from inbox_later where user_id = ?2 and item_id = ?13 and until = ?14 and pushed_at is null)
     on conflict (user_id, key) do nothing`,
  ).bind(
    newId(),
    to.id,
    item.key,
    item.kind,
    item.artifactId,
    item.threadId,
    stripNameControls(item.askerName).slice(0, 80),
    itemExcerpt(item.excerpt),
    item.askerRef ?? null,
    item.agentKey ?? null,
    quiet.quiet ? Math.max(next, quiet.until) : next,
    now,
    later?.item_id ?? null,
    later?.until ?? null,
  );
}

/**
 * Queues `item` for each of `userIds` whose account Needs you is on and who has
 * a device. Held for the bundle (a push in the last 10 minutes, or items
 * already waiting, set the time) and for quiet hours. Best effort: never throws.
 */
export async function queuePush(
  env: Env,
  userIds: string[],
  item: PushItem,
  now = Date.now(),
): Promise<void> {
  if (!pushOn(env) || userIds.length === 0) return;
  // Only Needs-you ever queues; a row of any other kind (an old caller) is refused.
  if (item.kind !== "ask" && item.kind !== "later") return;
  try {
    for (let i = 0; i < userIds.length; i += IN_CHUNK) {
      const chunk = userIds.slice(i, i + IN_CHUNK);
      for (const to of await recipients(env, chunk)) {
        const insert = await pendingInsert(env, to, item, now);
        await insert.run();
      }
    }
  } catch (e) {
    logWarn("push_queue_failed", e);
  }
}

/**
 * A new ask: queue it for each person it waits on, except the person who just
 * wrote it (a human's own ask). Held asks (#2577) are not queued.
 */
export async function queueAskPush(
  env: Env,
  people: string[],
  held: ReadonlySet<string>,
  artifactId: string,
  threadId: string,
  commentId: string,
  info: { question: string; asker: string },
): Promise<void> {
  if (!pushOn(env)) return;
  let actor: StoredActor;
  try {
    actor = JSON.parse(info.asker) as StoredActor;
  } catch {
    return;
  }
  const to = people.filter(
    (u) => !held.has(u) && !(u === actor.ref && !actor.agent),
  );
  await queuePush(env, to, {
    key: `ask:${commentId}`,
    kind: "ask",
    artifactId,
    threadId,
    askerName: actor.agent?.name ?? actor.name ?? "Someone",
    excerpt: info.question,
    askerRef: actor.agent ? actor.ref : null,
    agentKey: actor.agent?.identity?.identityId ?? null,
  });
}

// ------------------------------------------------------------------ drain

type Pending = {
  id: string;
  user_id: string;
  key: string;
  /** "update" only on a row queued before Updates stopped pushing: dropped unsent. */
  kind: "ask" | "later" | "update";
  artifact_id: string;
  thread_id: string;
  asker_name: string;
  excerpt: string;
  asker_ref: string | null;
  agent_key: string | null;
  created_at: number;
  /** Set at send time: the ask is an open approval (artifact_asks.confirm). */
  approval?: boolean;
};

type Sub = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** #2781: a person's @-mention of the member (Needs you), without lock-screen detail. */
export const DEFAULT_MENTION_BODY = "Someone mentioned you";

/** #2577: a request held for the member to allow: its key is "held:<request id>". Fixed text, never the words. */
export const HELD_PUSH_PREFIX = "held:";
export const DEFAULT_HELD_BODY = "A request is waiting for you to allow it";
const isHeldPush = (r: { key: string }): boolean =>
  r.key.startsWith(HELD_PUSH_PREFIX);

/** A Needs-you item of a person @mentioned (#2770, #2781): its key is "person:<comment id>". */
const isPersonMention = (r: { key: string }): boolean =>
  r.key.startsWith("person:");

/** #3024: a mention put off with Later and back: "later:mention:<inbox item id>:<until>". */
const LATER_MENTION = "later:mention:";
const isLaterMention = (r: { key: string }): boolean =>
  r.key.startsWith(LATER_MENTION);

/** Any person's mention, new or back from Later. */
const isMention = (r: { key: string }): boolean =>
  isPersonMention(r) || isLaterMention(r);

/**
 * The one notification for everything due to one device: fixed text, a link to
 * the latest item. The count is everything in it. Needs-you only.
 */
export function pushPayload(
  items: Pick<
    Pending,
    "kind" | "key" | "artifact_id" | "thread_id" | "asker_name" | "excerpt"
  >[],
  detail: boolean,
  title: string,
): PushPayload {
  const n = items.length;
  const lead = items[n - 1] as (typeof items)[number];
  let body: string;
  let heading = title;
  const mentions = items.filter(isMention).length;
  if (n > 1) {
    // Design v10, "Several at once": counts only, safe on a lock screen too.
    const asks = n - mentions;
    const parts = [
      asks > 0 ? `${asks} ${asks === 1 ? "ask" : "asks"}` : "",
      mentions > 0
        ? `${mentions} ${mentions === 1 ? "mention" : "mentions"}`
        : "",
    ].filter(Boolean);
    heading = `${n} things need you`;
    body = parts.join(", ");
  } else {
    const mention = isMention(lead);
    const asks = detail
      ? mention
        ? `${lead.asker_name} mentioned you: ${lead.excerpt}`
        : `${lead.asker_name} asks: ${lead.excerpt}`
      : "";
    // One item (several are the counts above).
    body = isHeldPush(lead)
      ? DEFAULT_HELD_BODY
      : detail
        ? asks
        : mention
          ? DEFAULT_MENTION_BODY
          : DEFAULT_BODY;
  }
  return {
    v: 1,
    title: heading,
    body: [...body].slice(0, 200).join(""),
    href: lead.thread_id
      ? `${viewerPath(lead.artifact_id)}?thread=${encodeURIComponent(lead.thread_id)}`
      : viewerPath(lead.artifact_id),
    tag: "needs-you",
    ...(n > 1 ? { count: n } : {}),
  };
}

/**
 * Sends what is due (the cron tick; one read when nothing is). Per member:
 * account Needs you off drops their rows (and a queued Update is always
 * dropped); quiet hours hold them to when quiet ends; otherwise their rows are
 * claimed (deleted), filtered to what interrupts them (waiting asks, approvals,
 * held requests and mentions, plus every ask with browserAllAsks), and sent as
 * one notification to each enrolled device. A 404 or 410 removes the device;
 * other failures are logged and dropped. Never throws. Resolves to the
 * notifications sent.
 */
export async function drainPush(env: Env, now = Date.now()): Promise<number> {
  if (!pushOn(env)) return 0;
  let sent = 0;
  try {
    await queueLaterReturns(env, now);
    const { results } = await stmt(
      env.DB,
      `select id, user_id, key, kind, artifact_id, thread_id, asker_name, excerpt, asker_ref, agent_key, created_at
         from push_pending where send_after <= ?1 order by user_id, created_at limit ?2`,
    )
      .bind(now, TICK_ROWS)
      .all<Pending>();
    if (results.length === 0) return 0;
    await stmt(env.DB, "delete from push_pending where created_at < ?1")
      .bind(now - STALE_MS)
      .run();
    const byUser = new Map<string, Pending[]>();
    for (const r of results) {
      if (r.created_at < now - STALE_MS) continue;
      const l = byUser.get(r.user_id) ?? [];
      l.push(r);
      byUser.set(r.user_id, l);
    }
    const settings = await getSettings(env).catch(() => null);
    const title = orgName(settings?.name, env.APP_HOST);
    for (const [userId, rows] of [...byUser].slice(0, TICK_MEMBERS)) {
      try {
        sent += await drainMember(env, userId, rows, title, now);
      } catch (e) {
        logError("push_member_failed", e);
      }
    }
  } catch (e) {
    logError("push_drain_failed", e);
  }
  return sent;
}

const dropRows = (env: Env, rows: Pending[]) =>
  env.DB.batch(
    rows.map((r) =>
      stmt(env.DB, "delete from push_pending where id = ?1").bind(r.id),
    ),
  );

/**
 * What is still true at send time (the queue may be minutes or hours old): the
 * member can still read the page, the ask is still open for them, a mention's
 * item still exists for them, is unread and (for a new one) not put off, and
 * the words are the current ones (an edited comment or question), never the
 * words queued. Rows that fail any are dropped. Rows of an ask carry
 * `approval` when it is an open confirm.
 */
async function stillWanted(
  env: Env,
  userId: string,
  rows: Pending[],
  now: number,
): Promise<Pending[]> {
  const user = await getUser(env, userId);
  if (!user || capsReads(capOfCaller(callerOf(user)))) return [];
  const caller = callerOf(user);
  const readable = new Set<string>();
  for (const id of new Set(rows.map((r) => r.artifact_id))) {
    const [lvl] = await accessLevels(env, [caller], id);
    if (lvl?.artifact) readable.add(id);
  }
  const kept = rows.filter((r) => readable.has(r.artifact_id));
  // "ask:<comment id>" and "later:ask:<comment id>:<until>" both wait on an open ask.
  const cid = (r: Pending): string =>
    r.kind === "later" ? (r.key.split(":")[2] ?? "") : r.key.slice(4);
  const asks = kept.filter(
    (r) =>
      (r.kind === "ask" || r.kind === "later") &&
      !isMention(r) &&
      !isHeldPush(r),
  );
  // A held request waits on its own items: at least one still held and in time.
  const stillHeld = new Set<string>();
  const heldRows = kept.filter(isHeldPush);
  if (heldRows.length > 0) {
    const { results } = await stmt(
      env.DB,
      `select distinct r.id as id from held_requests r join held_request_items i on i.request_id = r.id
        where r.receiver_id = ?1 and i.state = 'held' and i.expires_at > ?3
          and r.id in (select value from json_each(?2))`,
    )
      .bind(
        userId,
        JSON.stringify(
          heldRows.map((r) => r.key.slice(HELD_PUSH_PREFIX.length)),
        ),
        now,
      )
      .all<{ id: string }>();
    for (const r of results) stillHeld.add(r.id);
  }
  const open = new Map<string, { question: string; approval: boolean }>();
  if (asks.length > 0) {
    const { results } = await stmt(
      env.DB,
      `select comment_id, question, confirm from artifact_asks
        where addressee = ?1 and open = 1 and comment_id in (select value from json_each(?2))`,
    )
      .bind(userId, JSON.stringify(asks.map(cid)))
      .all<{
        comment_id: string;
        question: string | null;
        confirm: number | null;
      }>();
    for (const r of results)
      open.set(r.comment_id, {
        question: r.question ?? "",
        approval: r.confirm === 1,
      });
  }
  // A mention waits on its own item (#2781): it must still exist for this member,
  // be an unread Needs-you mention and, if new, not be put off (its return is
  // what tells them then). A back-from-Later one is found by the original
  // per-member item id, and must still be on the same page and thread.
  const byKey = new Map<string, MentionItem>();
  const byId = new Map<string, MentionItem>();
  const mentionRows = kept.filter(isMention);
  if (mentionRows.length > 0) {
    const { results } = await stmt(
      env.DB,
      `select i.id as id, i.key as key, i.excerpt as excerpt, i.artifact_id as artifact_id, i.thread_id as thread_id,
              exists (select 1 from inbox_later l where l.user_id = i.user_id and l.item_id = 'mention:' || i.id) as deferred
         from inbox_items i
        where i.user_id = ?1 and i.kind = 'mention' and i.level = 'needs_you' and i.key like 'person:%' and i.read_at is null
          and (i.key in (select value from json_each(?2)) or i.id in (select value from json_each(?3)))`,
    )
      .bind(
        userId,
        JSON.stringify(mentionRows.filter(isPersonMention).map((r) => r.key)),
        JSON.stringify(mentionRows.filter(isLaterMention).map(laterMentionId)),
      )
      .all<MentionItem>();
    for (const r of results) {
      byKey.set(r.key, r);
      byId.set(r.id, r);
    }
  }
  const out: Pending[] = [];
  for (const r of kept) {
    if (r.kind === "update") continue;
    if (isHeldPush(r)) {
      if (stillHeld.has(r.key.slice(HELD_PUSH_PREFIX.length))) out.push(r);
    } else if (isPersonMention(r)) {
      const m = byKey.get(r.key);
      if (!m || m.deferred === 1 || m.artifact_id !== r.artifact_id) continue;
      out.push({ ...r, excerpt: m.excerpt });
    } else if (isLaterMention(r)) {
      const m = byId.get(laterMentionId(r));
      if (!m || m.artifact_id !== r.artifact_id) continue;
      out.push({ ...r, excerpt: m.excerpt, thread_id: m.thread_id ?? "" });
    } else if (r.kind === "ask" || r.kind === "later") {
      const a = open.get(cid(r));
      if (a === undefined) continue;
      out.push({
        ...r,
        excerpt: a.question ? itemExcerpt(a.question) : r.excerpt,
        approval: a.approval,
      });
    }
  }
  return out;
}

type MentionItem = {
  id: string;
  key: string;
  excerpt: string;
  artifact_id: string;
  thread_id: string | null;
  deferred: number;
};

/** The inbox item id in "later:mention:<id>:<until>". */
const laterMentionId = (r: { key: string }): string =>
  r.key.split(":")[2] ?? "";

async function drainMember(
  env: Env,
  userId: string,
  rows: Pending[],
  title: string,
  now: number,
): Promise<number> {
  const prefs = await getPrefs(env, userId);
  // The account's Needs you is the one switch: off drops the rows. An Update
  // never sends, even one queued before Updates stopped pushing.
  const live = rows.filter(
    (r) => r.kind !== "update" && prefs.needsYou.browser,
  );
  const off = rows.filter((r) => !live.includes(r));
  if (off.length > 0) await dropRows(env, off);
  if (live.length === 0) return 0;
  const q = quietState(prefs, now);
  if (q.quiet) {
    // Nothing breaks through: held to when quiet hours end.
    await env.DB.batch(
      live.map((r) =>
        stmt(
          env.DB,
          "update push_pending set send_after = ?1 where id = ?2",
        ).bind(q.until, r.id),
      ),
    );
    return 0;
  }
  const { results: subs } = await stmt(
    env.DB,
    "select id, endpoint, p256dh, auth from push_subscriptions where user_id = ?1",
  )
    .bind(userId)
    .all<Sub>();
  // Overlapping ticks may read the same rows. Only the tick that removes a
  // still-due row may send it.
  const claimed = await stmt(
    env.DB,
    `delete from push_pending where user_id = ?1 and send_after <= ?2
       and id in (select value from json_each(?3)) returning id`,
  )
    .bind(userId, now, JSON.stringify(live.map((r) => r.id)))
    .all<{ id: string }>();
  const claimedIds = new Set(claimed.results.map((r) => r.id));
  if (subs.length === 0 || claimedIds.size === 0) return 0;
  // A mute stops push: its agent's and its page's items are not sent.
  const muted = await mutedSet(env, userId);
  let due = live.filter(
    (r) =>
      claimedIds.has(r.id) &&
      !muted.pages.has(r.artifact_id) &&
      !(r.agent_key && muted.agents.has(r.agent_key)),
  );
  due = await stillWanted(env, userId, due, now);
  if (due.length === 0) return 0;
  if (!prefs.browserAllAsks) {
    // Under Needs you, held requests and mentions always interrupt, and so do
    // an ask an agent of theirs waits on (the wait check) and an open approval.
    // A plain ask needs "every ask put to me" (browserAllAsks).
    const asks = due.filter(
      (r) => r.kind === "ask" && !isMention(r) && !isHeldPush(r),
    );
    const keys = [
      ...new Set(
        asks
          .filter((r) => r.asker_ref === userId && r.agent_key)
          .map((r) => r.agent_key as string),
      ),
    ];
    const waiting = keys.length
      ? await agentsWaitingOn(env, userId, keys)
      : new Map<string, number>();
    due = due.filter(
      (r) =>
        r.kind !== "ask" ||
        isMention(r) ||
        isHeldPush(r) ||
        r.approval === true ||
        (r.asker_ref === userId && !!r.agent_key && waiting.has(r.agent_key)),
    );
  }
  if (due.length === 0) return 0;
  let ok = 0;
  for (const s of subs) {
    // Every enrolled device gets it; one device's failure never stops the others.
    let r: Awaited<ReturnType<typeof sendPush>>;
    try {
      r = await sendPush(
        env,
        s,
        pushPayload(due, prefs.lockScreenDetail, title),
        now,
      );
    } catch (e) {
      logWarn("push_send_failed", e, { subscription: s.id });
      continue;
    }
    if (r === "sent") {
      ok++;
      await stmt(
        env.DB,
        "update push_subscriptions set last_sent_at = ?1 where id = ?2",
      )
        .bind(now, s.id)
        .run();
    } else if (r === "gone" || r === "unusable")
      await stmt(env.DB, "delete from push_subscriptions where id = ?1")
        .bind(s.id)
        .run();
    else logWarn("push_send_failed", undefined, { subscription: s.id });
  }
  return ok > 0 ? 1 : 0;
}

/** A put-off item returns no later than this after its time, or its push is skipped (a long outage). */
const LATER_WINDOW_MS = 6 * 3600_000;

/** Load the original item for this recipient. A read mention or closed ask cannot return. */
async function returningItem(
  env: Env,
  row: LaterRow,
): Promise<PushItem | null> {
  const mention = row.item_id.startsWith("mention:");
  if (!mention && !row.item_id.startsWith("ask:")) return null;
  const source = await stmt(
    env.DB,
    mention
      ? `select artifact_id, thread_id, excerpt, actor from inbox_items
        where id = ?1 and user_id = ?2 and kind = 'mention' and level = 'needs_you'
          and key like 'person:%' and read_at is null`
      : `select artifact_id, thread_id, question as excerpt, asker as actor from artifact_asks
        where comment_id = ?1 and addressee = ?2 and open = 1 limit 1`,
  )
    .bind(
      row.item_id.slice(mention ? "mention:".length : "ask:".length),
      row.user_id,
    )
    .first<{
      artifact_id: string;
      thread_id: string | null;
      excerpt: string | null;
      actor: string | null;
    }>();
  if (!source) return null;
  let actor: StoredActor | null = null;
  if (source.actor) {
    try {
      actor = JSON.parse(source.actor) as StoredActor;
    } catch {
      /* old rows may have no actor */
    }
  }
  return {
    kind: "later",
    key: `later:${row.item_id}:${row.until}`,
    artifactId: source.artifact_id,
    threadId: source.thread_id ?? "",
    askerName: actor?.agent?.name ?? actor?.name ?? "Someone",
    excerpt: source.excerpt ?? "",
    askerRef: !mention && actor?.agent ? actor.ref : null,
    agentKey: mention ? null : (actor?.agent?.identity?.identityId ?? null),
  };
}

/** Mark each due return in the same transaction that queues it. A failed write can retry on the next tick. */
export async function queueLaterReturns(env: Env, now: number): Promise<void> {
  try {
    const { results } = await stmt(
      env.DB,
      `select user_id, item_id, until from inbox_later
        where pushed_at is null and until <= ?1 and until > ?2 order by until limit 50`,
    )
      .bind(now, now - LATER_WINDOW_MS)
      .all<LaterRow>();
    for (const row of results) {
      const finish = stmt(
        env.DB,
        `update inbox_later set pushed_at = ?1 where user_id = ?2 and item_id = ?3 and until = ?4 and pushed_at is null`,
      ).bind(now, row.user_id, row.item_id, row.until);
      const item = await returningItem(env, row);
      const [to] = item ? await recipients(env, [row.user_id]) : [];
      if (item && to) {
        // The insert also checks pushed_at, so a second tick cannot queue an already delivered return.
        const insert = await pendingInsert(env, to, item, now, row);
        await env.DB.batch([insert, finish]);
      } else {
        await finish.run();
      }
    }
  } catch (e) {
    logWarn("push_later_failed", e);
  }
}

/**
 * A person @mentioned the member (#2770): a Needs-you push, like an ask. The
 * same send-time checks (the item still exists, the page is still readable),
 * mutes (the page only: the mentioner is a person), quiet hours, bundling and
 * lock-screen detail. Stored as an "ask" row with the item's own key.
 */
export const queueMentionPush = (
  env: Env,
  userId: string,
  item: Omit<PushItem, "kind" | "askerRef" | "agentKey">,
  now = Date.now(),
): Promise<void> =>
  queuePush(
    env,
    [userId],
    { ...item, kind: "ask", askerRef: null, agentKey: null },
    now,
  );
