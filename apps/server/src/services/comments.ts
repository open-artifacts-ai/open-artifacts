import {
  type Anchor,
  type AnchorInput,
  anchorInputSchema,
  type Comment,
  type CommentAuthor,
  type CommentList,
  type CommentThread as Thread,
} from "@oa/shared";
import type { ArtifactRow } from "../auth/authz.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import {
  bodyOk,
  type StoredActor,
  type StoredComment,
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
import { verifyQuote, versionExists } from "./comment-anchor.js";
import {
  CONTENT_HASH_RE,
  type CommentStatus,
  cleanGuestName,
} from "./comment-rules.js";
import { effectiveName } from "./users.js";

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
  env: Pick<Env, "DB" | "FILES">,
  a: Pick<ArtifactRow, "id" | "format" | "currentVersion">,
  raw: unknown,
): Promise<CheckedAnchor> {
  const p = anchorInputSchema.safeParse(raw);
  if (!p.success)
    throw new ApiError("invalid_anchor", "Invalid anchor", p.error.issues);
  const input: AnchorInput = p.data;
  const current = Math.max(1, a.currentVersion);
  if (input.kind === "note") return { anchor: input, version: current };
  const version = input.version ?? current;
  if (input.kind === "pin") {
    if (!CONTENT_HASH_RE.test(input.contentHash))
      throw new ApiError("invalid_anchor", "Invalid anchor", [
        { path: ["contentHash"], message: "Invalid contentHash" },
      ]);
    if (!(await versionExists(env, a.id, version)))
      throw new ApiError(
        "anchor_not_in_version",
        "That version does not exist",
      );
    return { anchor: { ...input, version }, version };
  }
  const found = await verifyQuote(env, a.id, a.format, version, input);
  return {
    anchor: {
      ...input,
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
    for (const c of t.comments)
      if (c.author.kind === "user") ids.add(c.author.ref);
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
  };
};

async function commentView(
  env: Env,
  c: StoredComment,
  viewer: CommentViewer,
): Promise<Comment> {
  const users = await usersById(
    env,
    c.author.kind === "user" ? [c.author.ref] : [],
  );
  return commentOf(c, viewer, users);
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

/** A new thread: `raw` is the anchor as posted, `body` the first comment. 201 Thread. */
export async function addThread(
  env: Env,
  a: Pick<ArtifactRow, "id" | "format" | "currentVersion">,
  who: CommentWho,
  viewer: CommentViewer,
  raw: { anchor: unknown; body: unknown },
): Promise<Thread> {
  const body = checkBody(raw.body);
  const { anchor, version } = await checkAnchor(env, a, raw.anchor);
  const t = await call(() =>
    stub(env, a.id).commentsAdd({
      actor: actorOf(who),
      rate: rateKeyOf(who),
      anchor,
      version,
      body,
    }),
  );
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
): Promise<Comment> {
  const text = checkBody(body);
  const c = await call(() =>
    stub(env, artifactId).commentsReply({
      threadId,
      actor: actorOf(who),
      rate: rateKeyOf(who),
      body: text,
    }),
  );
  return commentView(env, c, viewer);
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
      ...(who.kind === "guest" ? { rate: who.rate } : {}),
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
      ...(who.kind === "guest" ? { rate: who.rate } : {}),
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
      ...(who?.kind === "guest" ? { rate: who.rate } : {}),
    }),
  );
}
