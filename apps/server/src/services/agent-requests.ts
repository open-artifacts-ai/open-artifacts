import {
  ALLOW_ITEMS_MAX,
  type AllowBody,
  type AllowResult,
  HELD_LAPSE_MS,
  HELD_QUIET_MS,
  type HeldItem,
  type HeldList,
  type HeldRequest,
  type HeldWay,
  LISTEN_MAX_MS,
  LISTEN_PAGE_MS,
  newId,
} from "@oa/shared";
import { accessLevel, callerOf, meetsLevel } from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logInfo, logWarn } from "../log.js";
import type { HeldAgent } from "../runtime/comments-store.js";
import { runtimeCall, runtimeStub } from "../runtime/do.js";
import { sha256Hex } from "../util/crypto.js";
import { askInfo } from "./asks.js";
import { audit, userActor } from "./audit.js";
import { type CommentNoticeKind, notifyAgent } from "./comment-agents.js";
import { isOutsideMember, takeReceiverSlot } from "./mention-guards.js";
import { hasPasskey, listenChallenge, verifyListen } from "./passkeys.js";
import { getUser } from "./users.js";

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
  return !!g;
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
             and space_id = (select space_id from artifacts where id = ?4))) limit 1`,
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

/** Another person's agent is asked by `senderId`: deliver now (they are on the list) or hold it for their person. */
export async function decide(
  env: Env,
  senderId: string,
  receiverId: string,
  artifactId: string,
): Promise<"deliver" | "hold"> {
  return (await listensTo(env, receiverId, senderId, artifactId))
    ? "deliver"
    : "hold";
}

/** The D1 side of a hold: one request row per (receiver, sender, page) and an item per held agent. Never throws. */
export async function recordHolds(
  env: Env,
  senderId: string,
  artifactId: string,
  threadId: string,
  commentId: string,
  held: { agent: HeldAgent; way: string }[],
  now = Date.now(),
): Promise<void> {
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
  } catch (e) {
    logWarn("held_record_failed", e, { artifactId });
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
            a.title as title, u.name as sender_name, u.email as sender_email
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
      sender_email: string;
    }>();
  const out: HeldRequest[] = [];
  for (const r of reqs) {
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
        name: r.sender_name ?? r.sender_email.split("@")[0] ?? "Someone",
      },
      artifact: { id: r.artifact_id, title: r.title },
      items,
      since: r.created_at,
      lastAt: r.last_at,
      quietUntil: r.quiet_until,
      open: await pageIsOpen(env, r.artifact_id),
      space: await spaceOf(env, r.artifact_id),
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
export const listenBinding = (level: "page" | "space" | "all", until: number) =>
  `${level}:${until}`;

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
  return listenChallenge(
    env,
    receiverId,
    r.sender_id,
    listenBinding(level, until),
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
  const open = await pageIsOpen(env, req.artifact_id);
  if (body.level === "page" && open)
    throw new ApiError(
      "bad_request",
      "The list does not apply on a page open to guests or to anyone with the link: allow once",
    );
  let until = 0;
  let space: { id: string; name: string } | null = null;
  if (body.level === "page") until = now + LISTEN_PAGE_MS;
  if (body.level === "space") {
    space = await spaceOf(env, req.artifact_id);
    if (!space)
      throw new ApiError("bad_request", "This page is not in a shared space");
    if (open)
      throw new ApiError(
        "bad_request",
        "The list does not apply on a page open to guests or to anyone with the link: allow once",
      );
  }
  if (body.level === "space" || body.level === "all") {
    until = body.until ?? 0;
    if (until <= now || until > now + LISTEN_MAX_MS)
      throw new ApiError("bad_request", "`until` is at most a year from now");
  }
  if (body.level !== "once") {
    // Any list add needs the passkey when the member has one; all pages always.
    const has = await hasPasskey(env, receiverId, now);
    if (body.level === "all" || body.level === "space" || has) {
      if (!body.assertion)
        throw new ApiError("passkey_required", "This needs your passkey");
      await verifyListen(
        env,
        receiverId,
        req.sender_id,
        listenBinding(body.level, until),
        body.assertion,
        now,
      );
    }
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
    if (!info || info.held.length === 0) {
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
    const resuming = info.held.some((h) => h.state === "releasing");
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
    // An ask held for this person: its rows open now, with the question.
    const c = rel.comment;
    if (c?.ask)
      await openAskRow(env, req.artifact_id, row.comment_id, receiverId, c);
    result.sent += rel.keys.length;
  }
  if (body.level !== "once") {
    const exists = await stmt(
      env.DB,
      `select id from agent_listens where owner_id = ?1 and member_id = ?2 and removed_at is null
         and scope = ?3 and coalesce(artifact_id, space_id, '') = ?4`,
    )
      .bind(
        receiverId,
        req.sender_id,
        body.level,
        body.level === "all"
          ? ""
          : body.level === "space"
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
          body.level,
          body.level === "page" ? req.artifact_id : null,
          until,
          body.level === "all"
            ? "allow_all"
            : body.level === "space"
              ? "allow_space"
              : "allow_page",
          now,
          body.level === "space" ? (space?.id ?? null) : null,
        )
        .run();
    await audit(
      env,
      "agent_listens.add",
      { type: "user", id: req.sender_id },
      userActor(receiverId),
      { detail: { level: body.level, until, artifactId: req.artifact_id } },
    ).run();
  }
  await audit(
    env,
    "agent_ask.allow",
    { type: "user", id: req.sender_id },
    userActor(receiverId),
    {
      detail: {
        level: body.level,
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
