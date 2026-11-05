import { type Anchor, COMMENT_BODY_MAX, newId } from "@oa/shared";
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
  agent?: { name: string; via: string | null };
};

export type StoredComment = {
  id: string;
  body: string;
  author: StoredActor;
  createdAt: string;
  editedAt: string | null;
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
  return {
    threads: kept.map((r) => toThread(r, byThread.get(r.id) ?? [])),
    open: openCount(sql),
    truncated,
  };
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
  return toThread(row, cs.map(toComment));
}

/** 1 to COMMENT_BODY_MAX UTF-16 units after trim: the unit the shared body schema counts (z.string().max). */
export const bodyOk = (body: unknown): body is string =>
  typeof body === "string" &&
  body.trim().length > 0 &&
  body.trim().length <= COMMENT_BODY_MAX;

export function insertThread(
  sql: SqlStorage,
  now: string,
  t: { actor: StoredActor; anchor: Anchor; version: number; body: string },
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
  insertComment(sql, now, id, t.actor, t.body);
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
