// PROVISIONAL (#2426 B): swap to the shared schema when the server lands.
// The contract is the artifact jp3RtzkygV1sijvM, section 2: the asks this
// viewer may see in the page's `[data-oa-ask]` slots, filtered by the server.
import { CommentAskSchema, CommentAuthorSchema } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ApiClientError, api } from "./client";

/** Every page's slot list; invalidated by the comments event stream and by an answer. */
export const ASK_SLOTS_KEY = ["ask-slots"] as const;
export const askSlotsKey = (id: string) => [...ASK_SLOTS_KEY, id] as const;
const path = (id: string) => `/api/v1/artifacts/${id}/ask-slots`;

export const AskSlotSchema = z.object({
  /** The page's own name for the place: [a-z0-9-]{1,64}. Never an ask id. */
  key: z.string().regex(/^[a-z0-9-]{1,64}$/),
  /** The page the ask lives on, and where an answer goes. */
  home: z.object({ artifactId: z.string(), title: z.string() }),
  threadId: z.string(),
  commentId: z.string(),
  ask: CommentAskSchema,
  /** Up to 280 characters from whoever placed it here. Plain text. */
  note: z.string().max(280).optional(),
  placer: z.object({ id: z.string().optional(), name: z.string() }).optional(),
  /** NOT in the contract yet: who asked, for "{agent} asks you". Falls back to "An agent". */
  author: CommentAuthorSchema.optional(),
});
export type AskSlot = z.infer<typeof AskSlotSchema>;
const ListSchema = z.array(AskSlotSchema);

/**
 * The slots the server has an ask for, on this page. A 404 (no such route yet,
 * or no slots) is an empty list. Only fetched once the frame has reported a slot.
 */
export const useAskSlots = (artifactId: string, enabled = true) =>
  useQuery({
    enabled,
    queryKey: askSlotsKey(artifactId),
    retry: (n, e) => !(e instanceof ApiClientError && e.status === 404) && n < 1,
    queryFn: async ({ signal }): Promise<AskSlot[]> => {
      try {
        return await api.get(path(artifactId), ListSchema, signal);
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) return [];
        throw e;
      }
    },
  });
