// #1838-#1841, #1844: the read-only banner says one thing per reason, with the
// right button (or none), for the owner and for a member; and an invite the
// plan refuses says it is the invite. Copy: Design's Self-serve screens v6,
// decision 3, word for word.

import type { Me, PlanView } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SUPPORT_EMAIL } from "../src/layout/PlanBanner";
import { installHarness, mountHosted } from "./harness";

installHarness();

type Reason = NonNullable<PlanView["reason"]>;

const locked = (reason: Reason): PlanView => ({
  tier: "team",
  status: reason === "suspended" ? "suspended" : "lapsed",
  trialEndsAt: null,
  graceUntil: null,
  creatorsThisMonth: 4,
  readOnly: true,
  reason,
});
/** What the server gives a member of a locked instance: the plan cap. */
const asMember = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "member" },
  auth: { method: "google", readOnly: true, cap: "plan", expiresAt: null },
});

const LINES: Record<
  "lapsed" | "payment_failed" | "suspended" | "billing_unreachable",
  { owner: string; member: string; button: string | null }
> = {
  lapsed: {
    owner:
      "Your plan has lapsed. This instance is read-only. Manage billing to restart it.",
    member:
      "The plan has lapsed, so this instance is read-only. Ask an owner to fix billing. Reading and sharing still work. Nothing has been deleted.",
    button: "Manage billing",
  },
  payment_failed: {
    owner:
      "Payment failed and the grace period has ended. This instance is read-only. Manage billing to update your card.",
    member:
      "A payment failed, so this instance is read-only. Ask an owner to update the card. Reading and sharing still work. Nothing has been deleted.",
    button: "Manage billing",
  },
  suspended: {
    owner:
      "This instance is suspended. Reading and sharing still work. Nothing has been deleted. Contact support to restore it.",
    member:
      "This instance is suspended. Reading and sharing still work. Nothing has been deleted. Ask an owner to contact support.",
    button: "Email support",
  },
  billing_unreachable: {
    owner:
      "We can't reach our billing system, so editing is paused. This is on our side and nothing is wrong with your account. We're working on it.",
    member:
      "Editing is paused while we fix a problem on our side. Nothing is wrong with your account. Reading and sharing still work. Nothing has been deleted.",
    button: null,
  },
};

describe("the read-only banner, per reason", () => {
  for (const [reason, line] of Object.entries(LINES)) {
    it(`${reason}: the owner reads one line and gets ${line.button ?? "no button"}`, async () => {
      mountHosted("/", { billing: locked(reason as Reason) });
      const banner = within(await screen.findByTestId("plan-banner"));
      expect(banner.getByText(line.owner)).toBeVisible();
      if (line.button === null) {
        // Our outage: nothing the owner can do about it.
        expect(banner.queryByRole("link")).toBeNull();
        expect(banner.queryByRole("button")).toBeNull();
      } else {
        const action = banner.getByRole("link", { name: line.button });
        expect(action).toBeVisible();
        // The one old label is gone for these reasons.
        expect(banner.queryByRole("link", { name: "Plan and billing" })).toBe(
          null,
        );
        if (reason === "suspended")
          expect(action).toHaveAttribute("href", `mailto:${SUPPORT_EMAIL}`);
        else expect(action).toHaveAttribute("href", "/settings/plan");
      }
    });

    it(`${reason}: a member reads the member line and gets no button`, async () => {
      mountHosted("/", { billing: locked(reason as Reason) }, asMember);
      const banner = within(await screen.findByTestId("plan-banner"));
      expect(banner.getByText(line.member)).toBeVisible();
      expect(banner.queryByRole("link")).toBeNull();
      expect(banner.queryByRole("button")).toBeNull();
    });
  }

  it("lapsed and payment_failed owners get different lines", () => {
    expect(LINES.lapsed.owner).not.toBe(LINES.payment_failed.owner);
    expect(LINES.lapsed.member).not.toBe(LINES.payment_failed.member);
  });

  it("every member line says what still works (#1844)", () => {
    for (const reason of ["lapsed", "payment_failed"] as const)
      expect(LINES[reason].member).toMatch(
        /Reading and sharing still work\. Nothing has been deleted\.$/,
      );
  });

  it("trial_ended keeps its copy and the Plan and billing button", async () => {
    mountHosted("/", {
      billing: { ...locked("trial_ended"), tier: "trial" },
    });
    const banner = within(await screen.findByTestId("plan-banner"));
    expect(
      banner.getByText(
        "Your trial ended, so this instance is read-only until you pick a plan.",
      ),
    ).toBeVisible();
    expect(
      banner.getByRole("link", { name: "Plan and billing" }),
    ).toBeVisible();
  });

  it("no banner, and so no support link, when the plan isn't read-only", async () => {
    mountHosted("/", {
      billing: { ...locked("lapsed"), readOnly: false, reason: undefined },
    });
    await screen.findByRole("heading", { name: "Library" });
    expect(screen.queryByTestId("plan-banner")).toBeNull();
  });
});

describe("an invite the plan refuses (#1838)", () => {
  it("names the invite, not Spaces, and doesn't also toast the server's text", async () => {
    // A Solo whose Business trial already ran: the mock refuses the invite
    // with plan_required, as the server does.
    mountHosted("/settings/members", {
      billing: {
        tier: "solo",
        status: "active",
        trialEndsAt: "2026-10-01T00:00:00.000Z",
        soloTrialEndsAt: null,
        graceUntil: null,
        creatorsThisMonth: 1,
        readOnly: false,
        reason: "solo",
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "ana@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));
    expect(
      await within(dialog).findByText(
        "Inviting people is a team feature. Choose a plan to continue.",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText(/Spaces/)).toBeNull();
    // One message, in the dialog: no second toast with the server's wording.
    await waitFor(() =>
      expect(document.querySelector("[data-sonner-toast]")).toBeNull(),
    );
  });
});
