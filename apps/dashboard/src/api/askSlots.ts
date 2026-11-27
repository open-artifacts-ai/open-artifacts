// The contract is the artifact jp3RtzkygV1sijvM, section 2: the asks this
// viewer may see in the page's `[data-oa-ask]` slots, filtered by the server.
import { type AskSlot, AskSlotListSchema, AskSlotSchema, R } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, api } from "./client";

export { type AskSlot, AskSlotSchema };

/** Every page's slot list; invalidated by the comments event stream and by an answer. */
export const ASK_SLOTS_KEY = ["ask-slots"] as const;
export const askSlotsKey = (id: string) => [...ASK_SLOTS_KEY, id] as const;

/**
 * The slots the server has an ask for, on this page. A 404 (no such route yet,
 * or no slots) is an empty list. Only fetched once the frame has reported a slot.
 */
export const useAskSlots = (artifactId: string, enabled = true) =>
  useQuery({
    enabled,
    queryKey: askSlotsKey(artifactId),
    retry: (n, e) =>
      !(e instanceof ApiClientError && e.status === 404) && n < 1,
    queryFn: async ({ signal }): Promise<AskSlot[]> => {
      try {
        return await api.get(R.askSlots(artifactId), AskSlotListSchema, signal);
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) return [];
        throw e;
      }
    },
  });
