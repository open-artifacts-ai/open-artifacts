import { z } from "zod";
import { PasskeyAssertionSchema } from "./schemas.js";

// #2577: asking someone else's agent. A request to another person's agent is
// held until that person allows it. Schemas of the receiver's routes.

/** How long a held request waits before it lapses (ms). */
export const HELD_LAPSE_MS = 7 * 24 * 60 * 60 * 1000;
/** "Not now" quiets a sender's requests for this long (ms). */
export const HELD_QUIET_MS = 24 * 60 * 60 * 1000;
/** "Allow on this page": how long the entry lasts (ms). */
export const LISTEN_PAGE_MS = 30 * 24 * 60 * 60 * 1000;
/** "Allow on all pages": the choices of days, and the longest. */
export const LISTEN_ALL_DAYS = [30, 90, 365] as const;
export const LISTEN_MAX_MS = 365 * 24 * 60 * 60 * 1000;
/** What one allow may pass. */
export const ALLOW_ITEMS_MAX = 50;

/** Where a held request came in. */
export const HeldWaySchema = z.enum(["mention", "reply", "ask", "page"]);
export type HeldWay = z.infer<typeof HeldWaySchema>;

/** One held comment, as the receiver sees it: the current words, word for word. */
export const HeldItemSchema = z.strictObject({
  commentId: z.string(),
  threadId: z.string(),
  agentKey: z.string(),
  agentName: z.string(),
  way: HeldWaySchema,
  /** The comment's words. */
  body: z.string(),
  /** An ask's question and option labels, when the request is an ask. */
  ask: z
    .strictObject({ question: z.string(), options: z.array(z.string()) })
    .optional(),
  /** What an allow must carry back: a hash of everything the placeholder hides. */
  wordsHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number(),
  /**
   * The comment's current editedAt, same type as Comment.editedAt (ISO string). Absent when never edited.
   * Applies to held replies too. Opt-in: only when the request has `?details=1` (an older client parses
   * this object strictly, so it never gets it unasked; an older server ignores the query).
   */
  editedAt: z.string().optional(),
});
export type HeldItem = z.infer<typeof HeldItemSchema>;

export const HeldRequestSchema = z.strictObject({
  id: z.string(),
  sender: z.strictObject({ id: z.string(), name: z.string() }),
  artifact: z.strictObject({ id: z.string(), title: z.string() }),
  items: z.array(HeldItemSchema),
  /** The earliest and latest request, ms. */
  since: z.number(),
  lastAt: z.number(),
  /** "Not now" until this (ms), if set. */
  quietUntil: z.number().nullable(),
  /** The page is open to guests or to anyone with the link: the list never applies there. */
  open: z.boolean(),
  /** The shared space the page is in now, if any: "Allow in the space" shows only then. */
  space: z
    .strictObject({
      id: z.string(),
      name: z.string(),
      /** How many pages a space-level allow covers today: in the space, open to no guest, and published through the person's own agent by them. */
      pagesCovered: z.number(),
    })
    .nullable(),
});
export type HeldRequest = z.infer<typeof HeldRequestSchema>;

export const HeldListSchema = z.strictObject({
  requests: z.array(HeldRequestSchema),
});
export type HeldList = z.infer<typeof HeldListSchema>;

/** POST allow: what the notice showed, and how much to allow. */
export const AllowBodySchema = z.strictObject({
  level: z.enum(["once", "page", "space", "all"]),
  items: z
    .array(
      z.strictObject({
        commentId: z.string(),
        wordsHash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(ALLOW_ITEMS_MAX),
  /** "space" and "all": when the entry ends (ms), at most a year from now. */
  until: z.number().int().optional(),
  /** The passkey assertion for R.agentAskHeldAllowChallenge (a list add, when the member has a passkey; always for "space" and "all"). */
  assertion: PasskeyAssertionSchema.optional(),
});
export type AllowBody = z.infer<typeof AllowBodySchema>;

export const AllowResultSchema = z.strictObject({
  /** Passed to the agent now. */
  sent: z.number().int(),
  /** Held at other words than the notice showed (edited or deleted): still held, or gone. */
  changed: z.number().int(),
  /** Held back by the hourly limit: "N still waiting (hourly limit)". */
  waiting: z.number().int(),
  /**
   * The list entry this call created, for Undo (DELETE the receiver's listen entry).
   * Only on "page", "space" and "all", and only when this call inserted a new entry:
   * absent for "once", and when the person was already listed (an extension), a retry, or a lost race.
   * An entry whose end has passed is not "already listed". Opt-in: only with `?details=1`
   * (older clients parse this object strictly).
   */
  entryId: z.string().optional(),
});
export type AllowResult = z.infer<typeof AllowResultSchema>;

export const AllowChallengeBodySchema = z.strictObject({
  until: z.number().int(),
  /** Which entry the prompt is for (default "all"). */
  level: z.enum(["space", "all"]).default("all"),
});
export type AllowChallengeBody = z.infer<typeof AllowChallengeBodySchema>;

/** The switch for asking the caller's agents (R.agentRequests). `on: false`: they hear nobody outside. */
export const AgentRequestsSwitchSchema = z.strictObject({
  on: z.boolean(),
  /** Read-only, projected: the account's browser Needs you (#3024), which also covers held requests. Changed in the notification preferences only. */
  phonePush: z.boolean(),
});
export type AgentRequestsSwitch = z.infer<typeof AgentRequestsSwitchSchema>;

/** PUT: the switch. The old phone-only `phonePush` field is refused (it would have turned on other notifications). */
export const AgentRequestsSwitchBodySchema = z.strictObject({
  on: z.boolean(),
});
export type AgentRequestsSwitchBody = z.infer<
  typeof AgentRequestsSwitchBodySchema
>;

/** One live "listens to" entry: whose requests the caller's agents take without holding, and where. */
export const ListenEntrySchema = z.strictObject({
  id: z.string(),
  member: z.strictObject({ id: z.string(), name: z.string() }),
  scope: z.enum(["page", "space", "all"]),
  /** scope "page": the page. */
  artifact: z.strictObject({ id: z.string(), title: z.string() }).nullable(),
  /** scope "space": the shared space. */
  space: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  /** When it ends (ms). */
  until: z.number(),
  createdAt: z.number(),
});
export type ListenEntry = z.infer<typeof ListenEntrySchema>;

export const ListensListSchema = z.strictObject({
  entries: z.array(ListenEntrySchema),
});
export type ListensList = z.infer<typeof ListensListSchema>;

/** PATCH an entry: end it sooner. Must be after now and before the current end. */
export const ListenShortenBodySchema = z.strictObject({
  until: z.number().int(),
});
export type ListenShortenBody = z.infer<typeof ListenShortenBodySchema>;

/** The most colleagues one batch add may name. */
export const LISTEN_ADD_BATCH_MAX = 50;

/**
 * POST R.agentListens: add teammates to the caller's "listens to" list directly
 * (Settings, the share tick, first setup). Exactly one of `memberId` and
 * `memberIds` (at most 50; all-or-nothing). `until` is 30, 90 or 365 (days from
 * now), or an end time in ms, clamped to a year from now.
 */
export const ListenAddBodySchema = z
  .strictObject({
    memberId: z.string().optional(),
    memberIds: z.array(z.string()).min(1).max(LISTEN_ADD_BATCH_MAX).optional(),
    scope: z.enum(["page", "space", "all"]),
    /** scope "page". */
    artifactId: z.string().optional(),
    /** scope "space". */
    spaceId: z.string().optional(),
    until: z.number().int().positive(),
    via: z.enum(["settings", "share_tick", "first_setup"]),
  })
  .refine((b) => (b.memberId === undefined) !== (b.memberIds === undefined), {
    message: "Send memberId or memberIds",
    path: ["memberId"],
  });
export type ListenAddBody = z.infer<typeof ListenAddBodySchema>;

/** The entries added or extended, in the order asked. A re-add of a live entry extends its end and returns it again. */
export const ListenAddResultSchema = z.strictObject({
  entries: z.array(ListenEntrySchema),
});
export type ListenAddResult = z.infer<typeof ListenAddResultSchema>;

/** What became of one request, from the receiver's side. */
export const AskOutcomeSchema = z.enum([
  "on_list",
  "allowed_once",
  "held",
  "lapsed",
  "not_now",
]);
export type AskOutcome = z.infer<typeof AskOutcomeSchema>;

/** One row of "Who asked what": ids, names, titles and times only; never the words. */
export const AskHistoryRowSchema = z.strictObject({
  agent: z.strictObject({ key: z.string(), name: z.string() }),
  asker: z.strictObject({ id: z.string(), name: z.string() }),
  /** Null when the page is gone or the caller can no longer open it. */
  artifact: z.strictObject({ id: z.string(), title: z.string() }).nullable(),
  at: z.number(),
  outcome: AskOutcomeSchema,
});
export type AskHistoryRow = z.infer<typeof AskHistoryRowSchema>;

export const AskHistorySchema = z.strictObject({
  rows: z.array(AskHistoryRowSchema),
});
export type AskHistory = z.infer<typeof AskHistorySchema>;
