import type { ErrorCode, Me } from "@oa/shared";
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
const TEAM_FEATURE = "Spaces are a team feature";
/** What a refused invite is called (#1838); the refusal itself names no feature. */
const INVITE_FEATURE = "Inviting people is a team feature";
const STILL_WORKS = "Reading and sharing still work. Nothing has been deleted.";
const PLAN_LIMIT_NOUN: Record<string, string> = {
  storage_bytes: "storage",
  data_docs: "live-data documents per artifact",
  data_daily_writes: "live-data writes per day",
  data_daily_writes_total: "live-data writes per day across all artifacts",
};

/**
 * Why the instance is read-only (PlanReason), for the banner and the refusal
 * toast. `owner` swaps "ask your instance owner" for the action.
 */
export const readOnlyCopy = (reason: unknown, owner: boolean): string => {
  switch (reason) {
    case "trial_ended":
      return owner
        ? "Your trial ended, so this instance is read-only until you pick a plan."
        : "Your trial ended, so this instance is read-only until the owner picks a plan.";
    case "solo_unpaid":
      // The view-only lock: publishing is paused.
      return owner
        ? "Your Solo plan is paused. Keep publishing for $1/month or $10/year."
        : `Publishing is paused until this instance's Solo plan is paid. ${ASK}.`;
    // Design, Self-serve screens v6, decision 3: one line per reason. The
    // owner's line names the action (the banner's button); a member's says
    // whom to ask and what still works.
    case "lapsed":
      return owner
        ? "Your plan has lapsed. This instance is read-only. Manage billing to restart it."
        : `The plan has lapsed, so this instance is read-only. Ask an owner to fix billing. ${STILL_WORKS}`;
    case "payment_failed":
      return owner
        ? "Payment failed and the grace period has ended. This instance is read-only. Manage billing to update your card."
        : `A payment failed, so this instance is read-only. Ask an owner to update the card. ${STILL_WORKS}`;
    case "billing_unreachable":
      // Our outage: never blame the customer, and no action for the owner.
      return owner
        ? "We can't reach our billing system, so editing is paused. This is on our side and nothing is wrong with your account. We're working on it."
        : `Editing is paused while we fix a problem on our side. Nothing is wrong with your account. ${STILL_WORKS}`;
    case "suspended":
      return owner
        ? `This instance is suspended. ${STILL_WORKS} Contact support to restore it.`
        : `This instance is suspended. ${STILL_WORKS} Ask an owner to contact support.`;
    default:
      return owner
        ? "This instance is read-only right now."
        : `This instance is read-only right now. ${ASK}.`;
  }
};

const planCopy = (
  e: ApiClientError,
  owner: boolean,
  trialNeverRan: boolean,
  refused: ErrorContext["refused"],
): string | undefined => {
  const d = e.details as { reason?: unknown; limit?: unknown; max?: unknown };
  switch (e.code) {
    case "plan_required":
      // Sharing is free on every plan: plan_required is a team feature. The
      // refusal's details are only {tier, reason}, so the caller says which.
      if (refused === "invite")
        return owner
          ? `${INVITE_FEATURE}. Choose a plan to continue.`
          : `${INVITE_FEATURE}. This instance is on Solo. Ask an owner to choose a plan.`;
      if (owner && trialNeverRan)
        return `${TEAM_FEATURE}. Invite someone to start your free 30-day trial, or choose a plan.`;
      return owner
        ? `${TEAM_FEATURE}. Choose a plan to continue.`
        : `${TEAM_FEATURE}. This instance is on Solo. Ask an owner to invite someone or choose a plan.`;
    case "plan_read_only":
      return readOnlyCopy(d?.reason, owner);
    case "plan_limit": {
      const raise = typeof d?.max === "number" && typeof d?.limit === "string";
      const what = raise
        ? `The Solo plan allows up to ${d.max} ${PLAN_LIMIT_NOUN[d.limit as string] ?? d.limit}.`
        : "The Solo plan's limit is reached.";
      return owner
        ? `${what} Choose a paid plan${raise ? " to raise it" : ""}.`
        : `${what} ${ASK} about a paid plan.`;
    }
    case "billing_unavailable":
      return "Billing isn't reachable right now. Try again in a minute.";
    case "no_billing_customer":
      return "Open Artifacts set up this plan for you, so there's nothing to pay or manage here.";
  }
};

/** What a locked admin reads by disabled write controls. */
export const READ_ONLY_NOTICE = `This instance is read-only right now. ${ASK}.`;
const PLAN_FORBIDDEN =
  "This instance is read-only right now, so you can't publish.";
/** What a guest or restricted member is told when a write is refused; asking a space manager can't help. */
export const cappedCopy = (verb: string) =>
  `Your account can only view, so you can't ${verb}.`;
const CAPPED_FORBIDDEN = cappedCopy("publish");

export const DIRECTORY_SETTINGS = "/settings/directory";

/** What the UI knows about where and who the error reached. */
export type ErrorContext = {
  /** Me.auth.cap is set (a guest or restricted member). */
  capped?: boolean;
  /** Me.auth.cap, when capped: "plan" is a locked instance, not a view-only account. */
  cap?: NonNullable<Me["auth"]>["cap"];
  /** The caller is the org owner or an admin (any cap: admins carry "plan" under every lock): billing copy says what they can do. */
  owner?: boolean;
  /** A Solo instance whose trial never ran (trialEndsAt null): plan_required offers the trial. */
  trialNeverRan?: boolean;
  /**
   * What the caller attempted, for plan_required: its details carry no
   * feature. Absent reads as spaces (the original wording).
   */
  refused?: "invite" | "spaces";
  /** The error shows on the Directory page itself. */
  onDirectoryPage?: boolean;
};

/**
 * The billing part of an ErrorContext from Me: owners and admins
 * can open Plan and billing, so they read the owner wording; trialNeverRan
 * only means anything to them (others see trialEndsAt as null).
 */
export const billingContext = (
  me: Me | null | undefined,
): Pick<ErrorContext, "owner" | "trialNeverRan"> => {
  // The same rule as the read-only banner: owners and admins reach Plan and
  // billing. Admins carry the plan cap under every lock, so the cap isn't asked.
  const owner = me?.user.role === "owner" || me?.user.role === "admin";
  const billing = me?.instance?.billing;
  return {
    owner,
    // A capped admin can't invite, so the copy never offers them the trial.
    ...(owner && billing && (me?.auth?.cap ?? null) === null
      ? {
          // Active only: a past_due Solo in grace is refused, so it isn't
          // offered the trial.
          trialNeverRan:
            billing.tier === "solo" &&
            billing.status === "active" &&
            billing.trialEndsAt === null,
        }
      : {}),
  };
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
  const plan = planCopy(
    e,
    ctx?.owner === true,
    ctx?.trialNeverRan === true,
    ctx?.refused,
  );
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
