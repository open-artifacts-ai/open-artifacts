/**
 * Plain words for a failed mute or unmute. The shapes (NotificationPrefs,
 * InboxMutes, push subscriptions, ...) come from @oa/shared; it doesn't
 * export the 200 cap, so the copy keeps its own MUTES_MAX (server: mutes_full
 * past 200).
 */
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
