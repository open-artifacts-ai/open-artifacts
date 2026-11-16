// #2661 part A: a passkey on high-stakes decisions, the ask card.
//
// PROVISIONAL (OA Comments' contract, #2661 comment 6920345168, until the
// server PR lands and @oa/shared has it): this file is the one place that
// reads it.
// - ask.options[].highStakes?: { reason } — the asker's mark, fixed once
//   posted; the reason is the asker's words (at most 200 characters).
// - ask.options[].passkey?: true — stamped for this viewer at read time:
//   this pick needs their passkey now (high stakes and their switch on, or
//   "every answer" on).
// - ask.passkeyMissing?: true — the viewer has no usable passkey and some
//   option of theirs would need one.
// The six `action` kinds and the whole-ask `confirm` are no longer read.
import {
  AskOptionSchema,
  CommentAskSchema,
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
} from "@oa/shared";
import { z } from "zod";

export const HIGH_STAKES_REASON_MAX = 200;

export const HighStakesSchema = z.object({ reason: z.string() });
export const MarkedOptionSchema = AskOptionSchema.extend({
  highStakes: HighStakesSchema.optional(),
  passkey: z.literal(true).optional(),
});
export type MarkedOption = z.infer<typeof MarkedOptionSchema>;

const MarkedAskSchema = CommentAskSchema.safeExtend({
  options: z.array(MarkedOptionSchema).min(1),
  passkeyMissing: z.literal(true).optional(),
});
export const MarkedCommentSchema = CommentSchema.extend({
  ask: MarkedAskSchema.optional(),
});
export const MarkedThreadSchema = CommentThreadSchema.extend({
  comments: z.array(MarkedCommentSchema),
});
export const MarkedListSchema = CommentListSchema.extend({
  threads: z.array(MarkedThreadSchema),
});

type AskLike = { options: object[]; passkeyMissing?: boolean };
const marks = (o: object) => o as MarkedOption;

/** The option's mark, if the asker set one. */
export const highStakesOf = (o: object) => marks(o).highStakes ?? null;
/** This viewer's pick of the option needs their passkey (the server's stamp). */
export const needsPasskey = (o: object) => marks(o).passkey === true;
/** The viewer can't approve yet: no usable passkey. */
export const passkeyMissing = (a: object) =>
  (a as AskLike).passkeyMissing === true;

/**
 * What the card says above the options: the marked reasons (distinct, in
 * option order), whether a marked option needs the passkey, and whether
 * "every answer" caused a prompt (an unmarked option that still needs it).
 */
export function cardMarks(a: AskLike) {
  const reasons: string[] = [];
  let markedNeeds = false;
  let every = false;
  for (const o of a.options) {
    const hs = highStakesOf(o);
    if (hs && !reasons.includes(hs.reason)) reasons.push(hs.reason);
    if (hs && needsPasskey(o)) markedNeeds = true;
    if (!hs && needsPasskey(o)) every = true;
  }
  return { reasons, markedNeeds, every };
}

/** OA Product's words (#2661, Strings), word for word. */
export const HIGH_STAKES = {
  option: "High stakes",
  card: "High stakes · needs your passkey",
  says: (asker: string, reason: string) => `${asker} says: "${reason}"`,
  missing: "Add a passkey to approve this",
  every: "You've chosen to confirm every answer with your passkey.",
} as const;
