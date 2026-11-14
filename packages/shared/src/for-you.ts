/**
 * "For you" (#2512): the bell's list of what needs the caller and what changed.
 *
 * PROVISIONAL. TODO(OA Backend, #2512): replace with OA Backend's server
 * contract for For you (items, read state, Later, follows and mutes). The
 * dashboard builds on these shapes through mocks only until then.
 */
import { z } from "zod";

/** Who an item is from. `key` is an agent's bus key, for "Mute <agent>". */
export const ForYouActorSchema = z.object({
  kind: z.enum(["agent", "user", "system"]),
  name: z.string(),
  key: z.string().optional(),
});
export type ForYouActor = z.infer<typeof ForYouActorSchema>;

/**
 * Put off once: `snoozed` until the server's time (hidden in the "Later" line),
 * then `returned` (on top, marked "Back from later", no Later button).
 */
export const ForYouLaterSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("snoozed"), until: z.string() }),
  z.object({ state: z.literal("returned") }),
]);
export type ForYouLater = z.infer<typeof ForYouLaterSchema>;

export const FOR_YOU_KINDS = [
  "ask",
  "machine",
  "billing",
  "mention",
  "reply",
  "decision",
  "version",
  "share",
] as const;

export const ForYouItemSchema = z.object({
  id: z.string(),
  /** "needs": counts on the bell. "update": a dot at most. */
  level: z.enum(["needs", "update"]),
  kind: z.enum(FOR_YOU_KINDS),
  /** The bold line, as the server words it. */
  title: z.string(),
  /** The muted line before the time, e.g. `OA Manager asks · on "Open Artifacts Asks"`. */
  context: z.string(),
  /** When it happened (ISO); the row shows how long ago, except on a waiting ask. */
  at: z.string(),
  actor: ForYouActorSchema.optional(),
  /** The page it is on: rows open it; updates can stop following it. */
  page: z.object({ id: z.string(), title: z.string() }).optional(),
  /** An ask on `page`: the row opens its card in the panel. */
  ask: z.object({ thread: z.string(), comment: z.string() }).optional(),
  /** A single-action item's target (a machine to approve: "Review"). */
  action: z.object({ href: z.string() }).optional(),
  /** How long an agent has been blocked on this, from the server's bus status. Never from the agent's own words. */
  waitingMs: z.number().int().nonnegative().optional(),
  read: z.boolean(),
  later: ForYouLaterSchema.optional(),
  /** Billing items: owners and admins only (the server filters; the client checks too). */
  audience: z.enum(["all", "admins"]).optional(),
});
export type ForYouItem = z.infer<typeof ForYouItemSchema>;

/** "While you were away": updates folded into one summary row until "Show them". */
export const ForYouAwaySchema = z.object({
  updates: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  since: z.string(),
  ids: z.array(z.string()),
});
export type ForYouAway = z.infer<typeof ForYouAwaySchema>;

/** GET R.forYou. */
export const ForYouSchema = z.object({
  items: z.array(ForYouItemSchema),
  away: ForYouAwaySchema.nullable().optional(),
});
export type ForYou = z.infer<typeof ForYouSchema>;

/** POST R.forYouRead: some items, or every update. */
export const ForYouReadBodySchema = z.union([
  z.object({ ids: z.array(z.string()).min(1) }),
  z.object({ all: z.literal(true) }),
]);
export type ForYouReadBody = z.infer<typeof ForYouReadBodySchema>;

/** POST R.forYouLater(id): the server picks the time ("Tomorrow morning" is 8:00 the caller's time). */
export const ForYouLaterBodySchema = z.object({
  when: z.enum(["hour", "morning"]),
});
export type ForYouLaterBody = z.infer<typeof ForYouLaterBodySchema>;

/** POST R.forYouMutes. */
export const ForYouMuteBodySchema = z.object({ agent: z.string() });
export type ForYouMuteBody = z.infer<typeof ForYouMuteBodySchema>;
