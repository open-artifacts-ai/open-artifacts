/**
 * PROVISIONAL (#2769): the S4 server contract, mirrored here until #2769
 * merges. Then delete this file and import these from @oa/shared (one file).
 *  - updates.browser is a boolean: the default a new browser starts with.
 *  - mutes: GET, POST, DELETE. POST 404 = an id the caller can't see; POST 409
 *    mutes_full past MUTES_MAX; DELETE 404 = nothing muted there (any more).
 *  - PATCH R.mePushSubscription (S5, parked): types only, nothing calls it.
 */
import { z } from "zod";

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

// PROVISIONAL (#2769)
export const NotificationPrefsSchema = z.object({
  needsYou: z.object({ inApp: z.literal(true), browser: z.boolean() }),
  updates: z.object({ inApp: z.literal(true), browser: z.boolean() }),
  browserAllAsks: z.boolean(),
  quietHours: z.object({ start: Hhmm, end: Hhmm }).nullable(),
  timeZone: z.string().min(1).max(64),
  lockScreenDetail: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

// PROVISIONAL (#2769): S5, parked. A push subscription's own switches.
export type PushSubscriptionPatchBody = {
  needsYou?: boolean;
  updates?: boolean;
};

// PROVISIONAL (#2769)
export const MUTES_MAX = 200;

/** Plain words for a failed mute or unmute. */
export function muteErrorCopy(e: unknown, what: "mute" | "unmute"): string {
  const status = (e as { status?: number } | null)?.status;
  const code = (e as { code?: string } | null)?.code;
  if (what === "mute" && (status === 409 || code === "mutes_full"))
    return `You've muted as many as we allow (${MUTES_MAX}). Unmute one in Settings first.`;
  if (status === 404)
    return what === "mute"
      ? "That's gone, or you can't see it any more, so it can't be muted."
      : "That's already unmuted.";
  return what === "mute" ? "Couldn't mute that." : "Couldn't unmute that.";
}
