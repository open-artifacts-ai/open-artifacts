import {
  type Anchor,
  type AskOption,
  COMMENT_BODY_MAX,
  newId,
} from "@oa/shared";
import {
  COMMENTS_MAX_BYTES,
  COMMENTS_MAX_REPLIES,
  COMMENTS_MAX_THREADS,
  COMMENTS_MAX_TOTAL,
  type CommentStatus,
} from "../services/comment-rules.js";

// The comments tables of the ArtifactRuntime DO (#682): its own SQLite,
// beside docs and storage, never in the page data budget and never reachable
// from the page's runtime calls. Plain functions over SqlStorage so the DO
// keeps its clock, its transactions and its sockets.

export const COMMENTS_SCHEMA = `
create table if not exists comment_threads (
  id text primary key, anchor text not null, version integer not null,
  status text not null, resolved_by text, resolved_at text,
  created_at text not null, activity_at text not null
);
create index if not exists comment_threads_activity on comment_threads (activity_at, id);
create index if not exists comment_threads_status on comment_threads (status, activity_at);
create table if not exists comments (
  id text primary key, thread_id text not null, body text not null,
  author text not null, created_at text not null, edited_at text
);
create index if not exists comments_thread on comments (thread_id, created_at);
create table if not exists comment_asks (
  comment_id text primary key, thread_id text not null, question text not null,
  options text not null, recommended text, addressees text not null, answer text
);
create index if not exists comment_asks_thread on comment_asks (thread_id);
create table if not exists comment_targets (
  comment_id text not null, thread_id text not null, kind text not null,
  key text not null, name text not null, state text not null, owner text,
  primary key (comment_id, kind, key)
);
create index if not exists comment_targets_thread on comment_targets (thread_id);
create table if not exists comment_asker_notices (
  thread_id text primary key, last_at text not null, prev_at text, n integer not null
);
create table if not exists comment_limits (
  id integer primary key check (id = 1), day integer not null, n integer not null
);
`;

/**
 * Who wrote a comment, as stored: `ref` is the user id (users) or the
 * per-artifact anonymous id (guests). A user's name is read from the user
 * row when shown, never stored; a guest's is the name they gave. `agent` is
 * the connection's label and the grant or token behind it (`via`, as
 * versions.agent_via), so the label's privacy follows agent-display.ts.
 */
export type StoredActor = {
  kind: "user" | "guest";
  ref: string;
  name?: string;
  agent?: {
    name: string;
    via: string | null;
    /** The bus session the connection proved (#1822), set by the server at write time. */
    identity?: { identityId: string; name: string; kind: string };
  };
  /**
   * #1797: written from a browser session (a person typing in the web app),
   * set by the route from the credential kind. Absent on older rows: not typed.
   * Only a user can carry it.
   */
  typed?: true;
};

/**
 * Someone an ask, mention or assignment names (#1535). A person is their user
 * id (`key`; the name is read from the user row when shown). An agent is an
 * opaque key from the artifact's roster, its display `name`, and `owner`, the
 * member whose agent it is (never shown; it decides who may answer for it).
 */
export type StoredParty =
  | { kind: "user"; key: string }
  | { kind: "agent"; key: string; name: string; owner: string };

export type MentionState = "delivered" | "queued" | "seen" | "gone";
export type AssignState = "delivered" | "queued" | "seen" | "done";

export type StoredAsk = {
  question: string;
  options: AskOption[];
  recommended?: { optionId: string; why: string };
  to: StoredParty[];
  answer?: { optionId: string; by: StoredActor; at: string };
  /** The thread is resolved. */
  closed: boolean;
};

/** `owner`: the member whose agent it is (#1822; absent on rows from before). */
export type StoredTarget = {
  key: string;
  name: string;
  state: string;
  owner?: string;
};

export type StoredComment = {
  id: string;
  body: string;
  author: StoredActor;
  createdAt: string;
  editedAt: string | null;
  ask?: StoredAsk;
  mentions?: StoredTarget[];
  assigned?: StoredTarget;
};

/** What a new comment carries besides its text (#1535). */
export type StoredAgent = Extract<StoredParty, { kind: "agent" }>;
export type NewExtras = {
  ask?: Omit<StoredAsk, "answer" | "closed">;
  mentions?: StoredAgent[];
  assign?: StoredAgent;
  /** A reply addressed to the ask's author (#1614): stored as a mention of its agents, under its own kind so the notice can be bounded. */
  asker?: StoredAgent[];
};

export type StoredThread = {
  id: string;
  anchor: Anchor;
  version: number;
  status: CommentStatus;
  resolvedBy: StoredActor | null;
  resolvedAt: string | null;
  createdAt: string;
  comments: StoredComment[];
};

export type StoredList = {
  threads: StoredThread[];
  open: number;
  truncated: boolean;
};

type ThreadRow = {
  id: string;
  anchor: string;
  version: number;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};
type CommentRow = {
  id: string;
  thread_id: string;
  body: string;
  author: string;
  created_at: string;
  edited_at: string | null;
};

const toComment = (r: CommentRow): StoredComment => ({
  id: r.id,
  body: r.body,
  author: JSON.parse(r.author) as StoredActor,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});
const toThread = (r: ThreadRow, comments: StoredComment[]): StoredThread => ({
  id: r.id,
  anchor: JSON.parse(r.anchor) as Anchor,
  version: r.version,
  status: r.status === "resolved" ? "resolved" : "open",
  resolvedBy: r.resolved_by ? (JSON.parse(r.resolved_by) as StoredActor) : null,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
  comments,
});

const THREAD_COLS =
  "id, anchor, version, status, resolved_by, resolved_at, created_at";

/** Open threads (the live signal's number). */
export const openCount = (sql: SqlStorage): number =>
  sql
    .exec<{ n: number }>(
      "select count(*) as n from comment_threads where status = 'open'",
    )
    .one().n;

/**
 * Threads by newest activity, at most COMMENTS_MAX_THREADS and at most
 * COMMENTS_MAX_TOTAL comments and COMMENTS_MAX_BYTES of bodies across them (the list stops at the first thread
 * that would pass it, truncated), each with its root and at most
 * COMMENTS_MAX_REPLIES replies. `open` counts every open
 * thread, whatever the filter.
 */
export function listThreads(
  sql: SqlStorage,
  status: CommentStatus | "all",
  /** Bounds the answer by body bytes; injectable for tests. */
  maxBytes: number = COMMENTS_MAX_BYTES,
): StoredList {
  const where = status === "all" ? "" : "where status = ?";
  const args = status === "all" ? [] : [status];
  const rows = sql
    .exec<ThreadRow>(
      `select ${THREAD_COLS} from comment_threads ${where}
       order by activity_at desc, id desc limit ${COMMENTS_MAX_THREADS + 1}`,
      ...args,
    )
    .toArray();
  let truncated = rows.length > COMMENTS_MAX_THREADS;
  const cand = rows.slice(0, COMMENTS_MAX_THREADS);
  // How many comments each thread would return (its root and at most
  // COMMENTS_MAX_REPLIES replies), so the whole answer can be bounded.
  const counts = new Map<string, { n: number; bytes: number }>();
  if (cand.length > 0)
    for (const r of sql.exec<{ thread_id: string; n: number; b: number }>(
      `select thread_id, count(*) as n, sum(length(cast(body as blob))) as b from comments
       where thread_id in (select value from json_each(?)) group by thread_id`,
      JSON.stringify(cand.map((t) => t.id)),
    ))
      counts.set(r.thread_id, {
        n: Math.min(r.n, COMMENTS_MAX_REPLIES + 1),
        bytes: r.b,
      });
  if (cand.length > 0)
    for (const r of sql.exec<{ thread_id: string; b: number }>(
      `select thread_id, sum(length(question) + length(options) + length(addressees)
         + length(coalesce(recommended, '')) + length(coalesce(answer, ''))) as b
       from comment_asks where thread_id in (select value from json_each(?)) group by thread_id`,
      JSON.stringify(cand.map((t) => t.id)),
    )) {
      const c = counts.get(r.thread_id);
      if (c) c.bytes += r.b;
    }
  const kept: ThreadRow[] = [];
  let total = 0;
  let bytes = 0;
  for (const t of cand) {
    const c = counts.get(t.id) ?? { n: 0, bytes: 0 };
    if (total + c.n > COMMENTS_MAX_TOTAL || bytes + c.bytes > maxBytes) {
      truncated = true;
      break;
    }
    total += c.n;
    bytes += c.bytes;
    kept.push(t);
  }
  const byThread = new Map<string, StoredComment[]>();
  if (kept.length > 0) {
    // One statement: a DO binds at most 100 parameters, so ids go as JSON.
    const cs = sql
      .exec<CommentRow>(
        `select id, thread_id, body, author, created_at, edited_at from (
           select c.*, row_number() over (partition by c.thread_id order by c.created_at, c.rowid) as rn
           from comments c
           where c.thread_id in (select value from json_each(?))
         ) where rn <= ${COMMENTS_MAX_REPLIES + 1}
         order by thread_id, rn`,
        JSON.stringify(kept.map((t) => t.id)),
      )
      .toArray();
    for (const c of cs) {
      const list = byThread.get(c.thread_id) ?? [];
      list.push(toComment(c));
      byThread.set(c.thread_id, list);
    }
  }
  attachExtras(
    sql,
    kept.map((t) => t.id),
    [...byThread.values()].flat(),
  );
  return {
    threads: kept.map((r) => toThread(r, byThread.get(r.id) ?? [])),
    open: openCount(sql),
    truncated,
  };
}

type AskRow = {
  comment_id: string;
  question: string;
  options: string;
  recommended: string | null;
  addressees: string;
  answer: string | null;
  status: string;
};
type TargetRow = {
  comment_id: string;
  kind: string;
  key: string;
  name: string;
  state: string;
  owner: string | null;
  status: string;
};

const askOf = (r: AskRow): StoredAsk => ({
  question: r.question,
  options: JSON.parse(r.options) as AskOption[],
  ...(r.recommended
    ? {
        recommended: JSON.parse(r.recommended) as {
          optionId: string;
          why: string;
        },
      }
    : {}),
  to: JSON.parse(r.addressees) as StoredParty[],
  ...(r.answer
    ? { answer: JSON.parse(r.answer) as NonNullable<StoredAsk["answer"]> }
    : {}),
  closed: r.status === "resolved",
});

/** Sets ask, mentions and assigned on `comments` (of the threads `threadIds`) from their tables. */
function attachExtras(
  sql: SqlStorage,
  threadIds: string[],
  comments: StoredComment[],
): void {
  if (threadIds.length === 0 || comments.length === 0) return;
  const ids = JSON.stringify(threadIds);
  const byId = new Map(comments.map((c) => [c.id, c]));
  for (const r of sql.exec<AskRow>(
    `select a.comment_id, a.question, a.options, a.recommended, a.addressees, a.answer, t.status
     from comment_asks a join comment_threads t on t.id = a.thread_id
     where a.thread_id in (select value from json_each(?))`,
    ids,
  )) {
    const c = byId.get(r.comment_id);
    if (c) c.ask = askOf(r);
  }
  for (const r of sql.exec<TargetRow>(
    `select g.comment_id, g.kind, g.key, g.name, g.state, g.owner, t.status
     from comment_targets g join comment_threads t on t.id = g.thread_id
     where g.thread_id in (select value from json_each(?)) order by g.rowid`,
    ids,
  )) {
    const c = byId.get(r.comment_id);
    if (!c) continue;
    // Resolving the thread finishes the work assigned in it.
    const done = r.kind === "assign" && r.status === "resolved";
    const t: StoredTarget = {
      key: r.key,
      name: r.name,
      state: done ? "done" : r.state,
      ...(r.owner ? { owner: r.owner } : {}),
    };
    if (r.kind === "assign") c.assigned = t;
    else c.mentions = [...(c.mentions ?? []), t];
  }
}

/** `c` with its ask, mentions and assigned read back. */
export function withExtras(
  sql: SqlStorage,
  threadId: string,
  c: StoredComment,
): StoredComment {
  attachExtras(sql, [threadId], [c]);
  return c;
}

/** Stores the ask, mentions and assignment of a new comment, in the caller's transaction. */
export function insertExtras(
  sql: SqlStorage,
  threadId: string,
  commentId: string,
  x: NewExtras,
): void {
  if (x.ask)
    sql.exec(
      `insert into comment_asks (comment_id, thread_id, question, options, recommended, addressees)
       values (?, ?, ?, ?, ?, ?)`,
      commentId,
      threadId,
      x.ask.question,
      JSON.stringify(x.ask.options),
      x.ask.recommended ? JSON.stringify(x.ask.recommended) : null,
      JSON.stringify(x.ask.to),
    );
  const put = (kind: "mention" | "assign" | "asker", p: StoredAgent) =>
    sql.exec(
      `insert or ignore into comment_targets (comment_id, thread_id, kind, key, name, state, owner)
       values (?, ?, ?, ?, ?, 'queued', ?)`,
      commentId,
      threadId,
      kind,
      p.key,
      p.name,
      p.owner,
    );
  for (const m of x.mentions ?? []) put("mention", m);
  if (x.assign) put("assign", x.assign);
  for (const m of x.asker ?? []) put("asker", m);
}

/**
 * The bound on notices to an ask's author's agents (#1614), kept per thread
 * in its own row: deleting a reply never gives it back. `due`: none within
 * `sinceIso` and fewer than `max` in all. `spendAsker` records one notice at
 * `at` (the reply's time), keeping the earlier time so a refund can restore it.
 */
export function askerNoticeDue(
  sql: SqlStorage,
  threadId: string,
  sinceIso: string,
  max: number,
): boolean {
  const r = sql
    .exec<{ last_at: string; n: number }>(
      "select last_at, n from comment_asker_notices where thread_id = ?",
      threadId,
    )
    .toArray()[0];
  return !r || (r.last_at < sinceIso && r.n < max);
}

export function spendAsker(
  sql: SqlStorage,
  threadId: string,
  at: string,
): void {
  sql.exec(
    `insert into comment_asker_notices (thread_id, last_at, prev_at, n) values (?, ?, null, 1)
     on conflict (thread_id) do update set prev_at = last_at, last_at = excluded.last_at, n = n + 1`,
    threadId,
    at,
  );
}

/** Gives back the notice spent at `at` (only while it is still the last one). */
export function refundAsker(
  sql: SqlStorage,
  threadId: string,
  at: string,
): void {
  sql.exec(
    `update comment_asker_notices set last_at = coalesce(prev_at, '0'), prev_at = null, n = n - 1
     where thread_id = ? and last_at = ? and n > 0`,
    threadId,
    at,
  );
}

/** Sets one mention's or the assignment's state. */
export function setTargetState(
  sql: SqlStorage,
  commentId: string,
  kind: "mention" | "assign" | "asker",
  key: string,
  state: string,
): void {
  sql.exec(
    "update comment_targets set state = ? where comment_id = ? and kind = ? and key = ?",
    state,
    commentId,
    kind,
    key,
  );
}

/** Drops the ask and targets of comments (`commentId`, or every comment of `threadId`). */
export function deleteExtras(
  sql: SqlStorage,
  by: { threadId: string } | { commentId: string },
): void {
  const [col, v] =
    "threadId" in by
      ? (["thread_id", by.threadId] as const)
      : (["comment_id", by.commentId] as const);
  sql.exec(`delete from comment_asks where ${col} = ?`, v);
  sql.exec(`delete from comment_targets where ${col} = ?`, v);
}

/** Stores an answer (replacing an earlier one). */
export function setAnswer(
  sql: SqlStorage,
  commentId: string,
  answer: NonNullable<StoredAsk["answer"]>,
): void {
  sql.exec(
    "update comment_asks set answer = ? where comment_id = ?",
    JSON.stringify(answer),
    commentId,
  );
}

/** A comment's ask row with its thread's status, or null when it has no ask. */
export function askRow(
  sql: SqlStorage,
  threadId: string,
  commentId: string,
): { ask: StoredAsk; status: string } | null {
  const r = sql
    .exec<AskRow & { status: string }>(
      `select a.comment_id, a.question, a.options, a.recommended, a.addressees, a.answer, t.status
       from comment_asks a join comment_threads t on t.id = a.thread_id
       where a.comment_id = ? and a.thread_id = ?`,
      commentId,
      threadId,
    )
    .toArray()[0];
  return r ? { ask: askOf(r), status: r.status } : null;
}

/** One comment with its extras, or null. */
export function getComment(
  sql: SqlStorage,
  threadId: string,
  commentId: string,
): StoredComment | null {
  const r = sql
    .exec<CommentRow>(
      `select id, thread_id, body, author, created_at, edited_at from comments
       where id = ? and thread_id = ?`,
      commentId,
      threadId,
    )
    .toArray()[0];
  return r ? withExtras(sql, threadId, toComment(r)) : null;
}

/** One thread with its comments (the same reply cap), or null. */
export function getThread(sql: SqlStorage, id: string): StoredThread | null {
  const row = sql
    .exec<ThreadRow>(
      `select ${THREAD_COLS} from comment_threads where id = ?`,
      id,
    )
    .toArray()[0];
  if (!row) return null;
  const cs = sql
    .exec<CommentRow>(
      `select id, thread_id, body, author, created_at, edited_at from comments
       where thread_id = ? order by created_at, rowid limit ${COMMENTS_MAX_REPLIES + 1}`,
      id,
    )
    .toArray();
  const comments = cs.map(toComment);
  attachExtras(sql, [id], comments);
  return toThread(row, comments);
}

/** 1 to COMMENT_BODY_MAX UTF-16 units after trim: the unit the shared body schema counts (z.string().max). */
export const bodyOk = (body: unknown): body is string =>
  typeof body === "string" &&
  body.trim().length > 0 &&
  body.trim().length <= COMMENT_BODY_MAX;

export function insertThread(
  sql: SqlStorage,
  now: string,
  t: {
    actor: StoredActor;
    anchor: Anchor;
    version: number;
    body: string;
    extras?: NewExtras;
  },
): StoredThread {
  const id = newId();
  sql.exec(
    `insert into comment_threads (id, anchor, version, status, created_at, activity_at)
     values (?, ?, ?, 'open', ?, ?)`,
    id,
    JSON.stringify(t.anchor),
    t.version,
    now,
    now,
  );
  const c = insertComment(sql, now, id, t.actor, t.body);
  if (t.extras) insertExtras(sql, id, c.id, t.extras);
  return getThread(sql, id) as StoredThread;
}

export function insertComment(
  sql: SqlStorage,
  now: string,
  threadId: string,
  actor: StoredActor,
  body: string,
): StoredComment {
  const id = newId();
  sql.exec(
    "insert into comments (id, thread_id, body, author, created_at) values (?, ?, ?, ?, ?)",
    id,
    threadId,
    body.trim(),
    JSON.stringify(actor),
    now,
  );
  return {
    id,
    body: body.trim(),
    author: actor,
    createdAt: now,
    editedAt: null,
  };
}

/** Replies the thread holds (its root is not one). */
export const replyCount = (sql: SqlStorage, threadId: string): number =>
  Math.max(
    0,
    sql
      .exec<{ n: number }>(
        "select count(*) as n from comments where thread_id = ?",
        threadId,
      )
      .one().n - 1,
  );

export const threadExists = (sql: SqlStorage, id: string): boolean =>
  sql.exec("select 1 from comment_threads where id = ?", id).toArray().length >
  0;

/** A thread's status, or null when it does not exist. */
export const threadStatus = (sql: SqlStorage, id: string): string | null =>
  sql
    .exec<{ status: string }>(
      "select status from comment_threads where id = ?",
      id,
    )
    .toArray()[0]?.status ?? null;

export const touchThread = (sql: SqlStorage, id: string, now: string): void => {
  sql.exec("update comment_threads set activity_at = ? where id = ?", now, id);
};

/** The root comment's id of a thread (its first), or null. */
export const rootId = (sql: SqlStorage, threadId: string): string | null =>
  sql
    .exec<{ id: string }>(
      "select id from comments where thread_id = ? order by created_at, rowid limit 1",
      threadId,
    )
    .toArray()[0]?.id ?? null;
