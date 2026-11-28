import { z } from "zod";
import { CommentAskSchema, CommentAuthorSchema } from "./comments.js";

/**
 * #2426 B and #2536: an ask shown in one of a page's `[data-oa-ask]` slots. The
 * page names the place (a key it chose); the server maps keys to asks, so the
 * page's markup never holds an ask id and an id a page invents points nowhere.
 *
 * One ask keeps one home page; showing it elsewhere never copies it. A viewer
 * who cannot open the home page is not told the slot exists: the server leaves
 * the slot out of the list (the contract, section 2).
 */
export const ASK_SLOT_KEY = /^[a-z0-9-]{1,64}$/;
/** The note the placer may leave above the card: plain text, never a recommendation. */
export const ASK_SLOT_NOTE_MAX = 280;
/** The runtime reports at most this many slots; the server answers at most this many. */
export const ASK_SLOTS_MAX = 20;
/** Distinct home pages read for one response, so one page cannot fan out over the instance. */
export const ASK_SLOT_HOMES_MAX = 10;

export const AskSlotKeySchema = z.string().regex(ASK_SLOT_KEY);

export const AskSlotSchema = z.object({
  /** The page's own name for the place. Never an ask id. */
  key: AskSlotKeySchema,
  /** The page the ask lives on, where the answer goes and the thread is read. */
  home: z.object({ artifactId: z.string(), title: z.string() }),
  threadId: z.string(),
  commentId: z.string(),
  /** The same ask view the home page's comments pane gets for this viewer. */
  ask: CommentAskSchema,
  /** Who asked, for "{agent} asks you". Never the placer. */
  author: CommentAuthorSchema,
  /** Up to ASK_SLOT_NOTE_MAX characters from whoever placed it here. */
  note: z.string().max(ASK_SLOT_NOTE_MAX).optional(),
  placer: z
    .object({
      /** Display name for the placer (agent name, else user display name). Never a raw user id. */
      name: z.string(),
      /** The agent that placed it, as it named itself. */
      agent: z.string().optional(),
    })
    .optional(),
});
export type AskSlot = z.infer<typeof AskSlotSchema>;

/** GET /artifacts/:id/ask-slots: the slots this viewer may see, [] when none. */
export const AskSlotListSchema = z.array(AskSlotSchema);
export type AskSlotList = z.infer<typeof AskSlotListSchema>;

/** PUT /artifacts/:id/ask-slots/:key body (#2536): place an existing ask in a page's slot. */
export const PlaceAskBodySchema = z.object({
  homeArtifactId: z.string().min(1),
  threadId: z.string().min(1),
  commentId: z.string().min(1),
  note: z.string().trim().max(ASK_SLOT_NOTE_MAX).optional(),
});
export type PlaceAskBody = z.infer<typeof PlaceAskBodySchema>;

/** MCP place_ask (#2536): place an existing ask into a page's [data-oa-ask] slot. */
export const PlaceAskInputSchema = PlaceAskBodySchema.extend({
  id: z.string().min(1),
  key: AskSlotKeySchema,
});
export type PlaceAskInput = z.infer<typeof PlaceAskInputSchema>;

/** MCP remove_ask_slot (#2536): remove a placed ask from a page's slot. */
export const RemoveAskSlotInputSchema = z.object({
  id: z.string().min(1),
  key: AskSlotKeySchema,
});
export type RemoveAskSlotInput = z.infer<typeof RemoveAskSlotInputSchema>;
