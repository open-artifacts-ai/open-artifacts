import type { ErrorCode } from "@oa/shared";
import { ApiClientError } from "./client";

/** The UI's own copy for the hosted error codes (Design's final strings, 2026-10-21). */
const COPY: Partial<Record<ErrorCode, string>> = {
  space_forbidden:
    "You can't publish to this space. Ask a space manager to make you an editor.",
  space_personal: "Personal spaces can't be used here. Pick a shared space.",
  space_not_empty:
    "This space still has artifacts. Move or delete them first. Artifacts in the trash count too.",
  public_links_off:
    "Public links are off for this space. A space manager can turn them on.",
  use_move: "This artifact already exists. Use Move to change its space.",
  invalid_successor: "Pick an active member who isn't a guest or restricted.",
  member_active:
    "This person is active again, so their artifacts stay with them. Nothing was moved.",
  directory_sync_off:
    "Directory sync is off, so this isn't available right now.",
  turnstile_required: "Finish the check above, then send the code again.",
  turnstile_failed: "The check didn't go through. Try it again.",
  directory_mapping_off:
    "An admin has turned off group mapping by space managers. Ask an admin to add or change groups.",
  restrict_admin:
    "Owners and admins can't be restricted. Make them a member first.",
  reauth_required:
    "For your security, sign in with Google again to manage the directory.",
};

/** 409 conflict (compare-and-set, #534): Design's copy, shown inline. */
export const CONFLICT_COPY =
  "This artifact just changed. Check it and try again.";
export const isConflict = (e: unknown) =>
  e instanceof ApiClientError && e.code === "conflict";

/** Asking a space manager can't help a guest or restricted member. */
const CAPPED_FORBIDDEN = "Your account can only view, so you can't publish.";

export const DIRECTORY_SETTINGS = "/settings/directory";

/** What the UI knows about where and who the error reached. */
export type ErrorContext = {
  /** Me.auth.cap is set (a guest or restricted member). */
  capped?: boolean;
  /** The error shows on the Directory page itself. */
  onDirectoryPage?: boolean;
};

/**
 * What to tell the person about `e`: the mapped copy for a hosted code, else
 * the server's message, else `fallback`. `capped` picks the capped wording of
 * `space_forbidden`.
 */
export const errorCopy = (
  e: unknown,
  fallback: string,
  ctx?: ErrorContext,
): string => {
  if (!(e instanceof ApiClientError)) return fallback;
  if (e.code === "space_forbidden" && ctx?.capped) return CAPPED_FORBIDDEN;
  return (e.code !== "cpu_limit" && COPY[e.code]) || e.message || fallback;
};

/** A link to show with the copy: off the Directory page, `directory_sync_off` points there. */
export const errorLink = (
  e: unknown,
  ctx?: ErrorContext,
): { label: string; to: string } | null =>
  e instanceof ApiClientError &&
  e.code === "directory_sync_off" &&
  !ctx?.onDirectoryPage
    ? { label: "Open directory settings", to: DIRECTORY_SETTINGS }
    : null;
