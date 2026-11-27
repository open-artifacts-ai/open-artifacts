import { z } from "zod";
import {
  anchorSchema,
  noteAnchorSchema,
  pinAnchorSchema,
  textAnchorSchema,
} from "./anchor.js";
import { IdSchema, PasskeyAssertionSchema } from "./schemas.js";

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
  /** A linked agent of a kind the server has no product for: the hub kind token, at most 32 characters (agy S6), for a letter tile. */
  appKind: z.string().optional(),
  /** A linked agent only: its face, from its identity. `color` is a presence palette index. */
  animal: z
    .object({ id: z.string(), color: z.number().int().min(0) })
    .optional(),
  /**
   * A linked agent only (#3132): the role its session holds, or held before
   * the role moved on. The role is the address to @-mention; `holder` is the
   * session that holds it now, when that is another one ("now <holder>").
   * Never shown to a guest or an outsider.
   */
  role: z
    .object({
      name: z.string(),
      holder: z.string().optional(),
      machine: z.string().optional(),
      holderMachine: z.string().optional(),
      holderProduct: z.string().optional(),
    })
    .optional(),
  /**
   * With `role` (#3132): `name` is the role, and this is the session's own
   * bus name, for the small print.
   */
  session: z.string().optional(),
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
/** #2895: the option id an agent may not use; "Something else" is the server's and the card's. */
export const OWN_WORDS_OPTION_ID = "other";
/** #2895: an answer in the person's own words is 1 to 1,000 characters after trimming. */
export const OWN_WORDS_MAX = 1000;
export const ASK_TO_MAX = 10;
export const MENTIONS_MAX = 10;

const key = z.string().regex(COMMENT_KEY_RE);
export const KeyRefSchema = z.object({ key });
export type KeyRef = z.infer<typeof KeyRefSchema>;

/**
 * #2263: the risky action an option carries out, named by the agent that
 * wrote the ask. The server turns the actions an ask names, and the member's
 * "ask for a passkey to approve" switches, into `confirm`. `command` is
 * running a command on the member's computer (always confirmed).
 */
export const ASK_ACTIONS = [
  "merge",
  "deploy",
  "delete",
  "share",
  "public",
  "command",
] as const;
export const AskActionSchema = z.enum(ASK_ACTIONS);
export type AskAction = z.infer<typeof AskActionSchema>;

export const AskOptionSchema = z.object({
  id: key,
  label: z.string().min(1).max(ASK_LABEL_MAX),
  detail: z.string().max(ASK_DETAIL_MAX).optional(),
  /** #2263: the risky action this option carries out. Only the author sets it; a pick on an ask whose options name an action the picker's switches cover needs their passkey. */
  action: AskActionSchema.optional(),
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

/** #2511: an ask on another artifact, named to replace it. */
export const ReplacesRefSchema = z.strictObject({
  artifactId: IdSchema,
  threadId: IdSchema,
  commentId: key,
});
export type ReplacesRef = z.infer<typeof ReplacesRefSchema>;

/** #2381: one person's current pick on an ask: a weigh-in, or the decision when `by` is the decider. */
export const AskPickSchema = z.object({
  by: CommentAuthorSchema,
  /** Absent on an answer in the person's own words (`ownWords`). */
  optionId: key.optional(),
  /** #2895: the pick is the person's own words, not an option. */
  ownWords: z.object({ text: z.string() }).optional(),
  at: z.string(),
  /** Picked in the web app (a browser session). */
  typed: z.boolean(),
  verified: z.literal("passkey").optional(),
  /** The picker is a guest-role member: input only, never a decider. Outsiders see the mark, not the role. */
  guest: z.boolean().optional(),
});
export type AskPick = z.infer<typeof AskPickSchema>;

/** An ask on a comment (#1535). `closed` means the thread is resolved. */
export const CommentAskSchema = z
  .object({
    question: z.string().min(1).max(ASK_QUESTION_MAX),
    options: askOptions,
    recommended: askRecommended,
    to: z.array(CommentAuthorSchema),
    /** #2381: who decides. Absent on a client built before it: read the asker's own user. */
    decider: CommentAuthorSchema.optional(),
    /** #2381: set when the asker named someone other than its own user as decider: the asker, as an author. */
    chosenBy: CommentAuthorSchema.optional(),
    /** #2381: the viewer's part: they decide, weigh in, or neither (absent). */
    role: z.enum(["decide", "weigh"]).optional(),
    /** #2512: when the viewer's own agent began waiting on this open ask (ISO). Only on an open ask the viewer's own agent posted, while it is blocked; absent for everyone else. */
    waitingSince: z.string().optional(),
    /** #2381: the asker's own user may say "I'll decide this" (decider is someone else, no decision yet). */
    canTakeBack: z.boolean().optional(),
    /** #2381: the latest pick of each person, oldest first. The decider's is the decision's source. */
    picks: z.array(AskPickSchema).optional(),
    /** #2323: the id of the ask this one replaces (a comment on this artifact, posted by the same asker). */
    replaces: key.optional(),
    /** #2323: the id of the ask that replaces this one. */
    replacedBy: key.optional(),
    /**
     * #2511: the asking agent (or its person) withdrew the ask before it had a
     * decision. No buttons, no picks (409 withdrawn), never a yes. `replacedBy`
     * names the card that replaces it on another page; `title` only when the
     * viewer can open that page.
     */
    withdrawn: z
      .object({
        at: z.string(),
        replacedBy: z
          .object({
            artifactId: IdSchema,
            threadId: IdSchema,
            commentId: key,
            title: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    /** The decision: the decider's pick (before #2381, the last pick of anyone asked). */
    answer: z
      .object({
        /** Absent on an answer in the person's own words (`ownWords`). */
        optionId: key.optional(),
        /** #2895: the decider answered in their own words, a typed message about this ask. Never a yes: `yes` is false. */
        ownWords: z.object({ text: z.string() }).optional(),
        by: CommentAuthorSchema,
        at: z.string(),
        /** #1797: picked in the web app (a browser session), never with a token. Only such an answer is a person's yes. */
        typed: z.boolean(),
        /** #2381: the decision this one changed: the decider's earlier, different pick. */
        was: z.object({ optionId: key, at: z.string() }).optional(),
        /** #2263: set by the server when a passkey assertion for this pick verified. */
        verified: z.literal("passkey").optional(),
        /**
         * #1797: your user's yes, computed for the caller by the server: typed,
         * picked by the caller's own person, on an ask the caller's own person
         * wrote (as themselves or through an agent). Never set by a client.
         */
        yes: z.boolean(),
      })
      .optional(),
    closed: z.boolean(),
    /** #2263: a pick needs the picker's passkey (POST R.commentAnswerChallenge, then R.commentAnswer with the assertion). Set by the server when the ask is created, from its options' actions and the addressees' switches; never by a client, never removed by an edit. */
    confirm: z.literal("passkey").optional(),
  })
  .refine(recommendedIsAnOption, recommendedMsg);
export type CommentAsk = z.infer<typeof CommentAskSchema>;

export const MentionDeliverySchema = z.enum([
  "delivered",
  "queued",
  "seen",
  "gone",
  "withdrawn",
]);
export type MentionDelivery = z.infer<typeof MentionDeliverySchema>;
/** #1890: a mentioned or asked agent's identity fields, as an author's (CommentAuthorSchema). Absent: unknown. */
const partyFace = {
  linked: z.boolean().optional(),
  product: z.string().optional(),
  appKind: z.string().optional(),
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
  /** Members only (#2004): an outsider gets no delivery state of an agent. */
  delivery: MentionDeliverySchema.optional(),
});
export type CommentMention = z.infer<typeof CommentMentionSchema>;
/** A thread agent a reply also told: members only, so the delivery is always there. */
export const CommentNotifiedSchema = CommentMentionSchema.required({
  delivery: true,
});
export type CommentNotified = z.infer<typeof CommentNotifiedSchema>;

/** The bytes of a comment picture (#2508): at most this many each, and this many to a comment. */
export const COMMENT_PICTURE_MAX_BYTES = 10 * 1024 * 1024;
export const COMMENT_PICTURES_MAX = 4;
/** Alt text: plain text, one line, at most this long. */
export const COMMENT_PICTURE_ALT_MAX = 200;
/** Per person: reservations a day, and reserved but not yet attached at once. */
export const COMMENT_PICTURE_RESERVATIONS_PER_DAY = 100;
export const COMMENT_PICTURE_PENDING_MAX = 20;
/** A picture no comment uses is deleted after this long. */
export const COMMENT_PICTURE_PENDING_TTL_MS = 60 * 60 * 1000;
/** unsupported_format message for a HEIC photo as a comment picture (OA Product). */
export const COMMENT_PICTURE_HEIC_MESSAGE =
  "This photo is in HEIC format. Save it as JPEG and try again.";

export const CommentPictureTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export type CommentPictureType = z.infer<typeof CommentPictureTypeSchema>;

/** A picture on a comment, as comments return it. */
export const CommentPictureSchema = z.object({
  id: z.string(),
  type: CommentPictureTypeSchema,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  bytes: z.number().int().positive(),
  alt: z.string().optional(),
});
export type CommentPicture = z.infer<typeof CommentPictureSchema>;

/** POST R.commentPictures body. The server reads w and h from the file; nothing a client says about them is used. */
export const CommentPictureReserveSchema = z.strictObject({
  type: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .toLowerCase()
    .optional(),
});
export type CommentPictureReserve = z.infer<typeof CommentPictureReserveSchema>;

export const CommentPictureReservedSchema = z.object({
  pictureId: z.string(),
  /** A signed PUT for the raw bytes; it answers the CommentPicture. */
  url: z.string(),
  expiresAt: z.string(),
});
export type CommentPictureReserved = z.infer<
  typeof CommentPictureReservedSchema
>;

/** A picture a new comment attaches: your own, uploaded, unattached, on this artifact. */
export const CommentPictureRefSchema = z.strictObject({
  pictureId: z.string().min(1).max(64),
  alt: z.string().max(COMMENT_PICTURE_ALT_MAX).optional(),
});
export type CommentPictureRef = z.infer<typeof CommentPictureRefSchema>;
const pictureRefs = z
  .array(CommentPictureRefSchema)
  .max(COMMENT_PICTURES_MAX)
  .optional();

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
  /** #2770: the people this comment @mentions (their faces), absent when none. */
  people: z.array(CommentAuthorSchema).optional(),
  /** #2035: the thread's agents a person's reply also told, with delivery. Members only. */
  notified: z.array(CommentNotifiedSchema).optional(),
  /** #2559: a non-fatal notice on the POST response only (a mention over the limit); never stored. */
  notice: z.string().optional(),
  /** #2508: up to 4 pictures; absent when there are none. */
  pictures: z.array(CommentPictureSchema).optional(),
  /**
   * #2577: per-target request facts, only on the asker's own typed comment read in their own browser
   * session (never another member's, an agent's or a guest's view). `key` is the agent's key (as in
   * `mentions`, `notified`, `ask.to`). `waiting_owner`: held for the agent's person to allow (a "Not now"
   * reads the same); `lapsesAt` is when it lapses (7 days after it was held), `lapsed` after that.
   * `offline`: the bus had recorded that agent as away when the notice was sent, and accepted it to wait for
   * it, and it has not been acknowledged since. A held notice, a dropped or failed send, a deleted address and
   * an unacknowledged send alone are never `offline`. A hold with no stored lapse time is never read as
   * waiting: it is `lapsed` by the comment's age, or left out. Absent when none apply.
   * The `delivery` fields stay as before.
   */
  requestFacts: z
    .array(
      z.object({
        key,
        status: z.enum(["waiting_owner", "lapsed", "offline"]),
        lapsesAt: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * #2577: on an agent's reply that named the request it answers (`requestCommentId`): the person who asked,
   * by public name. Set only when the server verified that request was delivered or released to the replying
   * agent itself, in this thread. Members only. Absent otherwise (never an error, never a guess).
   */
  askedBy: z.object({ name: z.string() }).optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

/** #2035: an agent the thread's replies reach. `canRemove`: the caller's person owns it, or owns the artifact. */
export const ThreadAgentSchema = z.object({
  key,
  name: z.string(),
  ...partyFace,
  /** The person the agent acts for. */
  for: z.string().optional(),
  canRemove: z.boolean(),
  /** #2174: a person took it out of this thread; it gets no replies until an @-mention or Undo. Absent when it is notified. */
  removed: z.boolean().optional(),
});
export type ThreadAgent = z.infer<typeof ThreadAgentSchema>;

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
  /** #2035: the agents replies in this thread reach. Absent for guests and anyone who cannot reply as a member. */
  agents: z.array(ThreadAgentSchema).optional(),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

export const CommentListSchema = z.object({
  threads: z.array(CommentThreadSchema),
  open: z.number().int().min(0),
  truncated: z.boolean(),
  /** #3168: opaque cursor for the next list_comments `since` read. */
  cursor: z.string().optional(),
});
export type CommentList = z.infer<typeof CommentListSchema>;

/** #2688: one answer to an ask of yours, in the compact catch-up read. */
export const CompactAnswerSchema = z.object({
  threadId: z.string(),
  commentId: z.string(),
  question: z.string(),
  /** Absent on an answer in the person's own words: `ownWords` holds the text. */
  optionId: z.string().optional(),
  label: z.string().optional(),
  ownWords: z.string().optional(),
  at: z.string(),
  by: z.string(),
  yes: z.boolean(),
});
export type CompactAnswer = z.infer<typeof CompactAnswerSchema>;

/** #2688: one comment that mentions you, in the compact catch-up read. */
export const CompactMentionSchema = z.object({
  threadId: z.string(),
  commentId: z.string(),
  at: z.string(),
  by: z.string(),
  excerpt: z.string(),
});
export type CompactMention = z.infer<typeof CompactMentionSchema>;

/** #2688: `list_comments` with `compact: true`. Each list is present when its `...Since` was asked. */
export const CompactCommentListSchema = z.object({
  answers: z.array(CompactAnswerSchema).optional(),
  mentions: z.array(CompactMentionSchema).optional(),
  truncated: z.boolean(),
  /** #3168: opaque cursor for the next list_comments `since` read. */
  cursor: z.string().optional(),
});
export type CompactCommentList = z.infer<typeof CompactCommentListSchema>;

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

/** With pictures a comment may have no text (#2508): empty or up to the same length. */
const commentBodyOrPictures = z.string().trim().max(COMMENT_BODY_MAX);
const guestName = z.string().max(COMMENT_GUEST_NAME_MAX).optional();

/**
 * An ask as a client sends it: addressees by key. MCP-only in v1: the REST
 * bodies (NewThreadBody, ReplyBody) do not take it.
 */
export const AskInputSchema = z
  .object({
    question: z.string().trim().min(1).max(ASK_QUESTION_MAX),
    options: optionRules(AskInputOptionSchema).refine(
      (o) => !o.some((x) => x.id === OWN_WORDS_OPTION_ID),
      {
        message: `The option id "${OWN_WORDS_OPTION_ID}" is reserved: every ask already offers "Something else"`,
      },
    ),
    recommended: askRecommended,
    to: z.array(KeyRefSchema).min(1).max(ASK_TO_MAX),
    /** #2381: a person (member who can edit the page) who decides. Default: the asker's own user. Never on an ask that names an action. */
    decider: KeyRefSchema.optional(),
    /**
     * #2323: the id of an earlier ask by the same asker that this one replaces
     * (on this artifact). #2511: or `{ artifactId, threadId, commentId }` for
     * an ask on another artifact you can edit; that card is withdrawn once this
     * one is posted.
     */
    replaces: z.union([key, ReplacesRefSchema]).optional(),
  })
  .refine(recommendedIsAnOption, recommendedMsg);
export type AskInput = z.infer<typeof AskInputSchema>;

/** Shared by NewThreadBody and ReplyBody (no ask: MCP-only in v1). mentions: owner and editors only (403 forbidden). */
const extras = {
  mentions: z.array(KeyRefSchema).max(MENTIONS_MAX).optional(),
  /**
   * #2770: people to @mention, by user id (R.artifactMentionCandidates lists them). Owner and
   * editors only (403 forbidden), like mentions; each must be able to read the page, else the
   * same 400 as an unknown agent. At most MENTIONS_MAX with `mentions` together. A mentioned
   * person gets the comment in "Needs you". A person in a browser only: a token, an agent or a
   * grant that sends `people` gets 400 (so an agent can't fill someone's Needs you). A sender
   * causes at most 200 such items a day; over it the comment posts and no more items are written.
   */
  people: z.array(key).max(MENTIONS_MAX).optional(),
};

/** POST R.comments body. */
export const NewThreadBodySchema = z
  .object({
    anchor: anchorInputSchema,
    body: commentBodyOrPictures,
    guestName,
    ...extras,
    /** #2508: pictures reserved with R.commentPictures. A comment with none needs text. */
    pictures: pictureRefs,
  })
  .refine((v) => v.body.length > 0 || (v.pictures?.length ?? 0) > 0, {
    path: ["body"],
    message: "A comment needs text or a picture",
  });
export type NewThreadBody = z.infer<typeof NewThreadBodySchema>;

/** POST R.commentReplies body. */
export const ReplyBodySchema = z
  .object({
    body: commentBodyOrPictures,
    guestName,
    ...extras,
    /** #2508: pictures reserved with R.commentPictures. A comment with none needs text. */
    pictures: pictureRefs,
    /** #2577: as add_comment's `requestCommentId`; only a verified agent's reply uses it. */
    requestCommentId: key.optional(),
  })
  .refine((v) => v.body.length > 0 || (v.pictures?.length ?? 0) > 0, {
    path: ["body"],
    message: "A comment needs text or a picture",
  });
export type ReplyBody = z.infer<typeof ReplyBodySchema>;

/** POST R.commentAnswer body. */
export const AnswerBodySchema = z.object({
  /** Either `optionId` or `ownWords`, never both (#2895). */
  optionId: key.optional(),
  /** #2895: "Something else": the person's own words, 1 to 1,000 characters after trimming. */
  ownWords: z.object({ text: z.string() }).optional(),
  /** #2263: the WebAuthn assertion (PublicKeyCredential.toJSON()) for the challenge of R.commentAnswerChallenge; required on an ask with confirm "passkey". */
  assertion: PasskeyAssertionSchema.optional(),
});
export type AnswerBody = z.infer<typeof AnswerBodySchema>;

/** POST R.commentAskDecider body (#2381): the asker's own user takes the decision back. */
export const TakeBackBodySchema = z.object({ takeBack: z.literal(true) });
export type TakeBackBody = z.infer<typeof TakeBackBodySchema>;
/** POST R.commentAnswerChallenge response (#2263): WebAuthn PublicKeyCredentialRequestOptionsJSON. */
export const AnswerChallengeSchema = z.object({
  options: z.object({ challenge: z.string() }).passthrough(),
  expiresAt: z.string(),
});
export type AnswerChallenge = z.infer<typeof AnswerChallengeSchema>;

/** GET R.artifactAgents: the agents that follow or publish to the artifact. */
export const ArtifactAgentSchema = z.object({
  key,
  /** #3132: the role it holds, when it holds one (then `session` is its own name). */
  name: z.string(),
  /** #3132: with a role as `name`, the session's own bus name, for the small print. */
  session: z.string().optional(),
  holderApp: z
    .object({ kind: z.string(), product: z.string().optional() })
    .optional(),
  heldSince: z.string().optional(),
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
  /** #2577: what asking this agent does for the viewer here and now: "listening" (it hears them: their own agents always, or an owner who lists them), "held" (the request waits for the owner to allow it), "off" (the owner's agents hear nobody outside; a mention is refused). Absent for a guest or signed-out viewer. */
  askState: z.enum(["listening", "held", "off"]).optional(),
});
export type ArtifactAgent = z.infer<typeof ArtifactAgentSchema>;

/** The longest `q` a mention candidates search takes. */
export const MENTION_CANDIDATES_Q_MAX = 40;
/** The most people one mention candidates answer holds. */
export const MENTION_CANDIDATES_MAX = 8;
/** POST R.artifactMentionCandidates body (#2770): the search, in the body so a typed address never reaches a URL or a log. */
export const MentionCandidatesBodySchema = z.strictObject({
  q: z.string().min(1).max(MENTION_CANDIDATES_Q_MAX),
});
export type MentionCandidatesBody = z.infer<typeof MentionCandidatesBodySchema>;
/** The answer to POST R.artifactMentionCandidates (#2770): people who can read the artifact, as faces (kind user, id, name; never an email). */
export const MentionCandidatesSchema = z.object({
  items: z.array(CommentAuthorSchema).max(MENTION_CANDIDATES_MAX),
});
export type MentionCandidates = z.infer<typeof MentionCandidatesSchema>;

/** MCP list_comments. Bounded like REST: at most 500 threads, 200 replies each (`truncated`). */
const SinceIso = z.string().datetime({ offset: true });

/** #2688: the catch-up read. Timestamps are ISO 8601 with a zone (for example 2026-11-19T10:00:00Z). */
export const ListCommentsInputSchema = z.strictObject({
  id: IdSchema,
  status: z.enum(["open", "resolved", "all"]).optional(),
  /** Only threads with an ask of yours whose answer came after this time. */
  answeredSince: SinceIso.optional(),
  /** Only comments after this time that mention you. */
  mentionedSince: SinceIso.optional(),
  /** With answeredSince or mentionedSince: a small list instead of full threads. */
  compact: z.boolean().optional(),
  /** #3139: only this thread (the id a comment notice names). */
  threadId: z.string().min(1).max(128).optional(),
  /** #3139: with threadId, only this comment, the comment before it and the thread's first comment. */
  commentId: z.string().min(1).max(128).optional(),
  /** #3168: opaque cursor from an earlier list_comments; only threads changed after it. */
  since: z.string().optional(),
});
export type ListCommentsInput = z.infer<typeof ListCommentsInputSchema>;

/** MCP get_comment_picture: a picture's id from a comment's `pictures` on list_comments. `pictureId` is checked after access, so a malformed one is bad_request. */
export const GetCommentPictureInputSchema = z.strictObject({
  id: IdSchema,
  pictureId: z.string(),
});
export type GetCommentPictureInput = z.infer<
  typeof GetCommentPictureInputSchema
>;

/** MCP add_comment: a reply when `threadId` is given, else a new thread (anchor defaults to a note on the whole artifact). */
export const AddCommentInputSchema = z.strictObject({
  id: IdSchema,
  body: z.string(),
  threadId: IdSchema.optional(),
  anchor: anchorInputSchema.optional(),
  /** Turns the comment into an ask (#1535): owner and editors only. */
  ask: AskInputSchema.optional(),
  /**
   * #2577: a reply only. The id of the comment (in this thread) that asked you, when you are answering a
   * request you took from a notice. The reply then shows who asked, but only if that request was delivered
   * to you in this thread. Otherwise it is ignored; nothing is refused.
   */
  requestCommentId: key.optional(),
  /** #3163: true returns the full comment or thread, as before. */
  verbose: z
    .boolean()
    .optional()
    .describe("true returns the full comment or thread, as before"),
});
export type AddCommentInput = z.infer<typeof AddCommentInputSchema>;

/** MCP withdraw_ask (#2511): withdraw an ask you posted before it has a decision. `replacedBy` names the card that replaces it (finishes a cross-page replace). */
export const WithdrawAskInputSchema = z.strictObject({
  id: IdSchema,
  threadId: IdSchema,
  commentId: key,
  replacedBy: ReplacesRefSchema.optional(),
  /** #3163: true returns the full comment or thread, as before. */
  verbose: z
    .boolean()
    .optional()
    .describe("true returns the full comment or thread, as before"),
});
export type WithdrawAskInput = z.infer<typeof WithdrawAskInputSchema>;

/** POST R.commentWithdraw body (#2511). */
export const WithdrawBodySchema = z.strictObject({
  replacedBy: ReplacesRefSchema.optional(),
});
export type WithdrawBody = z.infer<typeof WithdrawBodySchema>;

/** MCP edit_comment (#2511): the text of your own comment (an ask's question and options are never editable). */
export const EditCommentInputSchema = z.strictObject({
  id: IdSchema,
  threadId: IdSchema,
  commentId: key,
  body: z.string(),
});
export type EditCommentInput = z.infer<typeof EditCommentInputSchema>;

/** MCP resolve_comment: `resolved` false reopens the thread. */
export const ResolveCommentInputSchema = z.strictObject({
  id: IdSchema,
  threadId: IdSchema,
  resolved: z.boolean().optional(),
  /** #3163: true returns the full comment or thread, as before. */
  verbose: z
    .boolean()
    .optional()
    .describe("true returns the full comment or thread, as before"),
});
export type ResolveCommentInput = z.infer<typeof ResolveCommentInputSchema>;
