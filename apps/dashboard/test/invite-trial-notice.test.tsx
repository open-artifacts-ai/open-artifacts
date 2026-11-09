// #1836: the first invite on an instance whose Business trial never ran starts
// that 14-day trial (the server's trialEligible). The invite dialog says so
// with Design's approved copy (Self-serve screens v6, decision 2), and only
// then: billing active, a Solo instance, trial never used, caller sees the
// billing details (owner or admin).

import type { Me, PlanView } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { trialEndsOn, trialWouldStart } from "../src/api/trial";
import { calls, installHarness, mountHosted } from "./harness";

installHarness();

const SOLO: PlanView = {
  tier: "solo",
  status: "active",
  trialEndsAt: null,
  soloTrialEndsAt: "2026-12-01T00:00:00.000Z",
  graceUntil: null,
  creatorsThisMonth: 1,
  readOnly: false,
  reason: "solo",
};
const NOTICE = "This starts your 14-day trial of Business.";
const START = "Send invite and start trial";

const pin = (iso: string) => {
  // Only Date is pinned: timers stay real so the app's async work still runs.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  onTestFinished(() => {
    vi.useRealTimers();
  });
};

const openInvite = async (billing: PlanView) => {
  mountHosted("/settings/members", { billing });
  fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
  return screen.findByRole("dialog");
};

const meOf = (billing: PlanView | undefined) =>
  ({ instance: { billing } }) as unknown as Me;

describe("trialWouldStart", () => {
  it("is true for a Solo instance whose Business trial never ran", () => {
    expect(trialWouldStart(meOf(SOLO))).toBe(true);
    // A server from before Solo called this tier free.
    expect(trialWouldStart(meOf({ ...SOLO, tier: "free" }))).toBe(true);
    // The mock's solo fixture carries no reason.
    expect(trialWouldStart(meOf({ ...SOLO, reason: undefined }))).toBe(true);
  });

  it("is false once the Business trial ran, on any other tier or lock, or with no billing", () => {
    const at = "2026-10-01T00:00:00.000Z";
    expect(trialWouldStart(meOf({ ...SOLO, trialEndsAt: at }))).toBe(false);
    for (const tier of ["trial", "team", "business"] as const)
      expect(trialWouldStart(meOf({ ...SOLO, tier }))).toBe(false);
    // Paused Solo (solo_unpaid) is view-only: the server starts no trial.
    expect(
      trialWouldStart(
        meOf({ ...SOLO, readOnly: true, reason: "solo_unpaid" as const }),
      ),
    ).toBe(false);
    expect(
      trialWouldStart(meOf({ ...SOLO, readOnly: true, reason: "suspended" })),
    ).toBe(false);
    expect(trialWouldStart(meOf(undefined))).toBe(false);
    expect(trialWouldStart(null)).toBe(false);
    expect(trialWouldStart(undefined)).toBe(false);
  });

  it("is false for someone who is not shown the billing details (status null)", () => {
    // trialEndsAt reads null for them whether or not a trial ran.
    expect(trialWouldStart(meOf({ ...SOLO, status: null }))).toBe(false);
  });
});

describe("trialEndsOn", () => {
  it("is 14 days from now, as a UTC date", () => {
    expect(trialEndsOn(Date.parse("2026-11-09T12:00:00.000Z"))).toBe(
      "Nov 23, 2026",
    );
    // Month and year rollovers.
    expect(trialEndsOn(Date.parse("2026-12-25T00:00:00.000Z"))).toBe(
      "Jan 8, 2027",
    );
  });

  it("flips at UTC midnight, not before", () => {
    expect(trialEndsOn(Date.parse("2026-11-09T23:59:59.999Z"))).toBe(
      "Nov 23, 2026",
    );
    expect(trialEndsOn(Date.parse("2026-11-10T00:00:00.000Z"))).toBe(
      "Nov 24, 2026",
    );
  });
});

describe("the invite dialog", () => {
  it("names the trial, its end and the button when the trial never ran", async () => {
    pin("2026-11-09T12:00:00.000Z");
    const dialog = await openInvite(SOLO);
    expect(within(dialog).getByText(NOTICE)).toBeVisible();
    expect(within(dialog).getByText("Trial ends Nov 23, 2026.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: START })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: "Add member" })).toBe(
      null,
    );
  });

  it("the trial date follows the clock", async () => {
    pin("2026-11-10T00:00:00.000Z");
    const dialog = await openInvite(SOLO);
    expect(within(dialog).getByText("Trial ends Nov 24, 2026.")).toBeVisible();
  });

  it("the start button sends the same invite as Add member does", async () => {
    pin("2026-11-09T12:00:00.000Z");
    const posts = calls("POST");
    const dialog = await openInvite(SOLO);
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "ana@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: START }));
    await waitFor(() =>
      expect(posts.some((p) => p.path.endsWith("/members"))).toBe(true),
    );
    expect(posts.find((p) => p.path.endsWith("/members"))?.body).toEqual({
      email: "ana@example.com",
      role: "member",
    });
  });

  it("an admin, who also sees the billing details, gets it too", async () => {
    pin("2026-11-09T12:00:00.000Z");
    mountHosted("/settings/members", { billing: SOLO, actAs: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(NOTICE)).toBeVisible();
  });

  it("says nothing once the Business trial ran", async () => {
    const dialog = await openInvite({
      ...SOLO,
      trialEndsAt: "2026-10-01T00:00:00.000Z",
    });
    expect(within(dialog).queryByText(NOTICE)).toBe(null);
    expect(within(dialog).queryByText(/Trial ends/)).toBe(null);
    expect(
      within(dialog).getByRole("button", { name: "Add member" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: START })).toBe(null);
  });

  it("says nothing on Team", async () => {
    const dialog = await openInvite({
      ...SOLO,
      tier: "team",
      reason: undefined,
    });
    expect(within(dialog).queryByText(NOTICE)).toBe(null);
    expect(within(dialog).queryByRole("button", { name: START })).toBe(null);
  });

  it("says nothing on a paused Solo", async () => {
    const dialog = await openInvite({
      ...SOLO,
      status: "lapsed",
      readOnly: true,
      reason: "solo_unpaid",
    });
    expect(within(dialog).queryByText(NOTICE)).toBe(null);
    expect(within(dialog).queryByRole("button", { name: START })).toBe(null);
  });

  it("says nothing when billing is off (self-hosted)", async () => {
    mountHosted("/settings/members", { selfHosted: true });
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(NOTICE)).toBe(null);
    expect(
      within(dialog).getByRole("button", { name: "Add member" }),
    ).toBeInTheDocument();
  });
});
