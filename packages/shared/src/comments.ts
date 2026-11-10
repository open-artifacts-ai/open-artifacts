import { z } from "zod";
import {
  anchorSchema,
  noteAnchorSchema,
  pinAnchorSchema,
  textAnchorSchema,
} from "./anchor.js";
import { IdSchema } from "./schemas.js";

// Comments REST contract (#682): /api/v1/artifacts/:id/comments. The shell and
// the MSW mocks build against these; the Backend implements the same shapes.

export const COMMENT_BODY_MAX = 2000;
export const COMMENT_GUEST_NAME_MAX = 50;

export const CommentAuthorSchema = z.object({
  /**
   * `agent` (#1789): written over MCP or with a token, never a person. The
   * server sets it; no client input can.
   */
  kind: z.enum(["user", "guest", "agent"]),
  /** A user's id; for an agent, the member it acts for (in an ask's `to`, the agent's roster key). */
  id: z.string().optional(),
  /** An agent's own name (never the person's), a guest's name, or a user's name. */
  name: z.string(),
  /** An agent only: the person it acts for, by public name (never an email). */
  for: z.string().optional(),
  /** An agent only: a bus-linked agent (#1822). False for a connection the server cannot tell apart. */
  linked: z.boolean().optional(),
  /** A linked agent only: its product (for example "Claude Code"), from the bus, never client input. */
  product: z.string().optional(),
  /** A linked agent only: its face, from its identity. `color` is a presence palette index. */
  animal: z
    .object({ id: z.string(), color: z.number().int().min(0) })
    .optional(),
  /** @deprecated Old "via <label>"; the server no longer sets it (`kind: "agent"` carries the name). */
  agent: z.string().optional(),
  me: z.boolean(),
});
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

/** #1535: a person or agent key, as R.artifactAgents lists it. */
export const COMMENT_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const ASK_QUESTION_MAX = 1000;
export const ASK_LABEL_MAX = 120;
export const ASK_DETAIL_MAX = 500;
export const ASK_WHY_MAX = 500;
export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 6;
export const ASK_TO_MAX = 10;
export const MENTIONS_MAX = 10;

const key = z.string().regex(COMMENT_KEY_RE);
export const KeyRefSchema = z.object({ key });
export type KeyRef = z.infer<typeof KeyRefSchema>;

export const AskOptionSchema = z.object({
  id: key,
  label: z.string().min(1).max(ASK_LABEL_MAX),
  detail: z.string().max(ASK_DETAIL_MAX).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

const optionRules = <T extends z.ZodType<{ id: string }>>(item: T) =>
  z
    .array(item)
    .min(ASK_OPTIONS_MIN)
    .max(ASK_OPTIONS_MAX)
    .refine((o) => new Set(o.map((x) => x.id)).size === o.length, {
      message: "Option ids must be unique",
    });
const askOptions = optionRules(AskOptionSchema);
/** An option as a client sends it: the label is trimmed and must not be blank. */
const AskInputOptionSchema = AskOptionSchema.extend({
  label: z.string().trim().min(1).max(ASK_LABEL_MAX),
});
const askRecommended = z
  .object({ optionId: key, why: z.string().max(ASK_WHY_MAX) })
  .optional();
const recommendedIsAnOption = (a: {
  options: { id: string }[];
  recommended?: { optionId: string };
}) =>
  a.recommended === undefined ||
  a.options.some((o) => o.id === a.recommended?.optionId);
const recommendedMsg = {
  message: "recommended.optionId must be one of the options",
  path: ["recommended", "optionId"],
};

/** An ask on a comment (#1535). `closed` means the thread is resolved. */
export const CommentAskSchema = z
  .object({
    question: z.string().min(1).max(ASK_QUESTION_MAX),
    options: askOptions,
    recommended: askRecommended,
    to: z.array(CommentAuthorSchema),
    answer: z
      .object({
        optionId: key,
        by: CommentAuthorSchema,
        at: z.string(),
        /** #1797: picked in the web app (a browser session), never with a token. Only such an answer is a person's yes. */
        typed: z.boolean(),
        /**
         * #1797: your user's yes, computed for the caller by the server: typed,
         * picked by the caller's own person, on an ask the caller's own person
         * wrote (as themselves or through an agent). Never set by a client.
         */
        yes: z.boolean(),
      })
      .optional(),
    closed: z.boolean(),
  })
  .refine(recommendedIsAnOption, recommendedMsg);
export type CommentAsk = z.infer<typeof CommentAskSchema>;

export const MentionDeliverySchema = z.enum([
  "delivered",
  "queued",
  "seen",
  "gone",
]);
/** #1890: a mentioned or asked agent's identity fields, as an author's (CommentAuthorSchema). Absent: unknown. */
const partyFace = {
  linked: z.boolean().optional(),
  product: z.string().optional(),
  animal: z
    .object({ id: z.string(), color: z.number().int().min(0) })
    .optional(),
};
export const CommentMentionSchema = z.object({
  key,
  name: z.string(),
  ...partyFace,
  /** The person the agent acts for, set by the server (#1822). */
  for: z.string().optional(),
  delivery: MentionDeliverySchema,
});
export type CommentMention = z.infer<typeof CommentMentionSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: CommentAuthorSchema,
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  /**
   * #1797: typed by a person in the web app (a browser session, no token, no
   * MCP). Set by the server from the credential; no client input can. Old
   * comments read false.
   */
  typed: z.boolean(),
  can: z.object({ edit: z.boolean(), delete: z.boolean() }),
  ask: CommentAskSchema.optional(),
  mentions: z.array(CommentMentionSchema).optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentThreadSchema = z.object({
  id: z.string(),
  anchor: anchorSchema,
  version: z.number().int().min(1),
  status: z.enum(["open", "resolved"]),
  resolvedBy: CommentAuthorSchema.nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  /** The first comment is the root. */
  comments: z.array(CommentSchema),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

export const CommentListSchema = z.object({
  threads: z.array(CommentThreadSchema),
  open: z.number().int().min(0),
  truncated: z.boolean(),
});
export type CommentList = z.infer<typeof CommentListSchema>;

export type CommentStatusFilter = "open" | "resolved" | "all";

/** An anchor as a client sends it: `version` is optional on text and pin (the current version). */
export const anchorInputSchema = z.discriminatedUnion("kind", [
  noteAnchorSchema,
  textAnchorSchema.extend({
    version: textAnchorSchema.shape.version.optional(),
  }),
  // The server stamps a pin's contentHash itself and overwrites a sent one (#1490);
  // a value that is not a sha256 hex digest is refused (400 invalid_anchor).
  pinAnchorSchema.extend({
    version: pinAnchorSchema.shape.version.optional(),
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
]);
export type AnchorInput = z.infer<typeof anchorInputSchema>;

const commentBody = z.string().trim().min(1).max(COMMENT_BODY_MAX);
const guestName = z.string().max(COMMENT_GUEST_NAME_MAX).optional();

/**
 * An ask as a client sends it: addressees by key. MCP-only in v1: the REST
 * bodies (NewThreadBody, ReplyBody) do not take it.
 */
export const AskInputSchema = z
  .object({
    question: z.string().trim().min(1).max(ASK_QUESTION_MAX),
    options: optionRules(AskInputOptionSchema),
    recommended: askRecommended,
    to: z.array(KeyRefSchema).min(1).max(ASK_TO_MAX),
  })
  .refine(recommendedIsAnOption, recommendedMsg);
export type AskInput = z.infer<typeof AskInputSchema>;

/** Shared by NewThreadBody and ReplyBody (no ask: MCP-only in v1). mentions: owner and editors only (403 forbidden). */
const extras = {
  mentions: z.array(KeyRefSchema).max(MENTIONS_MAX).optional(),
};

/** POST R.comments body. */
export const NewThreadBodySchema = z.object({
  anchor: anchorInputSchema,
  body: commentBody,
  guestName,
  ...extras,
});
export type NewThreadBody = z.infer<typeof NewThreadBodySchema>;

/** POST R.commentReplies body. */
export const ReplyBodySchema = z.object({
  body: commentBody,
  guestName,
  ...extras,
  /**
   * Address the reply to the thread root's ask author (#1614): anyone who may
   * reply, viewers included. 400 not_an_ask when the root has no ask or its
   * author is not an agent; 400 with mentions or assign. Its agents get a
   * fixed notice; `mentions` on the returned comment says who and how it went.
   */
  toAsker: z.boolean().optional(),
});
export type ReplyBody = z.infer<typeof ReplyBodySchema>;

/** POST R.commentAnswer body. */
export const AnswerBodySchema = z.object({ optionId: key });
export type AnswerBody = z.infer<typeof AnswerBodySchema>;

/** GET R.artifactAgents: the agents that follow or publish to the artifact. */
export const ArtifactAgentSchema = z.object({
  key,
  name: z.string(),
  /** `state === "online"`; kept for readers that predate `state`. */
  online: z.boolean(),
  /** The session itself: online (live now) or away (listed on the bus, not live). Ended sessions are not listed. */
  state: z.enum(["online", "away"]).optional(),
  /** When an away session was last active (ISO); the viewer's own agents only, null otherwise. */
  lastActiveAt: z.string().nullable().optional(),
  /** The machine's short name, for the viewer's own agents only; null otherwise. */
  machine: z.string().nullable().optional(),
  /** The owner's public name for another member's agent; null for the viewer's own. */
  owner: z.string().nullable().optional(),
});
export type ArtifactAgent = z.infer<typeof ArtifactAgentSchema>;

/** MCP list_comments. Bounded like REST: at most 500 threads, 200 replies each (`truncated`). */
export const ListCommentsInputSchema = z.strictObject({
  id: IdSchema,
  status: z.enum(["open", "resolved", "all"]).optional(),
});
export type ListCommentsInput = z.infer<typeof ListCommentsInputSchema>;

/** MCP add_comment: a reply when `threadId` is given, else a new thread (anchor defaults to a note on the whole artifact). */
export const AddCommentInputSchema = z.strictObject({
  id: IdSchema,
  body: z.string(),
  threadId: IdSchema.optional(),
  anchor: anchorInputSchema.optional(),
  /** Turns the comment into an ask (#1535): owner and editors only. */
  ask: AskInputSchema.optional(),
});
export type AddCommentInput = z.infer<typeof AddCommentInputSchema>;

/** MCP resolve_comment: `resolved` false reopens the thread. */
export const ResolveCommentInputSchema = z.strictObject({
  id: IdSchema,
  threadId: IdSchema,
  resolved: z.boolean().optional(),
});
export type ResolveCommentInput = z.infer<typeof ResolveCommentInputSchema>;
