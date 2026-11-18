import {
  ALLOW_ITEMS_MAX,
  type AllowBody,
  type AllowResult,
  type AskHistory,
  type AskHistoryRow,
  type AskOutcome,
  HELD_LAPSE_MS,
  HELD_QUIET_MS,
  type HeldItem,
  type HeldList,
  type HeldRequest,
  type HeldWay,
  LISTEN_MAX_MS,
  LISTEN_PAGE_MS,
  type ListenAddBody,
  type ListenAddResult,
  type ListenEntry,
  type ListensList,
  newId,
} from "@oa/shared";
import {
  accessLevel,
  type Caller,
  callerOf,
  capOfCaller,
  meetsLevel,
} from "../auth/authz.js";
import { isGuestRole } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError, logInfo, logWarn } from "../log.js";
import type { HeldAgent } from "../runtime/comments-store.js";
import { runtimeCall, runtimeStub } from "../runtime/do.js";
import { sha256Hex } from "../util/crypto.js";
import { publicName } from "./agent-display.js";
import { askInfo } from "./asks.js";
import { audit, userActor } from "./audit.js";
import { type CommentNoticeKind, notifyAgent } from "./comment-agents.js";
import { itemExcerpt } from "./inbox-items.js";
import {
  giveBackReceiverSlot,
  isOutsideMember,
  takeReceiverSlot,
} from "./mention-guards.js";
import { hasPasskey, listenChallenge, verifyListen } from "./passkeys.js";
import { getUser, personName } from "./users.js";

// #2577: asking someone else's agent. The comment posts; its delivery to the
// receiver's agents is held until the receiver allows it (or the sender is on
// their "listens to" list). The DO holds the facts (the held targets and the
// words); D1 keeps ids, counts and times, never the words.

/** Most held items one receiver may have, and from one sender. Past it the target stays held (masked) with no row. */
export const HELD_PER_RECEIVER_MAX = 200;
export const HELD_PER_PAIR_MAX = 50;

const stub = (env: Env, artifactId: string) => runtimeStub(env, artifactId);
const call = runtimeCall;

/** The page is open to guests or to anyone with the link: a "listens to" entry never applies there. */
export async function pageIsOpen(
  env: Env,
  artifactId: string,
): Promise<boolean> {
  const a = await stmt(env.DB, "select visibility from artifacts where id = ?1")
    .bind(artifactId)
    .first<{ visibility: string }>();
  if (!a || a.visibility === "public") return true;
  const g = await stmt(
    env.DB,
    `select 1 as x from shares s join users u on lower(u.email) = lower(s.email)
     where s.artifact_id = ?1 and u.role = 'guest' limit 1`,
  )
    .bind(artifactId)
    .first();
  if (g) return true;
  return spaceHasGuest(env, artifactId);
}

/** A guest-role member of the page's space reaches the page through the space. */
async function spaceHasGuest(env: Env, artifactId: string): Promise<boolean> {
  return !!(await stmt(
    env.DB,
    `select 1 as x from artifacts a join space_members sm on sm.space_id = a.space_id
       join users u on u.id = sm.user_id
      where a.id = ?1 and u.role = 'guest' limit 1`,
  )
    .bind(artifactId)
    .first());
}

/** Whether the receiver can still open the page (a removed share or a revoked space seat ends it): their held requests there are theirs no longer to answer. */
export async function receiverCanOpen(
  env: Env,
  caller: Caller | string,
  artifactId: string,
): Promise<boolean> {
  let c: Caller;
  if (typeof caller === "string") {
    const u = await getUser(env, caller);
    if (!u) return false;
    c = callerOf(u);
  } else c = caller;
  return !!(await accessLevel(env, c, artifactId));
}

/** The shared space a page is in now, if any (a personal space is not offered: it is one person's). */
export async function spaceOf(
  env: Env,
  artifactId: string,
): Promise<{ id: string; name: string } | null> {
  return stmt(
    env.DB,
    `select s.id as id, s.name as name from artifacts a join spaces s on s.id = a.space_id
      where a.id = ?1 and s.kind = 'shared' and s.deleted_at is null`,
  )
    .bind(artifactId)
    .first<{ id: string; name: string }>();
}

/** The page's shared space and how many of its pages a space-level allow by `receiverId` covers today. */
export async function spaceWithCover(
  env: Env,
  receiverId: string,
  artifactId: string,
): Promise<{ id: string; name: string; pagesCovered: number } | null> {
  const sp = await spaceOf(env, artifactId);
  if (!sp) return null;
  // A guest in the space reaches every page in it: the list covers none.
  if (await pageIsOpen(env, artifactId)) return { ...sp, pagesCovered: 0 };
  const n = await stmt(
    env.DB,
    `select count(*) as n from artifacts a
      where a.space_id = ?1 and a.deleted_at is null and a.visibility != 'public'
        and not exists (select 1 from shares s join users u on lower(u.email) = lower(s.email)
                         where s.artifact_id = a.id and u.role = 'guest')
        and exists (select 1 from versions v where v.artifact_id = a.id and v.created_by = ?2
                    and (v.agent_name is not null or v.agent_via is not null))`,
  )
    .bind(sp.id, receiverId)
    .first<{ n: number }>();
  return { ...sp, pagesCovered: n?.n ?? 0 };
}

/**
 * #2577: a space-level entry covers a page only where the receiver's own agent
 * already works by the receiver's doing: the page is in that shared space now,
 * and the receiver published a version of it through an agent. A page the
 * sender created or moved in, or where the agent was only mentioned, is not
 * covered. Needs ?1 (the receiver) and ?4 (the page); `space_id` is the entry's.
 */
const SPACE_COVERS = `exists (select 1 from spaces sp where sp.id = space_id and sp.kind = 'shared' and sp.deleted_at is null)
  and exists (select 1 from versions v where v.artifact_id = ?4 and v.created_by = ?1
              and (v.agent_name is not null or v.agent_via is not null))`;

/**
 * Whether the receiver's list takes the sender's request here, right now. The
 * row is never trusted alone: the entry must be live, the member still on the
 * team, still able to edit this page, and the page not open to guests or to
 * anyone with the link; a space entry also needs the page to be in that space now.
 */
export async function listensTo(
  env: Env,
  receiverId: string,
  senderId: string,
  artifactId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await stmt(
    env.DB,
    `select id from agent_listens where owner_id = ?1 and member_id = ?2 and removed_at is null
       and until > ?3 and (scope = 'all' or artifact_id = ?4
         or (scope = 'space' and space_id is not null
             and space_id = (select space_id from artifacts where id = ?4)
             and ${SPACE_COVERS}
         )) limit 1`,
  )
    .bind(receiverId, senderId, now, artifactId)
    .first();
  if (!row) return false;
  const sender = await getUser(env, senderId);
  if (!sender || (await isOutsideMember(env, senderId))) return false;
  const acc = await accessLevel(env, callerOf(sender), artifactId);
  if (!acc || !meetsLevel(acc.level, "editor")) return false;
  return !(await pageIsOpen(env, artifactId));
}

/**
 * Another person's agent is asked by `senderId`: deliver now (they are on the
 * list), hold it for their person, or "off": their switch is off (#2577 S2),
 * so their agents hear nobody outside and nothing is held. Never called for
 * the person's own agents.
 */
export async function decide(
  env: Env,
  senderId: string,
  receiverId: string,
  artifactId: string,
): Promise<"deliver" | "hold" | "off"> {
  if (!(await agentRequestsOn(env, receiverId))) return "off";
  return (await listensTo(env, receiverId, senderId, artifactId))
    ? "deliver"
    : "hold";
}

/** The refusal text when a mention or ask names an agent whose person has the switch off. */
export async function onlyAnswers(
  env: Env,
  receiverId: string,
): Promise<string> {
  // The owner's public name, as an agent's `for` shows it: never an email.
  const u = await getUser(env, receiverId);
  return `Only answers ${(u && publicName(u)) ?? "its owner"}`;
}

/** Whether the member's agents take requests from other people (held or listed). Default on. */
export async function agentRequestsOn(
  env: Env,
  userId: string,
): Promise<boolean> {
  const r = await stmt(
    env.DB,
    "select agent_requests_off as off from notification_prefs where user_id = ?1",
  )
    .bind(userId)
    .first<{ off: number }>();
  return !r || r.off !== 1;
}

/**
 * The member's switch. Turning it off leaves what is held, and what was
 * allowed, as it is; the gate just stops holding and refuses new mentions.
 * Audited as agent_requests.switch; an unchanged save writes nothing.
 */
export async function setAgentRequests(
  env: Env,
  userId: string,
  on: boolean,
  now = Date.now(),
): Promise<boolean> {
  if ((await agentRequestsOn(env, userId)) === on) return on;
  await env.DB.batch([
    stmt(
      env.DB,
      `insert into notification_prefs (user_id, agent_requests_off, updated_at)
       values (?1, ?2, ?3)
       on conflict (user_id) do update set agent_requests_off = excluded.agent_requests_off, updated_at = excluded.updated_at`,
    ).bind(userId, on ? 0 : 1, now),
    audit(
      env,
      "agent_requests.switch",
      { type: "user", id: userId },
      userActor(userId),
      { detail: { on } },
    ),
  ]);
  return on;
}

type ListenRow = {
  id: string;
  member_id: string;
  scope: "page" | "space" | "all";
  artifact_id: string | null;
  space_id: string | null;
  until: number;
  created_at: number;
};

/** The member's live "listens to" entries (not removed, not ended), newest first, with who and where by name. */
export async function listListens(
  env: Env,
  ownerId: string,
  now = Date.now(),
): Promise<ListensList> {
  const { results } = await stmt(
    env.DB,
    `select id, member_id, scope, artifact_id, space_id, until, created_at from agent_listens
      where owner_id = ?1 and removed_at is null and until > ?2
      order by created_at desc, id limit 500`,
  )
    .bind(ownerId, now)
    .all<ListenRow>();
  const entries: ListenEntry[] = [];
  for (const r of results) {
    // The held list's form: the name, else the email's local part, else "Someone".
    const m = await stmt(
      env.DB,
      "select id, name, display_name as displayName, email from users where id = ?1",
    )
      .bind(r.member_id)
      .first<{
        id: string;
        name: string | null;
        displayName: string | null;
        email: string;
      }>();
    if (!m) continue;
    const art = r.artifact_id
      ? await stmt(env.DB, "select id, title from artifacts where id = ?1")
          .bind(r.artifact_id)
          .first<{ id: string; title: string }>()
      : null;
    const sp = r.space_id
      ? await stmt(env.DB, "select id, name from spaces where id = ?1")
          .bind(r.space_id)
          .first<{ id: string; name: string }>()
      : null;
    entries.push({
      id: r.id,
      member: {
        id: m.id,
        name: personName(m),
      },
      scope: r.scope,
      artifact: art ?? null,
      space: sp ?? null,
      until: r.until,
      createdAt: r.created_at,
    });
  }
  return { entries };
}

const NO_LISTEN = "No such entry";

async function ownEntry(
  env: Env,
  ownerId: string,
  id: string,
  now: number,
): Promise<ListenRow> {
  const r = await stmt(
    env.DB,
    `select id, member_id, scope, artifact_id, space_id, until, created_at from agent_listens
      where id = ?1 and owner_id = ?2 and removed_at is null and until > ?3`,
  )
    .bind(id, ownerId, now)
    .first<ListenRow>();
  if (!r) throw new ApiError("not_found", NO_LISTEN);
  return r;
}

/**
 * Removes one entry. Future requests from that person are held again; what was
 * delivered stays delivered and what is held stays held. Audited as
 * agent_listens.remove (the entry's person as the target).
 */
export async function removeListen(
  env: Env,
  ownerId: string,
  id: string,
  now = Date.now(),
): Promise<void> {
  const r = await ownEntry(env, ownerId, id, now);
  await env.DB.batch([
    stmt(
      env.DB,
      "update agent_listens set removed_at = ?1 where id = ?2 and owner_id = ?3 and removed_at is null",
    ).bind(now, id, ownerId),
    audit(
      env,
      "agent_listens.remove",
      { type: "user", id: r.member_id },
      userActor(ownerId),
      {
        detail: {
          level: r.scope,
          until: r.until,
          ...(r.artifact_id ? { artifactId: r.artifact_id } : {}),
        },
      },
    ),
  ]);
}

/**
 * Ends one entry sooner: `until` must be after now and before the current end
 * (a longer one is a new allow, with its own passkey). Audited as
 * agent_listens.shorten with the old and new end.
 */
export async function shortenListen(
  env: Env,
  ownerId: string,
  id: string,
  until: number,
  now = Date.now(),
): Promise<ListenEntry> {
  const r = await ownEntry(env, ownerId, id, now);
  if (until <= now || until >= r.until)
    throw new ApiError(
      "bad_request",
      "Pick a time after now and before the entry's end",
      { path: "until", reason: "range" },
    );
  await env.DB.batch([
    stmt(
      env.DB,
      "update agent_listens set until = ?1 where id = ?2 and owner_id = ?3 and removed_at is null and until > ?1",
    ).bind(until, id, ownerId),
    audit(
      env,
      "agent_listens.shorten",
      { type: "user", id: r.member_id },
      userActor(ownerId),
      {
        detail: {
          level: r.scope,
          from: r.until,
          until,
          ...(r.artifact_id ? { artifactId: r.artifact_id } : {}),
        },
      },
    ),
  ]);
  const e = (await listListens(env, ownerId, now)).entries.find(
    (x) => x.id === id,
  );
  if (!e) throw new ApiError("not_found", NO_LISTEN);
  return e;
}

/**
 * After an edit of a comment's words: a request already allowed on it goes
 * back to held (the DO target did so in the edit's own transaction), so its
 * person reads the new words and allows them again. Held ones need nothing
 * here: the words and their hash are read from the DO each time. Never throws.
 */
export async function heldAfterEdit(
  env: Env,
  artifactId: string,
  commentId: string,
  now = Date.now(),
): Promise<void> {
  try {
    const { results } = await stmt(
      env.DB,
      `select i.id as id, i.thread_id as thread_id, i.agent_key as agent_key, r.id as request_id, r.receiver_id as receiver_id
         from held_request_items i join held_requests r on r.id = i.request_id
        where i.comment_id = ?1 and i.state = 'allowed'`,
    )
      .bind(commentId)
      .all<{
        id: string;
        thread_id: string;
        agent_key: string;
        request_id: string;
        receiver_id: string;
      }>();
    for (const it of results) {
      const info = await call(() =>
        stub(env, artifactId).commentsHeldCanon({
          threadId: it.thread_id,
          commentId,
          owner: it.receiver_id,
        }),
      );
      if (!info?.held.some((h) => h.key === it.agent_key && h.state === "held"))
        continue;
      await env.DB.batch([
        stmt(
          env.DB,
          "update held_request_items set state = 'held', expires_at = ?1 where id = ?2 and state = 'allowed'",
        ).bind(now + HELD_LAPSE_MS, it.id),
        stmt(
          env.DB,
          "update held_requests set last_at = ?1 where id = ?2",
        ).bind(now, it.request_id),
      ]);
    }
  } catch (e) {
    logWarn("held_after_edit_failed", e, { artifactId });
  }
}

/**
 * The D1 side of a hold: one request row per (receiver, sender, page) and an
 * item per held agent. Never throws. The words are masked by the hold in the
 * DO, written with the comment, so a failure here (retried once, then logged
 * as hold_write_failed with no content) leaves the comment masked and
 * undelivered; only the receiver's list of requests to allow is missing.
 */
export async function recordHolds(
  env: Env,
  senderId: string,
  artifactId: string,
  threadId: string,
  commentId: string,
  held: { agent: HeldAgent; way: string }[],
  now = Date.now(),
): Promise<void> {
  for (let i = 0; i < 2; i++)
    if (
      await recordHoldsOnce(
        env,
        senderId,
        artifactId,
        threadId,
        commentId,
        held,
        now,
      )
    )
      return;
  logError("hold_write_failed", undefined, { artifactId });
}

/** One try at recordHolds' D1 writes; false when it threw. */
async function recordHoldsOnce(
  env: Env,
  senderId: string,
  artifactId: string,
  threadId: string,
  commentId: string,
  held: { agent: HeldAgent; way: string }[],
  now: number,
): Promise<boolean> {
  try {
    for (const owner of new Set(held.map((h) => h.agent.owner))) {
      const n = await stmt(
        env.DB,
        `select
           (select count(*) from held_request_items i join held_requests r on r.id = i.request_id
              where r.receiver_id = ?1 and i.state = 'held') as recv,
           (select count(*) from held_request_items i join held_requests r on r.id = i.request_id
              where r.receiver_id = ?1 and r.sender_id = ?2 and i.state = 'held') as pair`,
      )
        .bind(owner, senderId)
        .first<{ recv: number; pair: number }>();
      if (
        (n?.recv ?? 0) >= HELD_PER_RECEIVER_MAX ||
        (n?.pair ?? 0) >= HELD_PER_PAIR_MAX
      )
        continue;
      const known = await stmt(
        env.DB,
        "select 1 as x from held_requests where receiver_id = ?1 and sender_id = ?2 and artifact_id = ?3",
      )
        .bind(owner, senderId, artifactId)
        .first();
      await stmt(
        env.DB,
        `insert into held_requests (id, receiver_id, sender_id, artifact_id, created_at, last_at)
         values (?1, ?2, ?3, ?4, ?5, ?5)
         on conflict (receiver_id, sender_id, artifact_id) do update set last_at = ?5`,
      )
        .bind(newId(), owner, senderId, artifactId, now)
        .run();
      const req = await stmt(
        env.DB,
        "select id from held_requests where receiver_id = ?1 and sender_id = ?2 and artifact_id = ?3",
      )
        .bind(owner, senderId, artifactId)
        .first<{ id: string }>();
      if (!req) continue;
      // A new request (one per receiver, sender and page) is audited once.
      if (!known)
        await audit(
          env,
          "agent_ask.held",
          { type: "user", id: owner },
          userActor(senderId),
          { detail: { artifactId } },
        ).run();
      for (const h of held.filter((x) => x.agent.owner === owner))
        await stmt(
          env.DB,
          `insert or ignore into held_request_items (id, request_id, thread_id, comment_id, agent_key, way, state, created_at, expires_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, 'held', ?7, ?8)`,
        )
          .bind(
            newId(),
            req.id,
            threadId,
            commentId,
            h.agent.key,
            h.way,
            now,
            now + HELD_LAPSE_MS,
          )
          .run();
    }
    return true;
  } catch {
    return false;
  }
}

type Canon = [
  string,
  unknown,
  { question: string; options: string } | null,
  string[],
];
const parseCanon = (canon: string): Canon => JSON.parse(canon) as Canon;

/** The words of a held request, as the receiver sees them (current, from the DO). */
const itemOf = async (
  env: Env,
  receiverId: string,
  r: {
    artifact_id: string;
    thread_id: string;
    comment_id: string;
    agent_key: string;
    way: string;
    created_at: number;
  },
): Promise<HeldItem | null> => {
  const info = await call(() =>
    stub(env, r.artifact_id).commentsHeldCanon({
      threadId: r.thread_id,
      commentId: r.comment_id,
      owner: receiverId,
    }),
  ).catch(() => null);
  const h = info?.held.find((x) => x.key === r.agent_key);
  if (!info || !h || h.state !== "held") return null;
  const [body, , ask] = parseCanon(info.canon);
  let options: string[] = [];
  if (ask) {
    try {
      options = (JSON.parse(ask.options) as { label: string }[]).map(
        (o) => o.label,
      );
    } catch {
      options = [];
    }
  }
  return {
    commentId: r.comment_id,
    threadId: r.thread_id,
    agentKey: r.agent_key,
    agentName: h.name,
    way: r.way as HeldWay,
    body,
    ...(ask ? { ask: { question: ask.question, options } } : {}),
    wordsHash: await sha256Hex(info.canon),
    createdAt: r.created_at,
  };
};

type ItemRow = {
  id: string;
  request_id: string;
  thread_id: string;
  comment_id: string;
  agent_key: string;
  way: string;
  created_at: number;
  artifact_id: string;
};

/** The requests held for `receiverId`: who asked, on which page, and every held comment in full. */
export async function listHeld(
  env: Env,
  receiverId: string,
  now = Date.now(),
): Promise<HeldList> {
  const { results: reqs } = await stmt(
    env.DB,
    `select r.id, r.sender_id, r.artifact_id, r.created_at, r.last_at, r.quiet_until,
            a.title as title, u.name as sender_name, u.display_name as sender_display, u.email as sender_email
       from held_requests r
       join artifacts a on a.id = r.artifact_id and a.deleted_at is null
       join users u on u.id = r.sender_id
      where r.receiver_id = ?1
        and exists (select 1 from held_request_items i where i.request_id = r.id and i.state = 'held' and i.expires_at > ?2)
      order by r.last_at desc limit 100`,
  )
    .bind(receiverId, now)
    .all<{
      id: string;
      sender_id: string;
      artifact_id: string;
      created_at: number;
      last_at: number;
      quiet_until: number | null;
      title: string;
      sender_name: string | null;
      sender_display: string | null;
      sender_email: string;
    }>();
  const out: HeldRequest[] = [];
  const me = await getUser(env, receiverId);
  const caller = me ? callerOf(me) : null;
  for (const r of reqs) {
    // A page the receiver can no longer open is not theirs to answer.
    if (!caller || !(await receiverCanOpen(env, caller, r.artifact_id)))
      continue;
    const { results: rows } = await stmt(
      env.DB,
      `select id, request_id, thread_id, comment_id, agent_key, way, created_at from held_request_items
        where request_id = ?1 and state = 'held' and expires_at > ?2 order by created_at`,
    )
      .bind(r.id, now)
      .all<Omit<ItemRow, "artifact_id">>();
    const items: HeldItem[] = [];
    for (const row of rows) {
      const it = await itemOf(env, receiverId, {
        ...row,
        artifact_id: r.artifact_id,
      } as ItemRow);
      if (it) items.push(it);
      else
        await stmt(
          env.DB,
          "update held_request_items set state = 'withdrawn' where id = ?1 and state = 'held'",
        )
          .bind(row.id)
          .run()
          .catch(() => undefined);
    }
    if (items.length === 0) continue;
    out.push({
      id: r.id,
      sender: {
        id: r.sender_id,
        name: personName({
          name: r.sender_name,
          displayName: r.sender_display,
          email: r.sender_email,
        }),
      },
      artifact: { id: r.artifact_id, title: r.title },
      items,
      since: r.created_at,
      lastAt: r.last_at,
      quietUntil: r.quiet_until,
      open: await pageIsOpen(env, r.artifact_id),
      space: await spaceWithCover(env, receiverId, r.artifact_id),
    });
  }
  return { requests: out };
}

const KIND: Record<string, CommentNoticeKind> = {
  mention: "mention",
  page: "mention",
  ask: "ask",
  reply: "thread_reply",
};

/** The binding of a passkey prompt for a "listens to" entry. */
export const listenBinding = (
  level: "page" | "space" | "all",
  until: number,
  /** A space-level binding names its space: an assertion for one space is no use for another. */
  spaceId?: string,
) =>
  level === "space" ? `space:${spaceId ?? ""}:${until}` : `${level}:${until}`;

/** The 404 text of a request that is not the caller's (the authz matrix tells it from a capped caller's plain 404). */
export const NO_HELD = "No such held request";

async function requestOf(env: Env, receiverId: string, id: string) {
  const r = await stmt(
    env.DB,
    "select id, sender_id, artifact_id from held_requests where id = ?1 and receiver_id = ?2",
  )
    .bind(id, receiverId)
    .first<{ id: string; sender_id: string; artifact_id: string }>();
  if (!r) throw new ApiError("not_found", NO_HELD);
  return r;
}

/** The passkey prompt for adding the sender to the list for all pages until `until` (ms). */
export async function allowChallenge(
  env: Env,
  receiverId: string,
  requestId: string,
  until: number,
  level: "space" | "all" = "all",
  now = Date.now(),
) {
  const r = await requestOf(env, receiverId, requestId);
  if (until <= now || until > now + LISTEN_MAX_MS)
    throw new ApiError("bad_request", "`until` is at most a year from now");
  let spaceId: string | undefined;
  if (level === "space") {
    const sp = await spaceOf(env, r.artifact_id);
    if (!sp)
      throw new ApiError("bad_request", "This page is not in a shared space");
    spaceId = sp.id;
  }
  return listenChallenge(
    env,
    receiverId,
    r.sender_id,
    listenBinding(level, until, spaceId),
    now,
  );
}

/** "Not now": that sender's requests stay quiet for a day; they stay held and the asker sees nothing different. */
export async function notNow(
  env: Env,
  receiverId: string,
  requestId: string,
  now = Date.now(),
): Promise<void> {
  const r = await requestOf(env, receiverId, requestId);
  await env.DB.batch([
    stmt(
      env.DB,
      "update held_requests set quiet_until = ?1 where id = ?2",
    ).bind(now + HELD_QUIET_MS, requestId),
    audit(
      env,
      "agent_ask.not_now",
      { type: "user", id: r.sender_id },
      userActor(receiverId),
      { detail: { artifactId: r.artifact_id } },
    ),
  ]);
}

/**
 * Allow: passes exactly the listed held comments, at exactly the words shown, to
 * the receiver's agents; "page" and "all" also add a "listens to" entry. Only a
 * browser session of the receiver reaches this (the route refuses the rest).
 * The words are checked inside the DO in the same transaction that releases
 * them, so an edit after the notice is never delivered.
 */
export async function allow(
  env: Env,
  receiverId: string,
  requestId: string,
  body: AllowBody,
  now = Date.now(),
): Promise<AllowResult> {
  const req = await requestOf(env, receiverId, requestId);
  // How wide the allow is (a grant's reach, not an access level).
  const grant = body.level;
  // The receiver must still be able to open the page: else the request is
  // not theirs to answer, and what was held for them is withdrawn.
  if (!(await receiverCanOpen(env, receiverId, req.artifact_id))) {
    await stmt(
      env.DB,
      "update held_request_items set state = 'withdrawn' where request_id = ?1 and state = 'held'",
    )
      .bind(requestId)
      .run();
    throw new ApiError("not_found", NO_HELD);
  }
  const open = await pageIsOpen(env, req.artifact_id);
  if (grant === "page" && open)
    throw new ApiError(
      "bad_request",
      "The list does not apply on a page open to guests or to anyone with the link: allow once",
    );
  let until = 0;
  let space: { id: string; name: string } | null = null;
  if (grant === "page") until = now + LISTEN_PAGE_MS;
  if (grant === "space") {
    space = await spaceOf(env, req.artifact_id);
    if (!space)
      throw new ApiError("bad_request", "This page is not in a shared space");
    if (open)
      throw new ApiError(
        "bad_request",
        "The list does not apply on a page open to guests or to anyone with the link: allow once",
      );
  }
  if (grant === "space" || grant === "all") {
    until = body.until ?? 0;
    if (until <= now || until > now + LISTEN_MAX_MS)
      throw new ApiError("bad_request", "`until` is at most a year from now");
  }
  // Once and this page need no passkey. All pages and a whole space do, and a
  // member without a usable passkey cannot make them at all (409 no_passkey).
  if (grant === "all" || grant === "space") {
    if (!(await hasPasskey(env, receiverId, now)))
      throw new ApiError("no_passkey", "Add a passkey in your settings first");
    if (!body.assertion)
      throw new ApiError("passkey_required", "This needs your passkey");
    await verifyListen(
      env,
      receiverId,
      req.sender_id,
      listenBinding(grant, until, space?.id),
      body.assertion,
      now,
    );
  }
  const wanted = new Map(body.items.map((i) => [i.commentId, i.wordsHash]));
  const { results: rows } = await stmt(
    env.DB,
    `select id, request_id, thread_id, comment_id, agent_key, way, created_at from held_request_items
      where request_id = ?1 and state in ('held', 'allowed')
        and comment_id in (select value from json_each(?2))`,
  )
    .bind(requestId, JSON.stringify([...wanted.keys()]))
    .all<Omit<ItemRow, "artifact_id">>();
  const result: AllowResult = { sent: 0, changed: 0, waiting: 0 };
  const art = await stmt(
    env.DB,
    "select current_version as v from artifacts where id = ?1",
  )
    .bind(req.artifact_id)
    .first<{ v: number }>();
  const version = Math.max(1, art?.v ?? 1);
  // One DO call per comment, whatever its agents: the held rows of this owner on it.
  const done = new Set<string>();
  for (const row of rows) {
    if (done.has(row.comment_id)) continue;
    done.add(row.comment_id);
    const info = await call(() =>
      stub(env, req.artifact_id).commentsHeldCanon({
        threadId: row.thread_id,
        commentId: row.comment_id,
        owner: receiverId,
      }),
    ).catch(() => null);
    // Rows already allowed are done (an edit sends them back to held).
    const live = info?.held.filter(
      (h) => h.state === "held" || h.state === "releasing",
    );
    if (!info || !live || live.length === 0) {
      result.changed++;
      await stmt(
        env.DB,
        "update held_request_items set state = 'withdrawn' where comment_id = ?1 and request_id = ?2 and state = 'held'",
      )
        .bind(row.comment_id, requestId)
        .run();
      continue;
    }
    // Resumable: targets a crashed allow left "releasing" are delivered again.
    const resuming = live.some((h) => h.state === "releasing");
    if (
      !resuming &&
      (await sha256Hex(info.canon)) !== wanted.get(row.comment_id)
    ) {
      result.changed++;
      continue;
    }
    if (!(await takeReceiverSlot(env, receiverId, now))) {
      result.waiting++;
      continue;
    }
    const rel = await call(() =>
      stub(env, req.artifact_id).commentsRelease({
        threadId: row.thread_id,
        commentId: row.comment_id,
        owner: receiverId,
        expect: info.canon,
      }),
    );
    if (!rel.ok) {
      // Nothing was delivered: the receiver's slot goes back.
      await giveBackReceiverSlot(env, receiverId, now);
      result.changed++;
      continue;
    }
    for (const h of rel.keys) {
      const kind = KIND[h.way] ?? "mention";
      await notifyAgent(
        env,
        req.artifact_id,
        version,
        row.thread_id,
        row.comment_id,
        kind,
        {
          key: h.key,
          name: h.name,
          online: false,
          userId: receiverId,
          address: { namespace: h.namespace, name: h.name },
        } as never,
        // A teammate's words, never the receiver's own (#2577).
        false,
      ).catch((e) => logInfo("held_release_notice_failed", { e: String(e) }));
    }
    await call(() =>
      stub(env, req.artifact_id).commentsFinishHeld({
        commentId: row.comment_id,
        keys: rel.keys.map((k) => k.key),
      }),
    );
    await stmt(
      env.DB,
      "update held_request_items set state = 'allowed' where comment_id = ?1 and request_id = ?2",
    )
      .bind(row.comment_id, requestId)
      .run();
    // The person's inbox items for this comment show the words they allowed.
    if (rel.comment)
      await stmt(
        env.DB,
        "update inbox_items set excerpt = ?1 where artifact_id = ?2 and comment_id = ?3 and user_id = ?4 and kind in ('mention', 'reply', 'comment')",
      )
        .bind(
          itemExcerpt(rel.comment.body),
          req.artifact_id,
          row.comment_id,
          receiverId,
        )
        .run();
    // An ask held for this person: its rows open now, with the question.
    const c = rel.comment;
    if (c?.ask)
      await openAskRow(env, req.artifact_id, row.comment_id, receiverId, c);
    result.sent += rel.keys.length;
  }
  if (grant !== "once") {
    const exists = await stmt(
      env.DB,
      `select id from agent_listens where owner_id = ?1 and member_id = ?2 and removed_at is null
         and scope = ?3 and coalesce(artifact_id, space_id, '') = ?4`,
    )
      .bind(
        receiverId,
        req.sender_id,
        grant,
        grant === "all"
          ? ""
          : grant === "space"
            ? (space?.id ?? "")
            : req.artifact_id,
      )
      .first<{ id: string }>();
    if (exists)
      await stmt(
        env.DB,
        "update agent_listens set until = max(until, ?1) where id = ?2",
      )
        .bind(until, exists.id)
        .run();
    else
      await stmt(
        env.DB,
        `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, space_id, until, created_via, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?9, ?6, ?7, ?8)`,
      )
        .bind(
          newId(),
          receiverId,
          req.sender_id,
          grant,
          grant === "page" ? req.artifact_id : null,
          until,
          grant === "all"
            ? "allow_all"
            : grant === "space"
              ? "allow_space"
              : "allow_page",
          now,
          grant === "space" ? (space?.id ?? null) : null,
        )
        .run();
    await audit(
      env,
      "agent_listens.add",
      { type: "user", id: req.sender_id },
      userActor(receiverId),
      { detail: { level: grant, until, artifactId: req.artifact_id } },
    ).run();
  }
  await audit(
    env,
    "agent_ask.allow",
    { type: "user", id: req.sender_id },
    userActor(receiverId),
    {
      detail: {
        level: grant,
        artifactId: req.artifact_id,
        sent: result.sent,
        changed: result.changed,
        waiting: result.waiting,
      },
    },
  ).run();
  return result;
}

/** Opens the artifact_asks row of an allowed ask, with its question (it was written masked). */
async function openAskRow(
  env: Env,
  artifactId: string,
  commentId: string,
  receiverId: string,
  c: Parameters<typeof askInfo>[0],
): Promise<void> {
  const i = askInfo(c);
  await stmt(
    env.DB,
    `update artifact_asks set held = 0, open = 1, question = ?1, asker = ?2, asked_at = ?3, confirm = ?4
      where artifact_id = ?5 and comment_id = ?6 and addressee = ?7 and held = 1`,
  )
    .bind(
      i.question,
      i.asker,
      i.askedAt,
      i.confirm,
      artifactId,
      commentId,
      receiverId,
    )
    .run()
    .catch((e) => logWarn("held_ask_row_failed", e, { artifactId }));
}

/** Daily cron: items past their seven days lapse (the words stay hidden from the receiver's agents), old lapsed ones go. */
export async function lapseHeld(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    stmt(
      env.DB,
      "update held_request_items set state = 'lapsed' where state = 'held' and expires_at < ?1",
    ).bind(now),
    stmt(
      env.DB,
      "delete from held_request_items where state in ('lapsed', 'withdrawn') and expires_at < ?1",
    ).bind(now - 30 * 24 * 60 * 60 * 1000),
    stmt(
      env.DB,
      "delete from held_requests where not exists (select 1 from held_request_items i where i.request_id = held_requests.id) and last_at < ?1",
    ).bind(now - 30 * 24 * 60 * 60 * 1000),
  ]);
}

export { ALLOW_ITEMS_MAX };

const DAY_MS = 24 * 60 * 60 * 1000;

/** `until` of an add: 30, 90 or 365 are days from now; anything else is an end time in ms. At most a year out, and after now. */
function addUntil(raw: number, now: number): number {
  const until = [30, 90, 365].includes(raw) ? now + raw * DAY_MS : raw;
  if (until <= now)
    throw new ApiError("bad_request", "Pick a time after now", {
      path: "until",
      reason: "range",
    });
  return Math.min(until, now + LISTEN_MAX_MS);
}

const refuse = (message: string, path = "memberId") =>
  new ApiError("bad_request", message, { path, reason: "refused" });

/**
 * #2577: adds teammates to the caller's list directly (Settings, the share
 * tick, first setup), or a batch of them. Every rule is checked for every
 * person before anything is written; one refusal refuses all. A live entry for
 * the same person and place is extended (never duplicated). No passkey.
 * Audited as agent_listens.add, one row per person.
 */
export async function addListens(
  env: Env,
  ownerId: string,
  body: ListenAddBody,
  now = Date.now(),
): Promise<ListenAddResult> {
  const owner = await getUser(env, ownerId);
  if (!owner || isGuestRole(owner.role) || capOfCaller(callerOf(owner)))
    throw new ApiError("forbidden", "Not available to this account");
  const ids = [...new Set(body.memberIds ?? [body.memberId ?? ""])];
  const until = addUntil(body.until, now);

  let artifactId: string | null = null;
  let spaceId: string | null = null;
  if (body.scope === "page") {
    if (!body.artifactId || body.spaceId)
      throw refuse("A page needs artifactId", "artifactId");
    artifactId = body.artifactId;
    if (!(await accessLevel(env, callerOf(owner), artifactId)))
      throw refuse("No such page", "artifactId");
    if (await pageIsOpen(env, artifactId))
      throw refuse(
        "A page open to guests or the link takes no list",
        "artifactId",
      );
  } else if (body.scope === "space") {
    if (!body.spaceId || body.artifactId)
      throw refuse("A space needs spaceId", "spaceId");
    spaceId = body.spaceId;
    const sp = await stmt(
      env.DB,
      `select 1 as x from spaces s join space_members m on m.space_id = s.id
        where s.id = ?1 and m.user_id = ?2 and s.kind = 'shared' and s.deleted_at is null limit 1`,
    )
      .bind(spaceId, ownerId)
      .first();
    if (!sp) throw refuse("No such space", "spaceId");
  } else if (body.artifactId || body.spaceId)
    throw refuse("All pages takes no page or space", "scope");

  for (const id of ids) {
    const m = id && id !== ownerId ? await getUser(env, id) : null;
    if (!m || (await isOutsideMember(env, id)))
      throw refuse("Not a teammate you can add");
    if (artifactId && !(await accessLevel(env, callerOf(m), artifactId)))
      throw refuse("That person cannot open this page");
  }

  const stmts: D1PreparedStatement[] = [];
  const entryIds: string[] = [];
  for (const id of ids) {
    const live = await stmt(
      env.DB,
      `select id, until from agent_listens
        where owner_id = ?1 and member_id = ?2 and scope = ?3 and removed_at is null and until > ?4
          and artifact_id is ?5 and space_id is ?6 limit 1`,
    )
      .bind(ownerId, id, body.scope, now, artifactId, spaceId)
      .first<{ id: string; until: number }>();
    let entryId: string;
    if (live) {
      entryId = live.id;
      if (until > live.until)
        stmts.push(
          stmt(
            env.DB,
            "update agent_listens set until = ?1 where id = ?2 and owner_id = ?3",
          ).bind(until, live.id, ownerId),
        );
    } else {
      entryId = newId();
      stmts.push(
        stmt(
          env.DB,
          `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, space_id, until, created_via, created_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(
          entryId,
          ownerId,
          id,
          body.scope,
          artifactId,
          spaceId,
          until,
          body.via,
          now,
        ),
      );
    }
    entryIds.push(entryId);
    stmts.push(
      audit(
        env,
        "agent_listens.add",
        { type: "user", id },
        userActor(ownerId),
        {
          detail: {
            level: body.scope,
            until,
            via: body.via,
            ...(live ? { extended: true } : {}),
            ...(artifactId ? { artifactId } : {}),
            ...(spaceId ? { spaceId } : {}),
          },
        },
      ),
    );
  }
  await env.DB.batch(stmts);
  const all = (await listListens(env, ownerId, now)).entries;
  return {
    entries: entryIds.flatMap((e) => all.filter((x) => x.id === e)),
  };
}

/** The window "Who asked what" covers. */
export const ASK_HISTORY_MS = 30 * DAY_MS;

/**
 * "Who asked what" for the receiver: the last 30 days of requests that were
 * held for them, newest first, as ids, names, titles and times (never words).
 * Only what is recorded: held_request_items. A request an on-list sender sent
 * is delivered at once and writes no row, so "on_list" is not returned yet.
 */
export async function askHistory(
  env: Env,
  receiverId: string,
  now = Date.now(),
): Promise<AskHistory> {
  const { results } = await stmt(
    env.DB,
    `select i.agent_key, i.state, i.created_at, i.expires_at, r.artifact_id, r.sender_id, r.quiet_until,
            u.name as sender_name, u.display_name as sender_display, u.email as sender_email,
            a.title as title, a.deleted_at as deleted_at
       from held_request_items i
       join held_requests r on r.id = i.request_id
       join users u on u.id = r.sender_id
       left join artifacts a on a.id = r.artifact_id
      where r.receiver_id = ?1 and i.created_at >= ?2 and i.state != 'withdrawn'
      order by i.created_at desc, i.id limit 500`,
  )
    .bind(receiverId, now - ASK_HISTORY_MS)
    .all<{
      agent_key: string;
      state: string;
      created_at: number;
      expires_at: number;
      artifact_id: string;
      sender_id: string;
      quiet_until: number | null;
      sender_name: string | null;
      sender_display: string | null;
      sender_email: string;
      title: string | null;
      deleted_at: number | null;
    }>();
  // Dynamic: comments.ts imports this file.
  const { artifactAgents } = await import("./comments.js");
  const me = await getUser(env, receiverId);
  const open = new Map<string, boolean>();
  const names = new Map<string, Map<string, string>>();
  const rows: AskHistoryRow[] = [];
  for (const r of results) {
    if (!open.has(r.artifact_id))
      open.set(
        r.artifact_id,
        !!me &&
          r.title !== null &&
          r.deleted_at === null &&
          (await receiverCanOpen(env, callerOf(me), r.artifact_id)),
      );
    if (!names.has(r.artifact_id))
      names.set(
        r.artifact_id,
        new Map(
          (
            await artifactAgents(env, r.artifact_id, receiverId).catch(() => [])
          ).map((a) => [a.key, a.name]),
        ),
      );
    let outcome: AskOutcome;
    if (r.state === "allowed") outcome = "allowed_once";
    else if (r.state === "lapsed" || r.expires_at <= now) outcome = "lapsed";
    else if (
      r.quiet_until !== null &&
      r.quiet_until - HELD_QUIET_MS >= r.created_at
    )
      outcome = "not_now";
    else outcome = "held";
    rows.push({
      agent: {
        key: r.agent_key,
        name: names.get(r.artifact_id)?.get(r.agent_key) ?? "An agent",
      },
      asker: {
        id: r.sender_id,
        name: personName({
          name: r.sender_name,
          displayName: r.sender_display,
          email: r.sender_email,
        }),
      },
      artifact: open.get(r.artifact_id)
        ? { id: r.artifact_id, title: r.title ?? "" }
        : null,
      at: r.created_at,
      outcome,
    });
  }
  return { rows };
}
