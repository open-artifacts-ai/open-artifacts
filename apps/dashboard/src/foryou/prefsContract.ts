/**
 * NotificationPrefs, InboxMutes and the rest of S4 come from @oa/shared. What
 * stays here: S5's push-subscription adapter (PROVISIONAL, #2774) and the
 * plain words for a failed mute or unmute. @oa/shared doesn't export the 200
 * cap, so the copy keeps its own MUTES_MAX (server: mutes_full past 200).
 */
import { z } from "zod";

// PROVISIONAL (#2774): S5. PATCH R.mePushSubscription(id) -> { needsYou, updates }.
export const PushSubscriptionPatchBodySchema = z.strictObject({
  needsYou: z.boolean().optional(),
  updates: z.boolean().optional(),
});
export type PushSubscriptionPatchBody = z.infer<
  typeof PushSubscriptionPatchBodySchema
>;
export const PushSubscriptionSwitchesSchema = z.object({
  needsYou: z.boolean(),
  updates: z.boolean(),
});

// PROVISIONAL (#2774): GET R.mePushSubscriptions, each browser with its own
// switches. A new browser starts with needsYou on and updates from the prefs.
export const PushSubscriptionItemSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  needsYou: z.boolean(),
  updates: z.boolean(),
});
export type PushSubscriptionItem = z.infer<typeof PushSubscriptionItemSchema>;
export const PushSubscriptionListSchema = z.object({
  items: z.array(PushSubscriptionItemSchema),
});
export type PushSubscriptionList = z.infer<typeof PushSubscriptionListSchema>;

export const MUTES_MAX = 200;

export function muteErrorCopy(e: unknown, what: "mute" | "unmute"): string {
  const status = (e as { status?: number } | null)?.status;
  const code = (e as { code?: string } | null)?.code;
  if (what === "mute" && code === "mutes_full")
    return `You've muted as many as we allow (${MUTES_MAX}). Unmute one in Settings first.`;
  if (status === 404)
    return what === "mute"
      ? "That's gone, or you can't see it any more, so it can't be muted."
      : "That's already unmuted.";
  return what === "mute" ? "Couldn't mute that." : "Couldn't unmute that.";
}
