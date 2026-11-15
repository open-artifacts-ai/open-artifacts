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
});
export type HeldRequest = z.infer<typeof HeldRequestSchema>;

export const HeldListSchema = z.strictObject({
  requests: z.array(HeldRequestSchema),
});
export type HeldList = z.infer<typeof HeldListSchema>;

/** POST allow: what the notice showed, and how much to allow. */
export const AllowBodySchema = z.strictObject({
  level: z.enum(["once", "page", "all"]),
  items: z
    .array(
      z.strictObject({
        commentId: z.string(),
        wordsHash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(ALLOW_ITEMS_MAX),
  /** "all": when the entry ends (ms), at most a year from now. */
  until: z.number().int().optional(),
  /** The passkey assertion for R.agentAskHeldAllowChallenge (a list add, when the member has a passkey; always for "all"). */
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
});
export type AllowResult = z.infer<typeof AllowResultSchema>;

export const AllowChallengeBodySchema = z.strictObject({
  until: z.number().int(),
});
export type AllowChallengeBody = z.infer<typeof AllowChallengeBodySchema>;
