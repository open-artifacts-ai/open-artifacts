import type { AccessLevel } from "@oa/shared";
import {
  ANON_ID_HEADER,
  AnswerBodySchema,
  ASK_SLOT_HOMES_MAX,
  type AskSlot,
  COMMENT_KEY_RE,
  isId,
  MentionCandidatesBodySchema,
  NewThreadBodySchema,
  OWN_WORDS_MAX,
  ReplyBodySchema,
  TakeBackBodySchema,
  WithdrawBodySchema,
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
  meetsLevel,
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
import { pageTitles, slotsOfPage } from "../services/ask-slots.js";
import {
  addReply,
  addThread,
  answerAsk,
  answerChallenge,
  artifactAgents,
  type CommentViewer,
  type CommentWho,
  deleteComment,
  editComment,
  listComments,
  setStatus,
  setThreadAgent,
  takeBackAsk,
  withdrawAsk,
} from "../services/comments.js";
import { mentionCandidates } from "../services/mention-candidates.js";
import { isGuestMember, isOutsideMember } from "../services/mention-guards.js";
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
const ANSWER_CHALLENGE = `${ANSWER}/challenge`;
const ASK_DECIDER = `${COMMENT}/ask/decider`;
const WITHDRAW = `${COMMENT}/withdraw`;
const ASK_SLOTS = `${ART}/ask-slots`;
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
export async function open(
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
        // #2511: the request's own caller, for checks on another artifact.
        caller: callerOf(user),
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
  // #2688: the catch-up read, as on the MCP list_comments.
  answeredSince: z.string().datetime({ offset: true }).optional(),
  mentionedSince: z.string().datetime({ offset: true }).optional(),
  compact: z.enum(["true", "false"]).optional(),
});
const StatusPatch = z.strictObject({ status: z.enum(["open", "resolved"]) });
const EditBody = z.strictObject({ body: z.string() });
const ChallengeBodySchema = z.strictObject({
  optionId: z.string().regex(COMMENT_KEY_RE),
});

/**
 * #2895: the pick in an answer body: an option, or the person's own words
 * (trimmed, 1 to 1,000 characters). Both, or neither, is a 400; so is
 * `ownWords.text` empty or too long, with the path and the reason in details.
 */
function pickOf(b: {
  optionId?: string;
  ownWords?: { text: string };
}): string | { ownWords: string } {
  if (b.ownWords === undefined) {
    if (b.optionId === undefined)
      throw new ApiError(
        "bad_request",
        "Pick an option or answer in your own words",
      );
    return b.optionId;
  }
  if (b.optionId !== undefined)
    throw new ApiError("bad_request", "Send optionId or ownWords, not both");
  const text = b.ownWords.text.trim();
  if (text.length === 0)
    throw new ApiError("bad_request", "Say what you'd like instead", {
      path: "ownWords.text",
      reason: "empty",
    });
  if (text.length > OWN_WORDS_MAX)
    throw new ApiError(
      "bad_request",
      `Your own words are at most ${OWN_WORDS_MAX} characters`,
      { path: "ownWords.text", reason: "too_long" },
    );
  return { ownWords: text };
}

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
      answeredSince: c.req.query("answeredSince") ?? undefined,
      mentionedSince: c.req.query("mentionedSince") ?? undefined,
      compact: c.req.query("compact") ?? undefined,
    });
    if (!q.success)
      throw new ApiError(
        "bad_request",
        "Invalid status, answeredSince, mentionedSince or compact",
      );
    const { answeredSince, mentionedSince } = q.data;
    const compact = q.data.compact === "true";
    if (compact && answeredSince === undefined && mentionedSince === undefined)
      throw new ApiError(
        "bad_request",
        "compact needs answeredSince or mentionedSince.",
      );
    const { viewer } = await identity(c, id, false, modOf(cw, level, art));
    // #2080: a signed-out viewer under signed-in-only may edit and delete nothing.
    if (art.commentAccess === "signed-in" && !c.var.user)
      viewer.readOnly = true;
    const v = { ...viewer, owner: level === "owner" };
    if (answeredSince === undefined && mentionedSince === undefined)
      return c.json(await listComments(c.env, id, q.data.status, v));
    return c.json(
      await listComments(c.env, id, q.data.status, v, {
        ...(answeredSince !== undefined ? { answeredSince } : {}),
        ...(mentionedSince !== undefined ? { mentionedSince } : {}),
        ...(compact ? { compact } : {}),
      }),
    );
  });

  // #2426 B, #2536: the asks this viewer may see in the page's [data-oa-ask]
  // slots (the contract, jp3RtzkygV1sijvM, section 2). Per viewer and
  // server-filtered: a slot whose home page this viewer cannot open is left
  // out, never masked, and so is every slot of a signed-out visitor's page.
  app.get(ASK_SLOTS, async (c) => {
    const { id, who } = await open(c, "comments.read");
    if (!c.var.user) return c.json([]);
    const slots = await slotsOfPage(c.env, id);
    if (!slots.length) return c.json([]);
    // One read per home page, at most ASK_SLOT_HOMES_MAX of them: a page with
    // twenty slots from twenty pages must not fan out over the instance.
    const byHome = new Map<string, typeof slots>();
    for (const s of slots) {
      if (!byHome.has(s.homeArtifactId) && byHome.size >= ASK_SLOT_HOMES_MAX)
        continue;
      const list = byHome.get(s.homeArtifactId) ?? [];
      list.push(s);
      byHome.set(s.homeArtifactId, list);
    }
    const titles = await pageTitles(c.env, [...byHome.keys()]);
    const out: AskSlot[] = [];
    for (const [homeId, rows] of byHome) {
      const title = titles.get(homeId);
      // A page row is gone: nothing to show, and nothing to leak.
      if (title === undefined) continue;
      // This viewer cannot open the home, or it is deleted: nothing, not a mask.
      const home = await authorize(c.env, who, homeId, "comments.read", {
        allowDeleted: true,
      }).catch(() => null);
      if (!home || home.artifact.deletedAt != null) continue;
      if (home.artifact.comments !== 1) continue;
      const owner = meetsLevel(home.level, "owner");
      const { viewer } = await identity(c, homeId, false, owner);
      const list = await listComments(c.env, homeId, "all", {
        ...viewer,
        owner,
      });
      for (const row of rows) {
        const thread = list.threads.find((t) => t.id === row.threadId);
        const comment = thread?.comments.find((x) => x.id === row.commentId);
        // A withdrawn, deleted or replaced ask is gone from the thread: the
        // slot is left out, never a stale open card. A decision stays, so the
        // card can show "Decided".
        if (!comment?.ask || comment.ask.withdrawn) continue;
        out.push({
          key: row.key,
          home: { artifactId: homeId, title },
          threadId: row.threadId,
          commentId: row.commentId,
          ask: comment.ask,
          author: comment.author,
          ...(row.note ? { note: row.note } : {}),
          ...(row.placedBy || row.placedAgent
            ? {
                placer: {
                  ...(row.placedBy ? { id: row.placedBy } : {}),
                  ...(row.placedAgent ? { agent: row.placedAgent } : {}),
                },
              }
            : {}),
        });
      }
    }
    // Key order, so a page's slots read the same way every time.
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return c.json(out);
  });

  app.post(COMMENTS, async (c) => {
    const { id, artifact, who: cw, level } = await open(c, "comments.write");
    const raw = NewThreadBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const moderator = modOf(cw, level, artifact);
    mayTarget(raw.data, moderator);
    peopleByPerson(c, raw.data);
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
    if (
      raw.data.toAsker &&
      (raw.data.mentions?.length ?? 0) + (raw.data.people?.length ?? 0) > 0
    )
      throw new ApiError(
        "bad_request",
        "toAsker cannot be combined with mentions",
      );
    mayTarget(raw.data, moderator);
    peopleByPerson(c, raw.data);
    const { who, viewer, issued } = await identity(c, id, true, moderator);
    if (!who) throw new ApiError("unauthorized", "Log in to comment");
    const w: CommentWho =
      who.kind === "guest" && raw.data.guestName !== undefined
        ? { ...who, name: raw.data.guestName }
        : who;
    const { mentions, people, toAsker } = raw.data;
    const out = await addReply(
      c.env,
      id,
      threadId,
      w,
      viewer,
      raw.data.body,
      { mentions, people, toAsker, pictures: raw.data.pictures },
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
    const pick = pickOf(raw.data);
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
      pick,
      { version: artifact.currentVersion, ctx: execCtx(c) },
      // #2263: only a browser session can carry a passkey assertion.
      { interactive: interactiveSession(c), assertion: raw.data.assertion },
      // #2381: a decider must edit the page; a guest-role member's pick is marked.
      {
        canDecide: meetsLevel(level, "editor"),
        guest: capsReads(capOfCaller(cw)),
      },
    );
    return c.json(out);
  });

  // #2381: the asker's own user takes the decision back.
  app.post(ASK_DECIDER, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const raw = TakeBackBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const { who, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    if (!who)
      throw new ApiError("forbidden", "Only the person who asked can do this");
    return c.json(
      await takeBackAsk(c.env, id, threadId, commentId, who, viewer),
    );
  });

  // #2511: the asker withdraws its ask before any decision.
  app.post(WITHDRAW, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const raw = WithdrawBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const { who, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    if (!who)
      throw new ApiError("forbidden", "Only the person who asked can do this");
    return c.json(
      await withdrawAsk(
        c.env,
        id,
        threadId,
        commentId,
        who,
        viewer,
        raw.data.replacedBy,
      ),
    );
  });

  // #2263: the WebAuthn challenge for a pick on a confirm ask.
  app.post(ANSWER_CHALLENGE, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const raw = ChallengeBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const { who: signed } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    // A guest is never asked: the same 403 the answer gives.
    if (!signed)
      throw new ApiError("forbidden", "Only the people asked can answer");
    return c.json(
      await answerChallenge(
        c.env,
        id,
        threadId,
        commentId,
        signed,
        raw.data.optionId,
        interactiveSession(c),
      ),
    );
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

  // #2770: who can be @mentioned: owner and editors, as they alone may mention;
  // everyone else sees none. Guests and outside members name no one.
  app.post(`${ART}/mention-candidates`, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const user = c.var.user;
    if (!user || !modOf(cw, level, artifact)) return c.json({ items: [] });
    const { viewer } = await identity(c, id, false, true);
    if (
      (await isGuestMember(c.env, user.id)) ||
      (await isOutsideMember(c.env, user.id))
    )
      return c.json({ items: [] });
    const raw = MentionCandidatesBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    return c.json(await mentionCandidates(c.env, id, user, viewer, raw.data.q));
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

/**
 * #2770: people are @mentioned by a person in a browser only. A token, an
 * agent or a grant carrying `people` is a 400, so no agent can fill someone's
 * Needs you.
 */
function peopleByPerson(c: Context<AppEnv>, b: { people?: unknown[] }): void {
  if ((b.people?.length ?? 0) > 0 && !interactiveSession(c))
    throw new ApiError(
      "bad_request",
      "people can only be mentioned from the web app, not with a token or an agent",
    );
}

/** 403 forbidden for mentions from anyone but the owner and editors. */
function mayTarget(
  b: { mentions?: unknown[]; people?: unknown[] },
  moderator: boolean,
): void {
  if ((b.mentions?.length ?? 0) + (b.people?.length ?? 0) > 0 && !moderator)
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
