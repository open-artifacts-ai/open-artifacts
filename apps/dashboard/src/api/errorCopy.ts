import type { ErrorCode } from "@oa/shared";
import { heicCopy, KINDS } from "../upload/openable";
import { ApiClientError } from "./client";

/** The UI's own copy for the hosted error codes (Design's final strings, 2026-10-21). */
const COPY: Partial<Record<ErrorCode, string>> = {
  space_forbidden:
    "You can't publish to this space. Ask a space manager to make you an editor.",
  space_personal: "Personal spaces can't be used here. Pick a shared space.",
  space_not_empty:
    "This space still has artifacts. Move or delete them first. Deleted ones stay in Trash for 30 days.",
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
  unsupported_format: `This type of file can't be opened yet. Upload ${KINDS}.`,
  binary_entry:
    "This file isn't text, so it can't open as a web page, Markdown or code. Check that its file extension matches what it is.",
  reauth_required:
    "For your security, sign in with Google again to manage the directory.",
};

/** Billing's wording; `owner` swaps "ask your instance owner" for the action. */
const ASK = "Ask your instance owner";
const PLAN_LIMIT_NOUN: Record<string, string> = {
  storage_bytes: "storage",
  data_docs: "live-data documents per artifact",
  data_daily_writes: "live-data writes per day",
};

const planCopy = (e: ApiClientError, owner: boolean): string | undefined => {
  const d = e.details as { reason?: unknown; limit?: unknown; max?: unknown };
  switch (e.code) {
    case "plan_required":
      return owner
        ? "This needs a paid plan. Choose a plan to continue."
        : `This needs a paid plan. ${ASK} to choose one.`;
    case "plan_read_only":
      switch (d?.reason) {
        case "trial_ended":
          return owner
            ? "Your trial ended, so this instance is read-only until you pick a plan."
            : "Your trial ended, so this instance is read-only until the owner picks a plan.";
        case "lapsed":
        case "payment_failed":
          return owner
            ? "This instance is read-only until billing is sorted out. Update billing to fix it."
            : `This instance is read-only until billing is sorted out. ${ASK}.`;
        case "suspended":
          return owner
            ? "This instance is suspended."
            : `This instance is suspended. ${ASK}.`;
        default:
          return owner
            ? "This instance is read-only right now."
            : `This instance is read-only right now. ${ASK}.`;
      }
    case "plan_limit": {
      const what =
        typeof d?.max === "number" && typeof d.limit === "string"
          ? `The free plan allows up to ${d.max} ${PLAN_LIMIT_NOUN[d.limit] ?? d.limit}.`
          : "The free plan's limit is reached.";
      const raise = typeof d?.max === "number" && typeof d.limit === "string";
      return owner
        ? `${what} Choose a paid plan${raise ? " to raise it" : ""}.`
        : `${what} ${ASK} about a paid plan.`;
    }
    case "billing_unavailable":
      return "Billing isn't reachable right now. Try again in a minute.";
  }
};

/** Asking a space manager can't help a guest or restricted member. */
const CAPPED_FORBIDDEN = "Your account can only view, so you can't publish.";
const PLAN_FORBIDDEN =
  "This instance is read-only right now, so you can't publish.";

export const DIRECTORY_SETTINGS = "/settings/directory";

/** What the UI knows about where and who the error reached. */
export type ErrorContext = {
  /** Me.auth.cap is set (a guest or restricted member). */
  capped?: boolean;
  /** Me.auth.cap, when capped: "plan" is a locked instance, not a view-only account. */
  cap?: "guest" | "restricted" | "plan" | null;
  /** The caller is the org owner (uncapped): billing copy says what they can do. */
  owner?: boolean;
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
  if (e.code === "space_forbidden" && ctx?.capped)
    return ctx.cap === "plan" ? PLAN_FORBIDDEN : CAPPED_FORBIDDEN;
  const plan = planCopy(e, ctx?.owner === true);
  if (plan) return plan;
  const d = e.details as { reason?: unknown; path?: unknown } | undefined;
  if (e.code === "unsupported_format" && d?.reason === "heic")
    return heicCopy(
      typeof d.path === "string"
        ? d.path.slice(d.path.lastIndexOf("/") + 1)
        : "This photo",
    );
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
