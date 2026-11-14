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
  options text not null, recommended text, addressees text not null, answer text,
  confirm text, decider text, replaces text
);
create index if not exists comment_asks_thread on comment_asks (thread_id);
create table if not exists comment_ask_picks (
  seq integer primary key autoincrement, comment_id text not null,
  user_id text not null, option_id text not null, by text not null,
  at text not null, typed integer not null default 0, verified text,
  guest integer not null default 0, decision integer not null default 0
);
create index if not exists comment_ask_picks_person on comment_ask_picks (comment_id, user_id, at, seq);
create table if not exists comment_targets (
  comment_id text not null, thread_id text not null, kind text not null,
  key text not null, name text not null, state text not null, owner text, identity text,
  primary key (comment_id, kind, key)
);
create index if not exists comment_targets_thread on comment_targets (thread_id);
create table if not exists comment_asker_notices (
  thread_id text primary key, last_at text not null, prev_at text, n integer not null
);
create table if not exists comment_email_notices (
  thread_id text not null, user_id text not null, last_at text not null, prev_at text,
  primary key (thread_id, user_id)
);
create table if not exists comment_participants (
  thread_id text not null, key text not null, name text not null, owner text not null,
  namespace text not null, page integer not null default 0, primary key (thread_id, key)
);
create table if not exists comment_reply_notices (
  thread_id text not null, key text not null, last_at text not null, prev_at text, n integer not null,
  primary key (thread_id, key)
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
 * Someone an ask or mention names (#1535). A person is their user
 * id (`key`; the name is read from the user row when shown). An agent is an
 * opaque key from the artifact's roster, its display `name`, and `owner`, the
 * member whose agent it is (never shown; it decides who may answer for it).
 */
export type StoredParty =
  | { kind: "user"; key: string }
  | {
      kind: "agent";
      key: string;
      name: string;
      owner: string;
      identity?: StoredIdentity;
    };

/** #1890: the bus identity of a named agent, resolved at write time from the owner's hub. Never a name: names can be reclaimed. */
export type StoredIdentity = { identityId: string; kind: string };

export type MentionState =
  | "delivered"
  | "queued"
  | "seen"
  | "gone"
  | "withdrawn";

/** #2381: one pick, kept for good. `guest`: the picker was a guest-role member then. */
export type StoredPick = {
  optionId: string;
  by: StoredActor;
  at: string;
  verified?: "passkey";
  guest?: boolean;
  /** Made as the decider (it set the decision), not a weigh-in made before they decided (#2381 S2: "Was"). */
  decision?: true;
};

export type StoredAsk = {
  question: string;
  options: AskOption[];
  recommended?: { optionId: string; why: string };
  to: StoredParty[];
  answer?: {
    optionId: string;
    by: StoredActor;
    at: string;
    /** #2263: a passkey assertion for this pick verified. Set by the server only. */
    verified?: "passkey";
  };
  /** #2263: a pick needs the picker's passkey. Set by the server when the ask is created; never changes. */
  confirm?: "passkey";
  /** #2381: the user id who decides when the asker named someone else; absent: the asker's own user. Taking the decision back clears it. */
  decider?: string;
  /** #2323: the comment id of the ask this one replaces. */
  replaces?: string;
  /** #2323: the comment id of the ask that replaces this one (read from the other row, never stored here). */
  replacedBy?: string;
  /** #2381: every pick in order, append-only (a change is a new entry); a legacy ask's lone answer reads as one. */
  history?: StoredPick[];
  /** The thread is resolved. */
  closed: boolean;
};

/** `owner`: the member whose agent it is (#1822; absent on rows from before). */
export type StoredTarget = {
  key: string;
  name: string;
  state: string;
  owner?: string;
  identity?: StoredIdentity;
};

export type StoredComment = {
  id: string;
  body: string;
  author: StoredActor;
  createdAt: string;
  editedAt: string | null;
  ask?: StoredAsk;
  mentions?: StoredTarget[];
  /** #2035: the participant agents a person's reply also told (comment_targets kind "reply"). */
  notified?: StoredTarget[];
};

/** What a new comment carries besides its text (#1535). */
export type StoredAgent = Extract<StoredParty, { kind: "agent" }>;
export type NewExtras = {
  ask?: Omit<StoredAsk, "answer" | "closed" | "history" | "replacedBy">;
  mentions?: StoredAgent[];
  /** A reply addressed to the ask's author (#1614): stored as a mention of its agents, under its own kind so the notice can be bounded. */
  asker?: StoredAgent[];
};

/**
 * #1900: an agent that joined a thread (mentioned, asked, or
 * commented as a verified identity). `key` is the roster key (artifact, member,
 * bus address); `namespace` and `name` are the bus address a notice goes to;
 * `owner` the member whose agent it is.
 */
export type StoredParticipant = StoredAgent & {
  namespace: string;
  /** #2035: an @-mention or ask brought it in: it also puts back one a person removed. */
  readd?: true;
  /** #1968: joined only because it published the page a page-wide thread is on; any other reason clears it. */
  page?: true;
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
  confirm: string | null;
  decider: string | null;
  replaces: string | null;
  status: string;
};
type TargetRow = {
  comment_id: string;
  kind: string;
  key: string;
  name: string;
  state: string;
  owner: string | null;
  identity: string | null;
};

type PickRow = {
  comment_id: string;
  option_id: string;
  by: string;
  at: string;
  verified: string | null;
  guest: number;
  decision: number;
};
const pickOf = (r: PickRow): StoredPick => ({
  optionId: r.option_id,
  by: JSON.parse(r.by) as StoredActor,
  at: r.at,
  ...(r.verified === "passkey" ? { verified: "passkey" as const } : {}),
  ...(r.guest ? { guest: true } : {}),
  ...(r.decision ? { decision: true as const } : {}),
});
/** An ask answered before #2381 has no pick rows: its answer is its one pick. */
const withLegacy = (
  ask: StoredAsk,
  rows: StoredPick[],
  author: string,
): StoredPick[] => {
  const legacy: StoredPick | undefined = ask.answer
    ? { ...ask.answer, decision: true }
    : undefined;
  // Before deciders anyone asked could answer: only the decider's own answer
  // (the asker's own user's, unless another was named) is the decision now. A
  // stored answer by anyone else reads as their weigh-in, with or without pick rows.
  if (ask.answer && ask.answer.by.ref !== (ask.decider ?? author)) {
    delete ask.answer;
    if (legacy) delete legacy.decision;
  }
  return rows.length || !legacy ? rows : [legacy];
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
  ...(r.confirm === "passkey" ? { confirm: "passkey" as const } : {}),
  ...(r.decider ? { decider: r.decider } : {}),
  ...(r.replaces ? { replaces: r.replaces } : {}),
  ...(r.answer
    ? { answer: JSON.parse(r.answer) as NonNullable<StoredAsk["answer"]> }
    : {}),
  closed: r.status === "resolved",
});

/** Sets ask and mentions on `comments` (of the threads `threadIds`) from their tables. */
function attachExtras(
  sql: SqlStorage,
  threadIds: string[],
  comments: StoredComment[],
): void {
  if (threadIds.length === 0 || comments.length === 0) return;
  const ids = JSON.stringify(threadIds);
  const byId = new Map(comments.map((c) => [c.id, c]));
  for (const r of sql.exec<AskRow>(
    `select a.comment_id, a.question, a.options, a.recommended, a.addressees, a.answer, a.confirm, a.decider, a.replaces, t.status
     from comment_asks a join comment_threads t on t.id = a.thread_id
     where a.thread_id in (select value from json_each(?))`,
    ids,
  )) {
    const c = byId.get(r.comment_id);
    if (c) c.ask = askOf(r);
  }
  const asked = comments.filter((c) => c.ask).map((c) => c.id);
  if (asked.length) {
    for (const r of sql.exec<{ comment_id: string; replaces: string }>(
      "select comment_id, replaces from comment_asks where replaces in (select value from json_each(?))",
      JSON.stringify(asked),
    )) {
      const old = comments.find((c) => c.id === r.replaces);
      if (old?.ask) old.ask.replacedBy = r.comment_id;
    }
    const hist = new Map<string, StoredPick[]>();
    for (const r of sql.exec<PickRow>(
      `select comment_id, option_id, by, at, verified, guest, decision from comment_ask_picks
       where comment_id in (select value from json_each(?)) order by seq`,
      JSON.stringify(asked),
    )) {
      const l = hist.get(r.comment_id) ?? [];
      l.push(pickOf(r));
      hist.set(r.comment_id, l);
    }
    for (const c of comments)
      if (c.ask)
        c.ask.history = withLegacy(c.ask, hist.get(c.id) ?? [], c.author.ref);
  }
  for (const r of sql.exec<TargetRow>(
    `select g.comment_id, g.kind, g.key, g.name, g.state, g.owner, g.identity
     from comment_targets g
     where g.kind in ('mention', 'asker', 'reply') and g.thread_id in (select value from json_each(?)) order by g.rowid`,
    ids,
  )) {
    const c = byId.get(r.comment_id);
    if (!c) continue;
    const t: StoredTarget = {
      key: r.key,
      name: r.name,
      state: r.state,
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.identity
        ? { identity: JSON.parse(r.identity) as StoredIdentity }
        : {}),
    };
    if (r.kind === "reply") c.notified = [...(c.notified ?? []), t];
    else c.mentions = [...(c.mentions ?? []), t];
  }
}

/** `c` with its ask and mentions read back. */
export function withExtras(
  sql: SqlStorage,
  threadId: string,
  c: StoredComment,
): StoredComment {
  attachExtras(sql, [threadId], [c]);
  return c;
}

/** Who is behind an actor: null for a person, else the agent's identity (or its name and via when it has none). */
const agentKey = (a: StoredActor): string | null =>
  a.agent
    ? (a.agent.identity?.identityId ?? `${a.agent.name}|${a.agent.via}`)
    : null;

/** The same asker: the same person, and either both are people or both the same agent. */
const same = (a: StoredActor, b: StoredActor): boolean =>
  a.kind === "user" &&
  b.kind === "user" &&
  a.ref === b.ref &&
  agentKey(a) === agentKey(b);

/**
 * #2323: `replaces` must name an ask of this artifact, posted by the same
 * asker (the same person, and the same agent when an agent posted it), not the
 * new comment itself and not already replaced by another ask. Thrown inside the
 * caller's transaction, so a refusal writes nothing.
 */
// comment_asks.replaces has no index on purpose: `taken` below and the replacedBy
// read in attachExtras each scan the table, which holds one row per ask of one
// page. Index it if a page ever holds enough asks for that to show.
function checkReplaces(sql: SqlStorage, commentId: string, old: string): void {
  const refuse = (code: string, why: string): never => {
    throw new Error(`oa:${code}:${why}`);
  };
  if (old === commentId) refuse("bad_request", "An ask cannot replace itself");
  const row = sql
    .exec<{ author: string }>(
      "select c.author as author from comment_asks a join comments c on c.id = a.comment_id where a.comment_id = ?",
      old,
    )
    .toArray()[0];
  if (!row) refuse("bad_request", "`replaces` must be an ask on this artifact");
  const me = sql
    .exec<{ author: string }>(
      "select author from comments where id = ?",
      commentId,
    )
    .toArray()[0];
  if (
    !me ||
    !same(
      JSON.parse((row as { author: string }).author) as StoredActor,
      JSON.parse(me.author) as StoredActor,
    )
  )
    refuse("bad_request", "`replaces` must be an ask you posted yourself");
  const taken = sql
    .exec<{ n: number }>(
      "select count(*) as n from comment_asks where replaces = ?",
      old,
    )
    .one().n;
  if (taken > 0) refuse("already_replaced", "That ask is already replaced");
}

/** Stores the ask and mentions of a new comment, in the caller's transaction. */
export function insertExtras(
  sql: SqlStorage,
  threadId: string,
  commentId: string,
  x: NewExtras,
): void {
  if (x.ask?.replaces) checkReplaces(sql, commentId, x.ask.replaces);
  if (x.ask)
    sql.exec(
      `insert into comment_asks (comment_id, thread_id, question, options, recommended, addressees, confirm, decider, replaces)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      commentId,
      threadId,
      x.ask.question,
      JSON.stringify(x.ask.options),
      x.ask.recommended ? JSON.stringify(x.ask.recommended) : null,
      JSON.stringify(x.ask.to),
      x.ask.confirm === "passkey" ? "passkey" : null,
      x.ask.decider ?? null,
      x.ask.replaces ?? null,
    );
  const put = (kind: "mention" | "asker", p: StoredAgent) =>
    sql.exec(
      `insert or ignore into comment_targets (comment_id, thread_id, kind, key, name, state, owner, identity)
       values (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      commentId,
      threadId,
      kind,
      p.key,
      p.name,
      p.owner,
      p.identity ? JSON.stringify(p.identity) : null,
    );
  for (const m of x.mentions ?? []) put("mention", m);
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

/**
 * Comment emails (#1467): at most one per (thread, person) per window. Claims
 * the slot for each of `userIds` that has none since `sinceIso` and returns
 * those; `at` is the time recorded. `refundEmail` gives one back when the
 * send failed (only while `at` is still the last).
 */
export function claimEmail(
  sql: SqlStorage,
  threadId: string,
  userIds: string[],
  sinceIso: string,
  at: string,
): string[] {
  const won: string[] = [];
  for (const u of userIds) {
    const r = sql
      .exec<{ user_id: string }>(
        `insert into comment_email_notices (thread_id, user_id, last_at, prev_at) values (?1, ?2, ?3, null)
         on conflict (thread_id, user_id) do update set prev_at = last_at, last_at = excluded.last_at
         where comment_email_notices.last_at <= ?4
         returning user_id`,
        threadId,
        u,
        at,
        sinceIso,
      )
      .toArray();
    if (r.length) won.push(u);
  }
  return won;
}

export function refundEmail(
  sql: SqlStorage,
  threadId: string,
  userId: string,
  at: string,
): void {
  sql.exec(
    `update comment_email_notices set last_at = coalesce(prev_at, ''), prev_at = null
     where thread_id = ? and user_id = ? and last_at = ?`,
    threadId,
    userId,
    at,
  );
}

/**
 * Records the agents that joined a thread (#1900); one already there stays as
 * it was. #2035: one a person removed stays removed, unless this comment
 * @-mentions or asks it (`readd`).
 */
export function addParticipants(
  sql: SqlStorage,
  threadId: string,
  ps: StoredParticipant[],
): void {
  for (const p of ps) {
    sql.exec(
      `insert into comment_participants (thread_id, key, name, owner, namespace, page, identity)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (thread_id, key) do update set page = 0 where excluded.page = 0`,
      threadId,
      p.key,
      p.name,
      p.owner,
      p.namespace,
      p.page ? 1 : 0,
      p.identity ? JSON.stringify(p.identity) : null,
    );
    // A later comment may know the identity an earlier one did not.
    if (p.identity)
      sql.exec(
        "update comment_participants set identity = ? where thread_id = ? and key = ? and identity is null",
        JSON.stringify(p.identity),
        threadId,
        p.key,
      );
    if (p.readd)
      sql.exec(
        "update comment_participants set removed = 0 where thread_id = ? and key = ?",
        threadId,
        p.key,
      );
  }
}

/** A thread's participant as stored, with whether a person removed it. */
export type ParticipantRow = StoredParticipant & { removed: boolean };

type ParticipantSql = {
  key: string;
  name: string;
  owner: string;
  namespace: string;
  page: number;
  removed: number;
  identity: string | null;
};

const participantOfRow = (r: ParticipantSql): ParticipantRow => ({
  kind: "agent",
  key: r.key,
  name: r.name,
  owner: r.owner,
  namespace: r.namespace,
  ...(r.page === 1 ? { page: true as const } : {}),
  ...(r.identity ? { identity: JSON.parse(r.identity) as StoredIdentity } : {}),
  removed: r.removed === 1,
});

/** The participants of `threadIds`, by thread (#2035). */
export function participantsOf(
  sql: SqlStorage,
  threadIds: string[],
): Map<string, ParticipantRow[]> {
  const out = new Map<string, ParticipantRow[]>();
  if (threadIds.length === 0) return out;
  for (const r of sql.exec<ParticipantSql & { thread_id: string }>(
    `select thread_id, key, name, owner, namespace, page, removed, identity from comment_participants
     where thread_id in (select value from json_each(?)) order by key`,
    JSON.stringify(threadIds),
  )) {
    const list = out.get(r.thread_id) ?? [];
    list.push(participantOfRow(r));
    out.set(r.thread_id, list);
  }
  return out;
}

/** Removes (or puts back) one participant (#2035). False when the thread has no such agent. */
export function setParticipantRemoved(
  sql: SqlStorage,
  threadId: string,
  key: string,
  removed: boolean,
): boolean {
  const there =
    sql
      .exec(
        "select 1 from comment_participants where thread_id = ? and key = ?",
        threadId,
        key,
      )
      .toArray().length > 0;
  if (there)
    sql.exec(
      "update comment_participants set removed = ? where thread_id = ? and key = ?",
      removed ? 1 : 0,
      threadId,
      key,
    );
  return there;
}

/** Records who a person's reply also told, with how it went (#2035). */
export function recordReplyTargets(
  sql: SqlStorage,
  threadId: string,
  commentId: string,
  ts: { p: StoredParticipant; state: string }[],
): void {
  for (const { p, state } of ts)
    sql.exec(
      `insert or ignore into comment_targets (comment_id, thread_id, kind, key, name, state, owner, identity)
       values (?, ?, 'reply', ?, ?, ?, ?, ?)`,
      commentId,
      threadId,
      p.key,
      p.name,
      state,
      p.owner,
      p.identity ? JSON.stringify(p.identity) : null,
    );
}

/**
 * The participants a person's reply tells (#1900), minus `exclude` (agents the
 * same comment already reached), and records one notice for each at `at`. The
 * thread stops at `max` notices in all; replies that arrive while an agent's
 * notice is unread are not dropped: the hub replaces the waiting notice. The bound lives in its own rows: deleting a reply never
 * gives it back. A resolved thread tells nobody. Returns the agents told.
 */
export function takeThreadReply(
  sql: SqlStorage,
  threadId: string,
  exclude: Set<string>,
  at: string,
  max: number,
  /** The comment @-mentions someone: agents that joined only as the page's publisher are skipped (#1968). */
  skipPage = false,
): StoredParticipant[] {
  if (threadStatus(sql, threadId) !== "open") return [];
  const total =
    sql
      .exec<{ n: number | null }>(
        "select sum(n) as n from comment_reply_notices where thread_id = ?",
        threadId,
      )
      .toArray()[0]?.n ?? 0;
  let room = max - total;
  const out: StoredParticipant[] = [];
  const rows = sql
    .exec<ParticipantSql>(
      `select key, name, owner, namespace, page, removed, identity from comment_participants
       where thread_id = ? and removed = 0 order by key`,
      threadId,
    )
    .toArray();
  for (const r of rows) {
    if (room <= 0) break;
    if (exclude.has(r.key) || (skipPage && r.page === 1)) continue;
    sql.exec(
      `insert into comment_reply_notices (thread_id, key, last_at, prev_at, n) values (?, ?, ?, null, 1)
       on conflict (thread_id, key) do update set prev_at = last_at, last_at = excluded.last_at, n = n + 1`,
      threadId,
      r.key,
      at,
    );
    room--;
    out.push({
      kind: "agent",
      key: r.key,
      name: r.name,
      owner: r.owner,
      namespace: r.namespace,
      ...(r.identity
        ? { identity: JSON.parse(r.identity) as StoredIdentity }
        : {}),
    });
  }
  return out;
}

/** Gives back the notices spent at `at` for `keys` (only while still the last). */
export function refundThreadReply(
  sql: SqlStorage,
  threadId: string,
  keys: string[],
  at: string,
): void {
  for (const key of keys)
    sql.exec(
      `update comment_reply_notices set last_at = coalesce(prev_at, '0'), prev_at = null, n = n - 1
       where thread_id = ? and key = ? and last_at = ? and n > 0`,
      threadId,
      key,
      at,
    );
}

/**
 * #2197: gives back one notice for `key` when its target settled gone. The
 * state move already makes this once-only, so `n` is refunded whatever order
 * the targets settle in; the pacing timestamps roll back only while `at` is
 * still the last (SET expressions read the old row).
 */
export function refundThreadReplyCount(
  sql: SqlStorage,
  threadId: string,
  key: string,
  at: string,
): void {
  sql.exec(
    `update comment_reply_notices set n = n - 1,
       last_at = case when last_at = ? then coalesce(prev_at, '0') else last_at end,
       prev_at = case when last_at = ? then null else prev_at end
     where thread_id = ? and key = ? and n > 0`,
    at,
    at,
    threadId,
    key,
  );
}

/** Sets one mention's state. */
export function setTargetState(
  sql: SqlStorage,
  commentId: string,
  kind: "mention" | "asker" | "reply",
  key: string,
  state: string,
): void {
  // A late write never undoes a daemon's ack that landed first (#1752):
  // "queued" only replaces queued, "gone" never replaces delivered or seen,
  // and nothing replaces seen.
  sql.exec(
    `update comment_targets set state = ? where comment_id = ? and kind = ? and key = ?
     and case ? when 'queued' then state = 'queued'
                when 'gone' then state in ('queued', 'gone')
                else state != 'seen' end`,
    state,
    commentId,
    kind,
    key,
    state,
  );
}

/**
 * #1752/#2062: a daemon's ack ("delivered") or refusal ("gone") of a notice, or
 * a send to a socket without notice_ack. Moves a queued target to `state`. A
 * late "delivered" also lifts a "gone" target (a notice held past the Worker's
 * budget); "seen" and "delivered" stay final. The asker bound refunded when
 * the target went gone is NOT re-spent: one extra ask is accepted. Only
 * queued->gone refunds, so no path refunds twice. True when it moved.
 */
export function settleTarget(
  sql: SqlStorage,
  commentId: string,
  kind: "mention" | "asker" | "reply",
  key: string,
  state: "delivered" | "gone",
): boolean {
  return (
    sql.exec(
      "update comment_targets set state = ? where comment_id = ? and kind = ? and key = ? and (state = 'queued' or (? = 'delivered' and state = 'gone'))",
      state,
      commentId,
      kind,
      key,
      state,
    ).rowsWritten > 0
  );
}

/**
 * #1752: after a refused asker notice, gives the asker bound back when every
 * mention and asker target of the comment reads gone (as the Worker does
 * after a send). A thread-reply row (#2035) is not the asker's: it never holds
 * the refund back.
 */
export function refundAskerIfAllGone(sql: SqlStorage, commentId: string): void {
  const c = sql
    .exec<{ threadId: string; at: string }>(
      "select thread_id as threadId, created_at as at from comments where id = ?",
      commentId,
    )
    .toArray()[0];
  if (!c) return;
  const open = sql
    .exec(
      "select 1 from comment_targets where comment_id = ? and kind != 'reply' and state not in ('gone', 'withdrawn') limit 1",
      commentId,
    )
    .toArray();
  if (open.length === 0) refundAsker(sql, c.threadId, c.at);
}

/** #2240: the ask comments of a thread with their authors (to find an agent's own asks). */
export function askAuthors(
  sql: SqlStorage,
  threadId: string,
): { commentId: string; author: StoredActor }[] {
  return sql
    .exec<{ id: string; author: string }>(
      "select c.id as id, c.author as author from comment_asks a join comments c on c.id = a.comment_id where a.thread_id = ? order by c.rowid",
      threadId,
    )
    .toArray()
    .map((r) => ({
      commentId: r.id,
      author: JSON.parse(r.author) as StoredActor,
    }));
}

/** #2175: this thread's comments with a target for `key` still held (queued) or expired by the Worker (gone; the hub may still hold it): what to ask the hub about. */
export function heldTargets(
  sql: SqlStorage,
  threadId: string,
  key: string,
): { commentId: string; kind: "mention" | "asker" | "reply" }[] {
  return sql
    .exec<{ commentId: string; kind: "mention" | "asker" | "reply" }>(
      "select comment_id as commentId, kind from comment_targets where thread_id = ? and key = ? and state in ('queued', 'gone') order by rowid",
      threadId,
      key,
    )
    .toArray();
}

/**
 * #2175: marks the targets the hub withdrew "withdrawn" (only while still
 * queued or gone, so a delivered or seen one stays) and gives back their spends: an asker
 * notice like one that never reached the agent, a thread reply's per key.
 */
export function withdrawTargets(
  sql: SqlStorage,
  threadId: string,
  key: string,
  targets: { commentId: string; kind: "mention" | "asker" | "reply" }[],
): void {
  const askers = new Set<string>();
  const move = (t: { commentId: string; kind: string }, from: string) =>
    sql.exec(
      "update comment_targets set state = 'withdrawn' where comment_id = ? and kind = ? and key = ? and thread_id = ? and state = ?",
      t.commentId,
      t.kind,
      key,
      threadId,
      from,
    ).rowsWritten > 0;
  for (const t of targets) {
    // A target the Worker already gave up on ("gone") was refunded then: it
    // becomes withdrawn without a second refund.
    if (!move(t, "queued")) {
      move(t, "gone");
      continue;
    }
    if (t.kind === "asker") askers.add(t.commentId);
    else if (t.kind === "reply") {
      const c = sql
        .exec<{ at: string }>(
          "select created_at as at from comments where id = ?",
          t.commentId,
        )
        .toArray()[0];
      if (c) refundThreadReply(sql, threadId, [key], c.at);
    }
  }
  // After every target moved, so the order the hub names them in is moot.
  for (const id of askers) refundAskerIfAllGone(sql, id);
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
  sql.exec(
    `delete from comment_ask_picks where comment_id in (select comment_id from comment_asks where ${col} = ?)`,
    v,
  );
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

/** Appends a pick to an ask's history (#2381). */
export function addPick(
  sql: SqlStorage,
  commentId: string,
  p: StoredPick,
): void {
  sql.exec(
    "insert into comment_ask_picks (comment_id, user_id, option_id, by, at, typed, verified, guest, decision) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    commentId,
    p.by.ref,
    p.optionId,
    JSON.stringify(p.by),
    p.at,
    p.by.kind === "user" && p.by.typed === true && !p.by.agent ? 1 : 0,
    p.verified ?? null,
    p.guest ? 1 : 0,
    p.decision ? 1 : 0,
  );
}

/** The most picks one person may add to one ask (#2381): a retry loop or a bot stops here. */
export const PICKS_PER_PERSON_MAX = 50;

/** How many picks `userId` has made on the ask. */
export function pickCount(
  sql: SqlStorage,
  commentId: string,
  userId: string,
): number {
  return sql
    .exec<{ n: number }>(
      "select count(*) as n from comment_ask_picks where comment_id = ? and user_id = ?",
      commentId,
      userId,
    )
    .one().n;
}

/** Clears the decider only while it is still `from` and nothing is decided (#2381): a compare-and-set. True when it moved. */
export function clearDecider(
  sql: SqlStorage,
  commentId: string,
  from: string,
): boolean {
  return (
    sql.exec(
      "update comment_asks set decider = null where comment_id = ? and decider = ? and answer is null",
      commentId,
      from,
    ).rowsWritten > 0
  );
}

/** A comment's ask row with its thread's status, or null when it has no ask. */
export function askRow(
  sql: SqlStorage,
  threadId: string,
  commentId: string,
): { ask: StoredAsk; status: string; author: string; legacy: boolean } | null {
  const r = sql
    .exec<AskRow & { status: string; author: string }>(
      `select a.comment_id, a.question, a.options, a.recommended, a.addressees, a.answer, a.confirm, a.decider, a.replaces, t.status, c.author
       from comment_asks a join comment_threads t on t.id = a.thread_id join comments c on c.id = a.comment_id
       where a.comment_id = ? and a.thread_id = ?`,
      commentId,
      threadId,
    )
    .toArray()[0];
  if (!r) return null;
  const ask = askOf(r);
  const rows = sql
    .exec<PickRow>(
      "select comment_id, option_id, by, at, verified, guest, decision from comment_ask_picks where comment_id = ? order by seq",
      commentId,
    )
    .toArray()
    .map(pickOf);
  const author = (JSON.parse(r.author) as StoredActor).ref;
  ask.history = withLegacy(ask, rows, author);
  return {
    ask,
    status: r.status,
    author,
    legacy: rows.length === 0 && ask.history.length > 0,
  };
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
