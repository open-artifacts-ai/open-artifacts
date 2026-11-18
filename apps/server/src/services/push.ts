// #2512 S5: browser push for what needs a member. Subscriptions are one row per
// browser; an endpoint belongs to one member at a time. A new Needs-you item (or
// one back from Later) is queued per member who turned it on and has a browser,
// and the cron tick sends what is due: held for the 10-minute bundle and for
// quiet hours, one notification for everything due. The text is written here
// and never taken from a client: by default only "An agent is waiting for your
// answer"; the asker and the question show only with lockScreenDetail.
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
    "select id, label, created_at, last_sent_at, needs_you, updates from push_subscriptions where user_id = ?1 order by created_at, id",
  )
    .bind(userId)
    .all<{
      id: string;
      label: string | null;
      created_at: number;
      last_sent_at: number | null;
      needs_you: number;
      updates: number;
    }>();
  return {
    items: results.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: new Date(r.created_at).toISOString(),
      lastSentAt: r.last_sent_at
        ? new Date(r.last_sent_at).toISOString()
        : null,
      needsYou: r.needs_you === 1,
      updates: r.updates === 1,
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
  // A new browser starts with Needs-you on and Updates as the member's default.
  const updatesDefault = (await getPrefs(env, userId)).updates.browser ? 1 : 0;
  const [, , row] = await env.DB.batch([
    // Axe 1: gone from anyone else.
    stmt(
      env.DB,
      "delete from push_subscriptions where endpoint = ?1 and user_id <> ?2",
    ).bind(body.endpoint, userId),
    stmt(
      env.DB,
      `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, label, needs_you, updates, created_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, 1, ?8, ?7)
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
      updatesDefault,
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

/** Sets this browser's switches; null when the subscription isn't the member's. */
export async function patchSubscription(
  env: Env,
  userId: string,
  id: string,
  body: PushSubscriptionPatchBody,
): Promise<{ needsYou: boolean; updates: boolean } | null> {
  const r = await stmt(
    env.DB,
    `update push_subscriptions
        set needs_you = coalesce(?3, needs_you), updates = coalesce(?4, updates)
      where id = ?1 and user_id = ?2
      returning needs_you, updates`,
  )
    .bind(
      id,
      userId,
      body.needsYou === undefined ? null : body.needsYou ? 1 : 0,
      body.updates === undefined ? null : body.updates ? 1 : 0,
    )
    .first<{ needs_you: number; updates: number }>();
  return r ? { needsYou: r.needs_you === 1, updates: r.updates === 1 } : null;
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
  /** One row per (member, key): "ask:<comment id>", "later:<item id>". */
  key: string;
  /** "ask" and "later" (back from Later) are Needs-you; "update" is an Update. */
  kind: "ask" | "later" | "update";
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

/**
 * Queues `item` for each of `userIds` who turned browser notifications on and
 * has a browser. Held for the bundle (a push in the last 10 minutes, or items
 * already waiting, set the time) and for quiet hours. Best effort: never throws.
 */
export async function queuePush(
  env: Env,
  userIds: string[],
  item: PushItem,
  now = Date.now(),
): Promise<void> {
  if (!pushOn(env) || userIds.length === 0) return;
  // Needs-you and Updates have their own member-wide switch and their own
  // switch on each browser (constants, never client text).
  const prefCol =
    item.kind === "update" ? "updates_browser" : "needs_you_browser";
  const subCol = item.kind === "update" ? "updates" : "needs_you";
  try {
    for (let i = 0; i < userIds.length; i += IN_CHUNK) {
      const chunk = userIds.slice(i, i + IN_CHUNK);
      const marks = chunk.map((_, j) => `?${j + 1}`).join(",");
      const { results } = await env.DB.prepare(
        `select p.user_id as id,
           (select max(send_after) from push_pending q where q.user_id = p.user_id) as waiting,
           (select max(last_sent_at) from push_subscriptions s where s.user_id = p.user_id) as last
         from notification_prefs p
         where p.${prefCol} = 1 and p.user_id in (${marks})
           and exists (select 1 from push_subscriptions s where s.user_id = p.user_id and s.${subCol} = 1)`,
      )
        .bind(...chunk)
        .all<{ id: string; waiting: number | null; last: number | null }>();
      for (const r of results) {
        const base =
          r.waiting ??
          (r.last !== null && now - r.last < BUNDLE_MS
            ? r.last + BUNDLE_MS
            : now);
        const q = quietState(await getPrefs(env, r.id), now);
        const sendAfter = q.quiet ? Math.max(base, q.until) : base;
        await stmt(
          env.DB,
          `insert into push_pending
             (id, user_id, key, kind, artifact_id, thread_id, asker_name, excerpt, asker_ref, agent_key, send_after, created_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           on conflict (user_id, key) do nothing`,
        )
          .bind(
            newId(),
            r.id,
            item.key,
            item.kind,
            item.artifactId,
            item.threadId,
            stripNameControls(item.askerName).slice(0, 80),
            itemExcerpt(item.excerpt),
            item.askerRef ?? null,
            item.agentKey ?? null,
            sendAfter,
            now,
          )
          .run();
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
  kind: "ask" | "later" | "update";
  artifact_id: string;
  thread_id: string;
  asker_name: string;
  excerpt: string;
  asker_ref: string | null;
  agent_key: string | null;
  created_at: number;
};

type Sub = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  needs_you: number;
  updates: number;
};

export const DEFAULT_UPDATE_BODY = "You have a new update";

/**
 * The one notification for everything due to one browser: fixed text, a link
 * to the latest Needs-you item (else the latest update). Needs-you text wins
 * when both are in it; the count is everything in it.
 */
export function pushPayload(
  items: Pick<
    Pending,
    "kind" | "artifact_id" | "thread_id" | "asker_name" | "excerpt"
  >[],
  detail: boolean,
  title: string,
): PushPayload {
  const needs = items.filter((i) => i.kind !== "update");
  const n = items.length;
  const lead = (needs.length > 0 ? needs : items)[
    (needs.length > 0 ? needs : items).length - 1
  ] as (typeof items)[number];
  let body: string;
  if (needs.length > 0) {
    const m = needs.length;
    const asks = detail ? `${lead.asker_name} asks: ${lead.excerpt}` : "";
    body =
      m === 1
        ? detail
          ? asks
          : DEFAULT_BODY
        : detail
          ? `${m} asks are waiting for you. Latest: ${asks}`
          : `${m} things are waiting for your answer`;
  } else {
    const what = detail ? `${lead.asker_name}: ${lead.excerpt}` : "";
    body =
      n === 1
        ? detail
          ? what
          : DEFAULT_UPDATE_BODY
        : detail
          ? `${n} new updates. Latest: ${what}`
          : `${n} new updates`;
  }
  return {
    v: 1,
    title,
    body: [...body].slice(0, 200).join(""),
    href: lead.thread_id
      ? `${viewerPath(lead.artifact_id)}?thread=${encodeURIComponent(lead.thread_id)}`
      : viewerPath(lead.artifact_id),
    tag: needs.length > 0 ? "needs-you" : "updates",
    ...(n > 1 ? { count: n } : {}),
  };
}

/**
 * Sends what is due (the cron tick; one read when nothing is). Per member: off
 * or no browser drops their rows; quiet hours hold them to when quiet ends;
 * otherwise their rows are claimed (deleted), filtered to the asks they asked
 * to be interrupted for, and sent as one notification to each browser. A 404
 * or 410 removes the browser; other failures are logged and dropped. Never
 * throws. Resolves to the notifications sent.
 */
export async function drainPush(env: Env, now = Date.now()): Promise<number> {
  if (!pushOn(env)) return 0;
  let sent = 0;
  try {
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
 * member can still read the page, the ask is still open for them, the update's
 * item still exists, and the words are the current ones (an edited comment or
 * question), never the words queued. Rows that fail any are dropped.
 */
async function stillWanted(
  env: Env,
  userId: string,
  rows: Pending[],
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
  const asks = kept.filter((r) => r.kind === "ask");
  const updates = kept.filter((r) => r.kind === "update");
  const open = new Map<string, string>();
  if (asks.length > 0) {
    const { results } = await stmt(
      env.DB,
      `select comment_id, question from artifact_asks
        where addressee = ?1 and open = 1 and comment_id in (select value from json_each(?2))`,
    )
      .bind(userId, JSON.stringify(asks.map((r) => r.key.slice(4))))
      .all<{ comment_id: string; question: string | null }>();
    for (const r of results) open.set(`ask:${r.comment_id}`, r.question ?? "");
  }
  const items = new Map<string, string>();
  if (updates.length > 0) {
    const { results } = await stmt(
      env.DB,
      `select key, excerpt from inbox_items
        where user_id = ?1 and key in (select value from json_each(?2))`,
    )
      .bind(userId, JSON.stringify(updates.map((r) => r.key)))
      .all<{ key: string; excerpt: string }>();
    for (const r of results) items.set(r.key, r.excerpt);
  }
  const out: Pending[] = [];
  for (const r of kept) {
    if (r.kind === "ask") {
      const q = open.get(r.key);
      if (q === undefined) continue;
      out.push({ ...r, excerpt: q ? itemExcerpt(q) : r.excerpt });
    } else if (r.kind === "update") {
      const e = items.get(r.key);
      if (e === undefined) continue;
      out.push({ ...r, excerpt: e });
    } else out.push(r);
  }
  return out;
}

async function drainMember(
  env: Env,
  userId: string,
  rows: Pending[],
  title: string,
  now: number,
): Promise<number> {
  const prefs = await getPrefs(env, userId);
  // Each level has its member-wide switch: off drops its rows.
  const live = rows.filter((r) =>
    r.kind === "update" ? prefs.updates.browser : prefs.needsYou.browser,
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
    "select id, endpoint, p256dh, auth, needs_you, updates from push_subscriptions where user_id = ?1",
  )
    .bind(userId)
    .all<Sub>();
  // Claimed: deleted before sending, so a second tick can't send them again.
  await dropRows(env, live);
  if (subs.length === 0) return 0;
  // A mute stops push: its agent's and its page's items are not sent.
  const muted = await mutedSet(env, userId);
  let due = live.filter(
    (r) =>
      !muted.pages.has(r.artifact_id) &&
      !(r.agent_key && muted.agents.has(r.agent_key)),
  );
  due = await stillWanted(env, userId, due);
  if (due.length === 0) return 0;
  if (!prefs.browserAllAsks) {
    // "Asks waiting for you": an ask counts only when an agent of theirs waits on them.
    const asks = due.filter((r) => r.kind === "ask");
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
        (r.asker_ref === userId && !!r.agent_key && waiting.has(r.agent_key)),
    );
  }
  if (due.length === 0) return 0;
  let ok = 0;
  for (const s of subs) {
    // This browser's own switches.
    const mine = due.filter((r) =>
      r.kind === "update" ? s.updates === 1 : s.needs_you === 1,
    );
    if (mine.length === 0) continue;
    // One browser's failure never stops the member's others.
    let r: Awaited<ReturnType<typeof sendPush>>;
    try {
      r = await sendPush(
        env,
        s,
        pushPayload(mine, prefs.lockScreenDetail, title),
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

/**
 * An item that was put off with Later is back (#2762): queue it for push like
 * a new ask, so the person hears it came back. `key` is unique per return.
 */
export const queueBackFromLater = (
  env: Env,
  userId: string,
  item: Omit<PushItem, "kind">,
  now = Date.now(),
): Promise<void> => queuePush(env, [userId], { ...item, kind: "later" }, now);

/** The Updates written for a person: queued for push to those who turned it on. */
export const queueUpdatePush = (
  env: Env,
  userId: string,
  item: Omit<PushItem, "kind">,
  now = Date.now(),
): Promise<void> => queuePush(env, [userId], { ...item, kind: "update" }, now);
