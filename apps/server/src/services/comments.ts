import {
  type Anchor,
  type AnchorInput,
  type AskInput,
  AskInputSchema,
  anchorInputSchema,
  type Comment,
  type CommentAuthor,
  type CommentList,
  isId,
  type KeyRef,
  type CommentThread as Thread,
} from "@oa/shared";
import { type ArtifactRow, accessLevel, callerOf } from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logInfo } from "../log.js";
import {
  bodyOk,
  type NewExtras,
  type StoredActor,
  type StoredComment,
  type StoredParty,
  type StoredThread,
} from "../runtime/comments-store.js";
import { runtimeCall, runtimeStub } from "../runtime/do.js";
import {
  agentFor,
  isPrivateAgent,
  ownersAgent,
  shownName,
} from "./agent-display.js";
import { type AgentAttr, viaKey } from "./agent-usage.js";
import {
  agentRoster,
  type CommentNoticeKind,
  type DeliveryState,
  notifyAgent,
  type RosterAgent,
  storedAgent,
} from "./comment-agents.js";
import {
  verifyQuote,
  versionEntryHash,
  versionFormat,
} from "./comment-anchor.js";
import { type CommentStatus, cleanGuestName } from "./comment-rules.js";
import { effectiveName, getUser } from "./users.js";

// Comments on any artifact (#682): the service the REST routes call, and the
// MCP tools after them. Storage is the artifact's DO (runtime/comments-store);
// this layer verifies anchors, builds authors and shows names the way
// agent-display.ts allows. Authorization (who may open, comment, moderate) is
// the caller's: the route, from the policy table and `can`.

/** Who is acting: a signed-in person (maybe through an agent) or a signed-out guest. */
export type CommentWho =
  | { kind: "user"; id: string; agent?: AgentAttr | null }
  | {
      kind: "guest";
      /** The per-artifact anonymous id (anon-id.ts short). */
      short: string;
      /** The rate-limit key: "ip:{key}". */
      rate: string;
      name?: string;
    };

/** Who is looking, for `me` and the privacy of agent labels. Guests without an id are `null`. */
export type CommentViewer = {
  userId: string | null;
  short: string | null;
  /** The viewer's level may delete anyone's comment (owner, manager, editor). */
  moderator?: boolean;
};

const rateKeyOf = (w: CommentWho): string =>
  w.kind === "user" ? `u:${w.id}` : w.rate;

const actorOf = (w: CommentWho): StoredActor =>
  w.kind === "user"
    ? {
        kind: "user",
        ref: w.id,
        ...(w.agent
          ? {
              agent: {
                name: w.agent.name,
                via: w.agent.via ? viaKey(w.agent.via) : null,
              },
            }
          : {}),
      }
    : { kind: "guest", ref: w.short, name: cleanGuestName(w.name) };

/** Seconds in a "[retry:N]" the DO put on a rate_limited message. */
const RETRY = /\s*\[retry:(\d+)\]$/;

/** A DO call, its errors as ApiError; a 429 carries Retry-After. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await runtimeCall(fn);
  } catch (e) {
    if (e instanceof ApiError && e.code === "rate_limited") {
      const m = RETRY.exec(e.message);
      if (m)
        throw new ApiError(
          "rate_limited",
          e.message.replace(RETRY, ""),
          e.details,
          { "retry-after": m[1] as string },
        );
    }
    throw e;
  }
}

const stub = (env: Env, artifactId: string) => runtimeStub(env, artifactId);

/** 400 invalid_body: empty after trim, or over 2,000 characters. */
export function checkBody(body: unknown): string {
  if (!bodyOk(body))
    throw new ApiError(
      "invalid_body",
      "A comment is 1 to 2,000 characters after trimming",
    );
  return body.trim();
}

/** What verification produced: the anchor to store and the version it names. */
export type CheckedAnchor = { anchor: Anchor; version: number };

/**
 * An anchor as posted, checked: its schema (400 invalid_anchor), the version
 * it names (missing means current; a version that does not exist is 422
 * anchor_not_in_version) and, for a text anchor on an html version, the quote
 * (422 anchor_not_in_version; the context is re-derived when only it is off).
 * Other formats get the schema check only.
 */
export async function checkAnchor(
  env: Pick<Env, "DB" | "FILES" | "PLAN">,
  a: Pick<ArtifactRow, "id" | "format" | "currentVersion">,
  raw: unknown,
  /** Runs before the version's file is read: the caller's rate limit, so a refused quote still counts. */
  beforeVerify?: () => Promise<void>,
): Promise<CheckedAnchor> {
  const p = anchorInputSchema.safeParse(raw);
  if (!p.success)
    throw new ApiError("invalid_anchor", "Invalid anchor", p.error.issues);
  const input: AnchorInput = p.data;
  const current = Math.max(1, a.currentVersion);
  if (input.kind === "note") return { anchor: input, version: current };
  const version = input.version ?? current;
  if (input.kind === "pin") {
    const format = await versionFormat(env, a.id, a.format, version);
    if (format === null)
      throw new ApiError(
        "anchor_not_in_version",
        "That version does not exist",
      );
    // v1 pins are for images and pdf; on html the hash is a free channel into the frame.
    if (format === "html")
      throw new ApiError("invalid_anchor", "Pins are not available on html", [
        { path: ["kind"], message: "Pins are not available on html" },
      ]);
    // Rate limit first: the hash may cost an R2 read (a pre-digest version).
    await beforeVerify?.();
    // The server stamps the hash from the version's own bytes: a client's value is ignored.
    const entry = await versionEntryHash(env, a.id, version);
    if (entry === null)
      throw new ApiError(
        "anchor_not_in_version",
        "That version has no entry file",
      );
    return {
      anchor: { ...input, version, contentHash: entry.hash },
      version,
    };
  }
  await beforeVerify?.();
  const found = await verifyQuote(env, a.id, a.format, version, input);
  // An html page's own code receives the anchor in the frame: its free-text
  // block hint is never stored.
  const { block: kept, ...rest } = input;
  return {
    anchor: {
      ...rest,
      ...(found === null && kept ? { block: kept } : {}),
      version,
      ...(found ?? {}),
    },
    version,
  };
}

// ------------------------------------------------------------------- views

type UserLite = { id: string; name: string | null; email: string };

async function usersById(
  env: Env,
  ids: Iterable<string>,
): Promise<Map<string, UserLite>> {
  const list = [...new Set(ids)];
  const out = new Map<string, UserLite>();
  // D1 binds at most 100 parameters.
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `select id, email, name, display_name as displayName from users where id in (${part.map(() => "?").join(",")})`,
    )
      .bind(...part)
      .all<{
        id: string;
        email: string;
        name: string;
        displayName: string | null;
      }>();
    for (const r of results)
      out.set(r.id, {
        id: r.id,
        email: r.email,
        name: effectiveName(r),
      });
  }
  return out;
}

const authorView = (
  a: StoredActor,
  viewer: CommentViewer,
  users: Map<string, UserLite>,
): CommentAuthor => {
  if (a.kind === "guest")
    return {
      kind: "guest",
      name: a.name ?? "Guest",
      me: viewer.short !== null && viewer.short === a.ref,
    };
  const u = users.get(a.ref);
  const out: CommentAuthor = {
    kind: "user",
    id: a.ref,
    name: u ? shownName(u) : "Member",
    me: viewer.userId !== null && viewer.userId === a.ref,
  };
  if (a.agent) {
    // A private token label shows only to its owner; everyone else sees
    // "<owner>'s agent" (a grant's client name is public).
    out.agent =
      !isPrivateAgent(a.agent.via) || viewer.userId === a.ref
        ? a.agent.name
        : u
          ? ownersAgent(u)
          : agentFor(
              { name: a.agent.name, version: null },
              a.agent.via,
              { id: a.ref, name: null, email: "" },
              viewer.userId,
            ).name;
  }
  return out;
};

async function threadViews(
  env: Env,
  threads: StoredThread[],
  viewer: CommentViewer,
): Promise<Thread[]> {
  const ids = new Set<string>();
  for (const t of threads) {
    if (t.resolvedBy?.kind === "user") ids.add(t.resolvedBy.ref);
    for (const c of t.comments) userIds(c, ids);
  }
  const users = await usersById(env, ids);
  return threads.map((t) => ({
    id: t.id,
    anchor: t.anchor,
    version: t.version,
    status: t.status,
    resolvedBy: t.resolvedBy ? authorView(t.resolvedBy, viewer, users) : null,
    resolvedAt: t.resolvedAt,
    createdAt: t.createdAt,
    comments: t.comments.map((c) => commentOf(c, viewer, users)),
  }));
}

/** The users a comment shows by name: its author and, on an ask, who was asked and who answered. */
function userIds(c: StoredComment, into: Set<string>): void {
  if (c.author.kind === "user") into.add(c.author.ref);
  if (!c.ask) return;
  for (const p of c.ask.to) if (p.kind === "user") into.add(p.key);
  if (c.ask.answer?.by.kind === "user") into.add(c.ask.answer.by.ref);
}

/** Someone an ask names, as an author: a person by name, an agent by its roster name (`me` when it is the viewer's). */
const partyView = (
  p: StoredParty,
  viewer: CommentViewer,
  users: Map<string, UserLite>,
): CommentAuthor =>
  p.kind === "user"
    ? authorView({ kind: "user", ref: p.key }, viewer, users)
    : {
        kind: "user",
        id: p.key,
        name: p.name,
        me: viewer.userId !== null && viewer.userId === p.owner,
      };

const commentOf = (
  c: StoredComment,
  viewer: CommentViewer,
  users: Map<string, UserLite>,
): Comment => {
  const author = authorView(c.author, viewer, users);
  return {
    id: c.id,
    body: c.body,
    author,
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    can: { edit: author.me, delete: author.me || viewer.moderator === true },
    ...(c.ask
      ? {
          ask: {
            question: c.ask.question,
            options: c.ask.options,
            ...(c.ask.recommended ? { recommended: c.ask.recommended } : {}),
            to: c.ask.to.map((p) => partyView(p, viewer, users)),
            ...(c.ask.answer
              ? {
                  answer: {
                    optionId: c.ask.answer.optionId,
                    by: authorView(c.ask.answer.by, viewer, users),
                    at: c.ask.answer.at,
                  },
                }
              : {}),
            closed: c.ask.closed,
          },
        }
      : {}),
    ...(c.mentions?.length
      ? {
          mentions: c.mentions.map((m) => ({
            key: m.key,
            name: m.name,
            delivery: m.state as "delivered" | "queued" | "seen" | "gone",
          })),
        }
      : {}),
    ...(c.assigned
      ? {
          assigned: {
            key: c.assigned.key,
            name: c.assigned.name,
            state: c.assigned.state as "delivered" | "queued" | "seen" | "done",
          },
        }
      : {}),
  };
};

async function commentView(
  env: Env,
  c: StoredComment,
  viewer: CommentViewer,
): Promise<Comment> {
  const ids = new Set<string>();
  userIds(c, ids);
  return commentOf(c, viewer, await usersById(env, ids));
}

// -------------------------------------------------------------------- reads

/** Threads by newest activity (at most 500, 200 replies each) and the open count. */
export async function listComments(
  env: Env,
  artifactId: string,
  status: CommentStatus | "all",
  viewer: CommentViewer,
): Promise<CommentList> {
  const r = await call(() => stub(env, artifactId).commentsList(status));
  return {
    threads: await threadViews(env, r.threads, viewer),
    open: r.open,
    truncated: r.truncated,
  };
}

// ------------------------------------------------------------------- writes

/** What a comment may carry besides its body (#1535). `ask` is for the MCP tool: no REST body takes it. */
export type CommentExtras = {
  mentions?: KeyRef[];
  assign?: KeyRef;
  ask?: AskInput;
};

/** Who may mention, assign and ask. `moderator`: the owner or an editor. */
export type ExtrasOpts = { moderator?: boolean };

type Resolved = {
  extras: NewExtras | undefined;
  /** Every agent the comment reaches, once, with why (assign beats ask beats mention). */
  agents: { agent: RosterAgent; kind: CommentNoticeKind }[];
  mentions: string[];
  assign: string | null;
};

const unknownKey = (key: string) =>
  new ApiError("bad_request", `Unknown agent or person: ${key}`);

/**
 * Checks and resolves mentions, assignment and ask. 403 forbidden unless the
 * caller is the owner or an editor (mentions and assign) or a signed-in person
 * (ask); 400 bad_request for a key that is no agent following the artifact
 * (mentions, assign) or no such agent or person who can read it (ask).
 */
async function resolveExtras(
  env: Env,
  artifactId: string,
  who: CommentWho,
  x: CommentExtras,
  opts: ExtrasOpts,
): Promise<Resolved> {
  const none = { extras: undefined, agents: [], mentions: [], assign: null };
  const wantsTargets = (x.mentions?.length ?? 0) > 0 || x.assign !== undefined;
  if (!wantsTargets && !x.ask) return none;
  // An ask notifies agents too: the same rule as mentions and assignments.
  if ((wantsTargets || x.ask) && !opts.moderator)
    throw new ApiError(
      "forbidden",
      "Only the owner and editors can mention, assign or ask",
    );
  if (x.ask && who.kind !== "user")
    throw new ApiError("forbidden", "Sign in to ask a question");
  const parsed = x.ask ? AskInputSchema.safeParse(x.ask) : null;
  if (parsed && !parsed.success)
    throw new ApiError("bad_request", "Invalid ask", parsed.error.issues);
  const askIn = parsed?.success ? parsed.data : undefined;
  const roster = await agentRoster(
    env,
    artifactId,
    who.kind === "user" ? who.id : null,
    false,
  );
  const agentOf = (key: string): RosterAgent => {
    const a = roster.find((r) => r.key === key);
    if (!a) throw unknownKey(key);
    return a;
  };
  const mentioned = [...new Set((x.mentions ?? []).map((m) => m.key))].map(
    agentOf,
  );
  const assigned = x.assign ? agentOf(x.assign.key) : null;
  let ask: NewExtras["ask"];
  const asked: RosterAgent[] = [];
  if (askIn) {
    const to: StoredParty[] = [];
    for (const { key } of askIn.to) {
      if (to.some((p) => p.key === key)) continue;
      const a = roster.find((r) => r.key === key);
      if (a) {
        to.push(storedAgent(a));
        asked.push(a);
        continue;
      }
      // A person who can read the artifact now.
      const user = isId(key) ? await getUser(env, key) : null;
      if (!user || !(await accessLevel(env, callerOf(user), artifactId)))
        throw unknownKey(key);
      to.push({ kind: "user", key: user.id });
    }
    ask = {
      question: askIn.question,
      options: askIn.options,
      ...(askIn.recommended ? { recommended: askIn.recommended } : {}),
      to,
    };
  }
  const agents = new Map<string, Resolved["agents"][number]>();
  for (const a of mentioned) agents.set(a.key, { agent: a, kind: "mention" });
  for (const a of asked) agents.set(a.key, { agent: a, kind: "ask" });
  if (assigned) agents.set(assigned.key, { agent: assigned, kind: "assign" });
  return {
    extras: {
      ...(ask ? { ask } : {}),
      ...(mentioned.length ? { mentions: mentioned.map(storedAgent) } : {}),
      ...(assigned ? { assign: storedAgent(assigned) } : {}),
    },
    agents: [...agents.values()],
    mentions: mentioned.map((m) => m.key),
    assign: assigned?.key ?? null,
  };
}

/**
 * How a notice's outcome reads on the comment. A held notice waits for the
 * machine ("queued"). A dropped one found no session: a mention reads "gone";
 * an assignment has no such state, so it stays "queued".
 */
const stateOf = (
  out: DeliveryState,
  assign: boolean,
): "delivered" | "queued" | "gone" =>
  out === "delivered"
    ? "delivered"
    : out === "held" || assign
      ? "queued"
      : "gone";

/**
 * Sends the notices of a written comment and records how each mention and the
 * assignment went. Returns the comment as then stored.
 */
async function deliver(
  env: Env,
  a: Pick<ArtifactRow, "id" | "currentVersion">,
  threadId: string,
  c: StoredComment,
  r: Resolved,
): Promise<StoredComment> {
  if (r.agents.length === 0) return c;
  const version = Math.max(1, a.currentVersion);
  const outcome = new Map<string, DeliveryState>();
  for (const { agent, kind } of r.agents)
    outcome.set(
      agent.key,
      await notifyAgent(env, a.id, version, c.id, kind, agent),
    );
  const states: { kind: "mention" | "assign"; key: string; state: string }[] =
    [];
  for (const key of r.mentions)
    states.push({
      kind: "mention",
      key,
      state: stateOf(outcome.get(key) ?? "dropped", false),
    });
  if (r.assign)
    states.push({
      kind: "assign",
      key: r.assign,
      state: stateOf(outcome.get(r.assign) ?? "dropped", true),
    });
  if (states.length === 0) return c;
  try {
    return await call(() =>
      stub(env, a.id).commentsTargetStates({
        threadId,
        commentId: c.id,
        states,
      }),
    );
  } catch (e) {
    // Deleted between the write and here: the comment was created and the
    // notices went out, so the POST stands (a retry would notify twice).
    if (e instanceof ApiError && e.code === "not_found") {
      logInfo("comment_deleted_before_delivery_record");
      return c;
    }
    throw e;
  }
}

/** A new thread: `raw` is the anchor as posted, `body` the first comment. 201 Thread. */
export async function addThread(
  env: Env,
  a: Pick<ArtifactRow, "id" | "format" | "currentVersion">,
  who: CommentWho,
  viewer: CommentViewer,
  raw: { anchor: unknown; body: unknown } & CommentExtras,
  opts: ExtrasOpts = {},
): Promise<Thread> {
  const body = checkBody(raw.body);
  const r = await resolveExtras(env, a.id, who, raw, opts);
  // The limit comes before any file is read, and a refused quote counts.
  let taken = false;
  const take = async () => {
    taken = true;
    await call(() => stub(env, a.id).commentsTake(rateKeyOf(who)));
  };
  const { anchor, version } = await checkAnchor(env, a, raw.anchor, take);
  if (!taken) await take();
  const t = await call(() =>
    stub(env, a.id).commentsAdd({
      actor: actorOf(who),
      rate: rateKeyOf(who),
      counted: true,
      anchor,
      version,
      body,
      ...(r.extras ? { extras: r.extras } : {}),
    }),
  );
  const root = t.comments[0];
  if (root && r.agents.length > 0) {
    const sent = await deliver(env, a, t.id, root, r);
    t.comments[0] = sent;
  }
  return (await threadViews(env, [t], viewer))[0] as Thread;
}

/** A reply. It does not reopen the thread. */
export async function addReply(
  env: Env,
  artifactId: string,
  threadId: string,
  who: CommentWho,
  viewer: CommentViewer,
  body: unknown,
  extras: CommentExtras = {},
  opts: ExtrasOpts = {},
): Promise<Comment> {
  const text = checkBody(body);
  const r = await resolveExtras(env, artifactId, who, extras, opts);
  const c = await call(() =>
    stub(env, artifactId).commentsReply({
      threadId,
      actor: actorOf(who),
      rate: rateKeyOf(who),
      body: text,
      ...(r.extras ? { extras: r.extras } : {}),
    }),
  );
  if (r.agents.length === 0) return commentView(env, c, viewer);
  const row = await stmt(
    env.DB,
    "select current_version as v from artifacts where id = ?",
  )
    .bind(artifactId)
    .first<{ v: number }>();
  const a = { id: artifactId, currentVersion: row?.v ?? 1 };
  return commentView(env, await deliver(env, a, threadId, c, r), viewer);
}

/**
 * Answers an ask (#1535): 404 without one, 403 unless the caller is asked,
 * 409 once the thread is resolved, 400 for an option the ask lacks. The
 * answer may change until then. `who` is the caller as an author (a guest is
 * never asked).
 */
export async function answerAsk(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho,
  viewer: CommentViewer,
  optionId: string,
): Promise<Comment> {
  const c = await call(() =>
    stub(env, artifactId).commentsAnswer({
      threadId,
      commentId,
      by: actorOf(who),
      optionId,
      rate: rateKeyOf(who),
    }),
  );
  return commentView(env, c, viewer);
}

/** The agents that can be mentioned, assigned or asked on the artifact. */
export async function artifactAgents(
  env: Env,
  artifactId: string,
  viewerId: string | null,
): Promise<{ key: string; name: string; online: boolean }[]> {
  return (await agentRoster(env, artifactId, viewerId, true)).map(
    ({ key, name, online }) => ({ key, name, online }),
  );
}

/** Resolve or reopen. */
export async function setStatus(
  env: Env,
  artifactId: string,
  threadId: string,
  who: CommentWho,
  viewer: CommentViewer,
  status: CommentStatus,
): Promise<Thread> {
  const t = await call(() =>
    stub(env, artifactId).commentsStatus({
      threadId,
      status,
      actor: actorOf(who),
      rate: rateKeyOf(who),
    }),
  );
  return (await threadViews(env, [t], viewer))[0] as Thread;
}

/** Edits a comment's body: its author only (403 forbidden). */
export async function editComment(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho,
  viewer: CommentViewer,
  body: unknown,
): Promise<Comment> {
  const text = checkBody(body);
  const a = actorOf(who);
  const c = await call(() =>
    stub(env, artifactId).commentsEdit({
      threadId,
      commentId,
      by: { kind: a.kind, ref: a.ref },
      body: text,
      rate: rateKeyOf(who),
    }),
  );
  return commentView(env, c, viewer);
}

/**
 * Deletes a comment. `who` is the caller as an author (null: a guest with no
 * id); `moderator`: the caller's level may delete anyone's (editor and up).
 * The root takes the whole thread with it, permanently.
 */
export async function deleteComment(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho | null,
  moderator: boolean,
): Promise<void> {
  const a = who ? actorOf(who) : null;
  await call(() =>
    stub(env, artifactId).commentsDelete({
      threadId,
      commentId,
      by: a ? { kind: a.kind, ref: a.ref } : null,
      moderator,
      ...(who ? { rate: rateKeyOf(who) } : {}),
    }),
  );
}
