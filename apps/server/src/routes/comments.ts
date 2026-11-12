import type { AccessLevel } from "@oa/shared";
import {
  ANON_ID_HEADER,
  AnswerBodySchema,
  COMMENT_KEY_RE,
  isId,
  NewThreadBodySchema,
  ReplyBodySchema,
} from "@oa/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { ArtifactRow } from "../auth/authz.js";
import {
  authorize,
  caller,
  callerOf,
  canCtx,
  capOfCaller,
  interactiveSession,
} from "../auth/authz.js";
import {
  can,
  capsReads,
  isGuestRole,
  type PolicyAction,
} from "../auth/policy.js";
import { readCapped } from "../http/body.js";
import { isEmbedRequest } from "../http/embed.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { readAnonId, resolveAnonId } from "../runtime/anon-id.js";
import { ipKey } from "../runtime/routes.js";
import type { AgentAttr } from "../services/agent-usage.js";
import {
  addReply,
  addThread,
  answerAsk,
  artifactAgents,
  type CommentViewer,
  type CommentWho,
  deleteComment,
  editComment,
  listComments,
  setStatus,
  setThreadAgent,
} from "../services/comments.js";
import { utf8Decoder } from "../util/text.js";
import type { AppType } from "./index.js";

// Comments on any artifact (#682, part 1): REST over the artifact's DO.
// The policy table is the floor (open access; writes by anyone who can open
// the artifact, a signed-out visitor on any public artifact, never a capped
// caller); the handlers add the embed refusal, comments_off, the per-IP limit
// on every signed-out write (post, reply, status, edit, delete) and who may
// edit or delete.

const ART = "/api/v1/artifacts/:id";
const COMMENTS = `${ART}/comments`;
const THREAD = `${COMMENTS}/:threadId`;
const REPLIES = `${THREAD}/replies`;
const COMMENT = `${THREAD}/comments/:commentId`;
const ANSWER = `${COMMENT}/answer`;
const AGENTS = `${ART}/agents`;
const THREAD_AGENT = `${THREAD}/agents/:key`;

/** A body is at most 2,000 characters; the anchor adds under 3 KB. */
const MAX_BODY = 32 * 1024;

/** Thread and comment ids are ids; anything else is not a resource. */
const idParam = (c: Context<AppEnv>, name: string): string => {
  const v = c.req.param(name);
  if (!v || !isId(v)) throw new ApiError("bad_request", `Invalid ${name}`);
  return v;
};

async function jsonOf(c: Context<AppEnv>): Promise<unknown> {
  const buf = await readCapped(c, MAX_BODY);
  try {
    return JSON.parse(utf8Decoder.decode(buf));
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
}

/** REST attribution: a token is an agent, named by its label (a blank one reads "Agent"). */
const agentOf = (c: Context<AppEnv>): AgentAttr | null =>
  c.var.tokenId
    ? {
        name: c.var.tokenLabel ?? "",
        version: null,
        via: { kind: "token", id: c.var.tokenId },
      }
    : null;

/**
 * Authorization shared by every comment route: access for `action` (404
 * otherwise), then no embeds (403), then comments on (403 comments_off).
 */
async function open(
  c: Context<AppEnv>,
  action: PolicyAction,
  /** A write even though the policy floor is read access (delete). */
  write = action === "comments.write",
) {
  const id = c.req.param("id") ?? "";
  const who = caller(c);
  const { level, artifact } = await authorize(c.env, who, id, action);
  if (isEmbedRequest(c.req.raw) || c.req.header("x-oa-embed") === "1")
    throw new ApiError("forbidden", "Comments are not available in an embed");
  if (artifact.comments !== 1)
    throw new ApiError("comments_off", "Comments are off for this artifact");
  // #2080: where only signed-in people may comment, a signed-out caller
  // (anonymous id header included) may read but never write.
  if (write && artifact.commentAccess === "signed-in" && !c.var.user)
    throw new ApiError("comments_signed_in_only", "Log in to comment.");
  return { id, who, level, artifact };
}

/** The signed-in person, or a signed-out visitor's anonymous identity (minted when `mint`). */
async function identity(
  c: Context<AppEnv>,
  artifactId: string,
  mint: boolean,
  moderator = false,
): Promise<{
  who: CommentWho | null;
  viewer: CommentViewer;
  issued: string | null;
}> {
  const user = c.var.user;
  if (user)
    return {
      who: {
        kind: "user",
        id: user.id,
        agent: agentOf(c),
        // From the credential kind: a browser session only (#1797). Never
        // from the body, nor from a missing agent (a PAT may carry no label).
        typed: interactiveSession(c),
      },
      viewer: {
        userId: user.id,
        short: null,
        moderator,
        guest: isGuestRole(user.role),
        capped: capsReads(capOfCaller(callerOf(user))),
        // #2224: a token is an agent, not the person: its `answer.yes` is for
        // asks that same agent posted. Only a browser session reads as the person.
        agent: interactiveSession(c) ? undefined : agentOf(c),
      },
      issued: null,
    };
  const token = c.req.header(ANON_ID_HEADER);
  if (!mint) {
    // Reads, edits, deletes and status changes: who a current token says; an
    // expired or v1 one says nobody. Never a new token.
    const short = await readAnonId(c.env, artifactId, token);
    return {
      who: null,
      viewer: { userId: null, short, moderator, guest: true },
      issued: null,
    };
  }
  const anon = await resolveAnonId(c.env, artifactId, token, true);
  if (!anon) throw new Error("anonId not minted");
  const viewer = { userId: null, short: anon.short, moderator, guest: true };
  // The per-IP key the DO limits by (10 a minute): an IPv6 address by its /64.
  const key = ipKey(c.req.header("cf-connecting-ip") ?? "");
  if (!key)
    throw new ApiError("rate_limited", "Anonymous access is unavailable");
  return {
    who: { kind: "guest", short: anon.short, rate: `ip:${key}` },
    viewer,
    issued: anon.issued,
  };
}

/** `res` carrying a newly minted anonymous id token, as data writes do. */
function withAnon(issued: string | null, res: Response): Response {
  if (!issued) return res;
  const out = new Response(res.body, res);
  out.headers.set(ANON_ID_HEADER, issued);
  out.headers.set("cache-control", "no-store");
  return out;
}

const StatusQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
});
const StatusPatch = z.strictObject({ status: z.enum(["open", "resolved"]) });
const EditBody = z.strictObject({ body: z.string() });

/** A body that failed its schema: the anchor's issues are invalid_anchor, the body's invalid_body. */
const bad = (issues: { path: PropertyKey[] }[]): never => {
  const first = issues[0]?.path[0];
  if (first === "anchor")
    throw new ApiError("invalid_anchor", "Invalid anchor", issues);
  if (first === "body")
    throw new ApiError(
      "invalid_body",
      "A comment is 1 to 2,000 characters after trimming",
    );
  throw new ApiError("bad_request", "Invalid request body", issues);
};

export function mountComments(app: AppType): void {
  app.get(COMMENTS, async (c) => {
    const {
      id,
      who: cw,
      level,
      artifact: art,
    } = await open(c, "comments.read");
    const q = StatusQuery.safeParse({
      status: c.req.query("status") ?? undefined,
    });
    if (!q.success) throw new ApiError("bad_request", "Invalid status");
    const { viewer } = await identity(c, id, false, modOf(cw, level, art));
    // #2080: a signed-out viewer under signed-in-only may edit and delete nothing.
    if (art.commentAccess === "signed-in" && !c.var.user)
      viewer.readOnly = true;
    const out = await listComments(c.env, id, q.data.status, {
      ...viewer,
      owner: level === "owner",
    });
    return c.json(out);
  });

  app.post(COMMENTS, async (c) => {
    const { id, artifact, who: cw, level } = await open(c, "comments.write");
    const raw = NewThreadBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const moderator = modOf(cw, level, artifact);
    mayTarget(raw.data, moderator);
    const { who, viewer, issued } = await identity(c, id, true, moderator);
    if (!who) throw new ApiError("unauthorized", "Log in to comment");
    const named = raw.data.guestName;
    const w: CommentWho =
      who.kind === "guest" && named !== undefined
        ? { ...who, name: named }
        : who;
    const t = await addThread(
      c.env,
      artifact,
      w,
      { ...viewer, owner: level === "owner" },
      raw.data,
      {
        moderator,
        after: { version: artifact.currentVersion, ctx: execCtx(c) },
      },
    );
    return withAnon(issued, c.json(t, 201));
  });

  app.post(REPLIES, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const raw = ReplyBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const moderator = modOf(cw, level, artifact);
    // toAsker stands alone (400), before the owner-and-editor check on mentions.
    if (raw.data.toAsker && (raw.data.mentions?.length ?? 0) > 0)
      throw new ApiError(
        "bad_request",
        "toAsker cannot be combined with mentions",
      );
    mayTarget(raw.data, moderator);
    const { who, viewer, issued } = await identity(c, id, true, moderator);
    if (!who) throw new ApiError("unauthorized", "Log in to comment");
    const w: CommentWho =
      who.kind === "guest" && raw.data.guestName !== undefined
        ? { ...who, name: raw.data.guestName }
        : who;
    const { mentions, toAsker } = raw.data;
    const out = await addReply(
      c.env,
      id,
      threadId,
      w,
      viewer,
      raw.data.body,
      { mentions, toAsker },
      {
        moderator,
        after: { version: artifact.currentVersion, ctx: execCtx(c) },
      },
    );
    return withAnon(issued, c.json(out, 201));
  });

  app.patch(THREAD, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const raw = StatusPatch.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    // No mint here: a guest resolves under the identity they commented with.
    const { who: signed, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    let who = signed;
    if (!who) {
      // A guest with no token still resolves, as "Guest" (me false), against
      // the per-IP limit.
      who = {
        kind: "guest",
        short: viewer.short ?? "",
        rate: guestRate(c),
      };
    }
    const out = await setStatus(
      c.env,
      id,
      threadId,
      who,
      { ...viewer, owner: level === "owner" },
      raw.data.status,
    );
    return c.json(out);
  });

  app.patch(COMMENT, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const raw = EditBody.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    // An author edits: a guest by the identity they wrote under, never minted here.
    const { who, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    const actor = who ?? guestOf(c, viewer);
    if (!actor)
      throw new ApiError("forbidden", "Only the author can edit a comment");
    const out = await editComment(
      c.env,
      id,
      threadId,
      commentId,
      actor,
      viewer,
      raw.data.body,
    );
    return c.json(out);
  });

  app.post(ANSWER, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const raw = AnswerBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    // Never minted: a guest has no key, so is never one of the people asked
    // (the DO answers 403 after 404, as for a signed-in stranger).
    const { who: signed, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    const who: CommentWho = signed ?? {
      kind: "guest",
      short: viewer.short ?? "",
      rate: guestRate(c),
    };
    const out = await answerAsk(
      c.env,
      id,
      threadId,
      commentId,
      who,
      viewer,
      raw.data.optionId,
      { version: artifact.currentVersion, ctx: execCtx(c) },
    );
    return c.json(out);
  });

  // The agents that can be mentioned: for the owner and editors,
  // who may; everyone else sees none (they are other people's agents).
  app.get(AGENTS, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.read");
    if (!modOf(cw, level, artifact)) return c.json([]);
    return c.json(
      await artifactAgents(
        c.env,
        id,
        c.var.user?.id ?? null,
        c.var.user ? isGuestRole(c.var.user.role) : true,
      ),
    );
  });

  // #2035: stop replies in a thread reaching one agent (DELETE), or undo (PUT).
  // The agent's own person or the artifact's owner; the service enforces it.
  for (const [method, removed] of [
    ["delete", true],
    ["put", false],
  ] as const)
    app[method](THREAD_AGENT, async (c) => {
      const { id, who: cw, level, artifact } = await open(c, "comments.write");
      const threadId = idParam(c, "threadId");
      const key = c.req.param("key") ?? "";
      if (!COMMENT_KEY_RE.test(key))
        throw new ApiError("bad_request", "Invalid key");
      const { viewer } = await identity(
        c,
        id,
        false,
        modOf(cw, level, artifact),
      );
      await setThreadAgent(
        c.env,
        id,
        threadId,
        key,
        { ...viewer, owner: level === "owner" },
        removed,
        execCtx(c),
      );
      return c.body(null, 204);
    });

  app.delete(COMMENT, async (c) => {
    const {
      id,
      who: callerWho,
      level,
      artifact,
    } = await open(c, "comments.read", true);
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const { who, viewer } = await identity(c, id, false);
    const actor = who ?? guestOf(c, viewer);
    const moderator = modOf(callerWho, level, artifact);
    await deleteComment(c.env, id, threadId, commentId, actor, moderator);
    return c.body(null, 204);
  });
}

/** The request's execution context, when the runtime has one (tests may not). */
const execCtx = (
  c: Context<AppEnv>,
): Pick<ExecutionContext, "waitUntil"> | undefined => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};

/** 403 forbidden for mentions from anyone but the owner and editors. */
function mayTarget(b: { mentions?: unknown[] }, moderator: boolean): void {
  if ((b.mentions?.length ?? 0) > 0 && !moderator)
    throw new ApiError("forbidden", "Only the owner and editors can mention");
}

/** Whether the caller's level may delete anyone's comment. */
const modOf = (
  who: ReturnType<typeof caller>,
  level: AccessLevel,
  artifact: ArtifactRow,
): boolean => can(level, "comments.moderate", canCtx(who, artifact));

/** The per-IP rate key of a signed-out write; the same refusal as identity() without one. */
function guestRate(c: Context<AppEnv>): string {
  const key = ipKey(c.req.header("cf-connecting-ip") ?? "");
  if (!key)
    throw new ApiError("rate_limited", "Anonymous access is unavailable");
  return `ip:${key}`;
}

/**
 * A guest who only reads back (no mint): as an author for edit and delete.
 * Null without a token. Carries the per-IP rate key, so the write counts.
 */
function guestOf(c: Context<AppEnv>, viewer: CommentViewer): CommentWho | null {
  return viewer.short === null
    ? null
    : { kind: "guest", short: viewer.short, rate: guestRate(c) };
}
