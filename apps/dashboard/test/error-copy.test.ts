// Final copy: Design, 2026-10-21 (p4-error-copy.md), verbatim.
import type { ErrorCode } from "@oa/shared";
import { expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import { billingContext, errorCopy, errorLink } from "../src/api/errorCopy";

it.each([
  [
    "space_forbidden",
    "You can't publish to this space. Ask a space manager to make you an editor.",
  ],
  [
    "space_personal",
    "Personal spaces can't be used here. Pick a shared space.",
  ],
  [
    "space_not_empty",
    "This space still has artifacts. Move or delete them first. Deleted ones stay in Trash for 30 days.",
  ],
  [
    "public_links_off",
    "Public links are off for this space. A space manager can turn them on.",
  ],
  ["use_move", "This artifact already exists. Use Move to change its space."],
  [
    "invalid_successor",
    "Pick an active member who isn't a guest or restricted.",
  ],
  [
    "member_active",
    "This person is active again, so their artifacts stay with them. Nothing was moved.",
  ],
  [
    "directory_sync_off",
    "Directory sync is off, so this isn't available right now.",
  ],
  ["turnstile_required", "Finish the check above, then send the code again."],
  ["turnstile_failed", "The check didn't go through. Try it again."],
  [
    "restrict_admin",
    "Owners and admins can't be restricted. Make them a member first.",
  ],
  [
    "reauth_required",
    "For your security, sign in with Google again to manage the directory.",
  ],
  // Design, 2026-10-28 (the upload refusals, #775).
  [
    "unsupported_format",
    "This type of file can't be opened yet. Upload a web page, Markdown, code, a PDF or an image.",
  ],
  [
    "binary_entry",
    "This file isn't text, so it can't open as a web page, Markdown or code. Check that its file extension matches what it is.",
  ],
])("%s", (code, copy) => {
  expect(
    errorCopy(new ApiClientError(code as ErrorCode, "server text", 400), "x"),
  ).toBe(copy);
});

it("other codes fall back to the server message, then the fallback", () => {
  expect(
    errorCopy(new ApiClientError("not_found", "Not found", 404), "x"),
  ).toBe("Not found");
  expect(errorCopy(new Error("boom"), "Couldn't save.")).toBe("Couldn't save.");
});

it("a capped caller's space_forbidden says why asking won't help", () => {
  const e = new ApiClientError("space_forbidden", "server text", 403);
  expect(errorCopy(e, "x", { capped: true })).toBe(
    "Your account can only view, so you can't publish.",
  );
  expect(errorCopy(e, "x", { capped: false })).toBe(errorCopy(e, "x"));
});

it("directory_sync_off links to directory settings off the Directory page", () => {
  const e = new ApiClientError("directory_sync_off", "server text", 409);
  expect(errorLink(e)).toEqual({
    label: "Open directory settings",
    to: "/settings/directory",
  });
  expect(errorLink(e, { onDirectoryPage: false })).toEqual({
    label: "Open directory settings",
    to: "/settings/directory",
  });
  expect(errorLink(e, { onDirectoryPage: true })).toBeNull();
  expect(errorCopy(e, "x", { onDirectoryPage: false })).toBe(
    "Directory sync is off, so this isn't available right now.",
  );
});

it("no link for other errors", () => {
  expect(
    errorLink(new ApiClientError("space_forbidden", "server text", 403)),
  ).toBeNull();
  expect(errorLink(new Error("boom"))).toBeNull();
});

it("a HEIC refusal names the photo and says to export it", () => {
  const e = new ApiClientError("unsupported_format", "server text", 400, {
    path: "photos/IMG_0042.HEIC",
    reason: "heic",
  });
  expect(errorCopy(e, "x")).toBe(
    "IMG_0042.HEIC can't be opened here. Export it as JPEG or PNG, then upload it again.",
  );
});

// Billing plumbing (no new visual): Design reviews this copy on Oct 30.
const planErr = (code: string, details?: unknown) =>
  new ApiClientError(code as never, "server text", 403, details);
const reason = (r?: string) => (r ? { tier: "trial", reason: r } : undefined);

it.each([
  [
    "trial_ended",
    "Your trial ended, so this instance is read-only until the owner picks a plan.",
    "Your trial ended, so this instance is read-only until you pick a plan.",
  ],
  [
    "solo_unpaid",
    "Publishing is paused until this instance's Solo plan is paid. Ask your instance owner.",
    "Your Solo plan is paused. Keep publishing for $1/month or $12/year.",
  ],
  // Design, Self-serve screens v6, decision 3: one line per reason. The member
  // lines for lapsed and payment_failed end with what still works (#1844).
  [
    "lapsed",
    "The plan has lapsed, so this instance is read-only. Ask an owner to fix billing. Reading and sharing still work. Nothing has been deleted.",
    "Your plan has lapsed. This instance is read-only. Manage billing to restart it.",
  ],
  [
    "payment_failed",
    "A payment failed, so this instance is read-only. Ask an owner to update the card. Reading and sharing still work. Nothing has been deleted.",
    "Payment failed and the grace period has ended. This instance is read-only. Manage billing to update your card.",
  ],
  [
    "suspended",
    "This instance is suspended. Reading and sharing still work. Nothing has been deleted. Ask an owner to contact support.",
    "This instance is suspended. Reading and sharing still work. Nothing has been deleted. Contact support to restore it.",
  ],
  [
    "billing_unreachable",
    "Editing is paused while we fix a problem on our side. Nothing is wrong with your account. Reading and sharing still work. Nothing has been deleted.",
    "We can't reach our billing system, so editing is paused. This is on our side and nothing is wrong with your account. We're working on it.",
  ],
  [
    undefined,
    "This instance is read-only right now. Ask your instance owner.",
    "This instance is read-only right now.",
  ],
])("plan_read_only (%s)", (r, member, owner) => {
  const e = planErr("plan_read_only", reason(r));
  expect(errorCopy(e, "x")).toBe(member);
  expect(errorCopy(e, "x", { owner: true })).toBe(owner);
});

it("plan_required before a trial ever ran offers the trial", () => {
  const e = planErr("plan_required", reason("solo"));
  expect(errorCopy(e, "x", { owner: true, trialNeverRan: true })).toBe(
    "Spaces are a team feature. Invite someone to start your free 14-day trial, or choose a plan.",
  );
  expect(errorCopy(e, "x", { owner: true, trialNeverRan: false })).toBe(
    "Spaces are a team feature. Choose a plan to continue.",
  );
  expect(errorCopy(e, "x", { trialNeverRan: true })).toBe(
    "Spaces are a team feature. This instance is on Solo. Ask an owner to invite someone or choose a plan.",
  );
});

it("plan_required names what was refused, not always Spaces (#1838)", () => {
  const e = planErr("plan_required", reason("solo"));
  // An invite: the caller says so (the refusal itself carries no feature).
  expect(errorCopy(e, "x", { owner: true, refused: "invite" })).toBe(
    "Inviting people is a team feature. Choose a plan to continue.",
  );
  expect(errorCopy(e, "x", { refused: "invite" })).toBe(
    "Inviting people is a team feature. This instance is on Solo. Ask an owner to choose a plan.",
  );
  // Never the trial offer on an invite: the first invite is what starts it.
  expect(
    errorCopy(e, "x", { owner: true, trialNeverRan: true, refused: "invite" }),
  ).not.toMatch(/Spaces|Invite someone/);
  // Spaces, and a caller that doesn't say, keep the Spaces copy.
  expect(errorCopy(e, "x", { owner: true, refused: "spaces" })).toBe(
    "Spaces are a team feature. Choose a plan to continue.",
  );
  expect(errorCopy(e, "x", { owner: true })).toBe(
    "Spaces are a team feature. Choose a plan to continue.",
  );
});

it("errorContext gives admins the owner wording and the trial state", () => {
  const me = (role: string, trialEndsAt: string | null) =>
    ({
      user: { role },
      auth: null,
      instance: { billing: { tier: "solo", trialEndsAt } },
    }) as never;
  expect(billingContext(me("admin", null))).toEqual({
    owner: true,
    trialNeverRan: true,
  });
  expect(billingContext(me("owner", "2026-11-01T00:00:00Z"))).toEqual({
    owner: true,
    trialNeverRan: false,
  });
  expect(billingContext(me("member", null)).owner).toBe(false);
});

it("billingContext follows the banner: an admin with the plan cap is an owner (L3)", () => {
  const me = (role: string, cap: string | null) =>
    ({
      user: { role },
      auth: { method: "google", readOnly: !!cap, cap, expiresAt: null },
      instance: { billing: { tier: "solo", trialEndsAt: null } },
    }) as never;
  expect(billingContext(me("admin", "plan")).owner).toBe(true);
  expect(billingContext(me("owner", null)).owner).toBe(true);
  expect(billingContext(me("member", "plan")).owner).toBe(false);
  // The toast then reads as the banner does: an action, not "ask an owner".
  expect(
    errorCopy(planErr("plan_read_only", reason("lapsed")), "x", {
      ...billingContext(me("admin", "plan")),
    }),
  ).toBe(
    "Your plan has lapsed. This instance is read-only. Manage billing to restart it.",
  );
});

it("a capped admin is an owner but is never offered the trial (cap rule)", () => {
  const me = (role: string, cap: string | null) =>
    ({
      user: { role },
      auth: { method: "google", readOnly: !!cap, cap, expiresAt: null },
      instance: { billing: { tier: "solo", trialEndsAt: null } },
    }) as never;
  expect(billingContext(me("admin", "plan"))).toEqual({ owner: true });
  expect(billingContext(me("admin", null))).toEqual({
    owner: true,
    trialNeverRan: true,
  });
  expect(billingContext(me("owner", null)).trialNeverRan).toBe(true);
  // So a capped admin's refusal doesn't say "Invite someone".
  expect(
    errorCopy(planErr("plan_required", reason("solo")), "x", {
      ...billingContext(me("admin", "plan")),
    }),
  ).toBe("Spaces are a team feature. Choose a plan to continue.");
});

it("plan_required", () => {
  const e = planErr("plan_required", reason("solo"));
  expect(errorCopy(e, "x")).toBe(
    "Spaces are a team feature. This instance is on Solo. Ask an owner to invite someone or choose a plan.",
  );
  expect(errorCopy(e, "x", { owner: true })).toBe(
    "Spaces are a team feature. Choose a plan to continue.",
  );
});

it.each([
  ["storage_bytes", "storage"],
  ["data_docs", "live-data documents per artifact"],
  ["data_daily_writes", "live-data writes per day"],
  ["something_new", "something_new"],
])("plan_limit names %s", (limit, noun) => {
  const e = planErr("plan_limit", { tier: "solo", limit, max: 50 });
  expect(errorCopy(e, "x")).toBe(
    `The Solo plan allows up to 50 ${noun}. Ask your instance owner about a paid plan.`,
  );
  expect(errorCopy(e, "x", { owner: true })).toBe(
    `The Solo plan allows up to 50 ${noun}. Choose a paid plan to raise it.`,
  );
});

it("plan_limit without details falls back to a generic line", () => {
  expect(errorCopy(planErr("plan_limit"), "x")).toBe(
    "The Solo plan's limit is reached. Ask your instance owner about a paid plan.",
  );
});

it("billing_unavailable", () => {
  expect(
    errorCopy(new ApiClientError("billing_unavailable", "s", 503), "x"),
  ).toBe("Billing isn't reachable right now. Try again in a minute.");
});

it("space_forbidden under the plan cap says the instance is read-only", () => {
  const e = planErr("space_forbidden");
  expect(errorCopy(e, "x", { capped: true, cap: "plan" })).toBe(
    "This instance is read-only right now, so you can't publish.",
  );
  expect(errorCopy(e, "x", { capped: true, cap: "restricted" })).toBe(
    "Your account can only view, so you can't publish.",
  );
});
