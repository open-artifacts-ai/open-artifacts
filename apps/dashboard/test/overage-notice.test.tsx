// #2246: the failed extra-creator charge notice. Owners and admins see it with
// the months and one total; "Add a card" opens the billing portal; absent
// field, no banner; a member sees nothing.

import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { monthList } from "../src/layout/OverageNotice";
import { calls, installHarness, lastRedirect, mountHosted } from "./harness";

installHarness();
const Y = new Date().getUTCFullYear();

const TEAM = {
  tier: "team" as const,
  status: "active" as const,
  trialEndsAt: null,
  graceUntil: null,
  hasCustomer: true,
  creatorsThisMonth: 9,
  readOnly: false,
};
const asMember = (m: Me): Me => ({ ...m, user: { ...m.user, role: "member" } });

describe("extra-creator charge notice (#2246)", () => {
  it("absent field: no notice", async () => {
    mountHosted("/settings/plan", { billing: TEAM });
    await screen.findByText("Plan and billing");
    expect(screen.queryByTestId("overage-notice")).toBeNull();
  });

  it("one month: names the month and the amount", async () => {
    mountHosted("/settings/plan", {
      billing: {
        ...TEAM,
        overageDue: { amountCents: 4200, months: [`${Y}-10`] },
      },
    });
    const n = within(await screen.findByTestId("overage-notice"));
    expect(
      n.getByText(
        "Extra creators for October are waiting to be charged ($42). Add a card to settle it.",
      ),
    ).toBeVisible();
  });

  it("several months: lists them with one total", async () => {
    mountHosted("/settings/plan", {
      billing: {
        ...TEAM,
        overageDue: { amountCents: 11850, months: [`${Y}-09`, `${Y}-10`] },
      },
    });
    const n = within(await screen.findByTestId("overage-notice"));
    expect(
      n.getByText(
        "Extra creators for September and October are waiting to be charged ($118.50). Add a card to settle it.",
      ),
    ).toBeVisible();
  });

  it("three months: a list with and before the last", async () => {
    mountHosted("/settings/plan", {
      billing: {
        ...TEAM,
        overageDue: {
          amountCents: 15000,
          months: [`${Y}-08`, `${Y}-09`, `${Y}-10`],
        },
      },
    });
    const n = within(await screen.findByTestId("overage-notice"));
    expect(
      n.getByText(
        "Extra creators for August, September and October are waiting to be charged ($150). Add a card to settle it.",
      ),
    ).toBeVisible();
  });

  it("Add a card opens the billing portal", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: {
        ...TEAM,
        overageDue: { amountCents: 4200, months: [`${Y}-10`] },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add a card" }));
    await waitFor(() =>
      expect(lastRedirect).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_mock_portal",
      ),
    );
    expect(posts.some((c) => c.path.endsWith("/billing/portal"))).toBe(true);
  });

  it("a member sees nothing", async () => {
    mountHosted(
      "/",
      {
        billing: {
          ...TEAM,
          overageDue: { amountCents: 4200, months: [`${Y}-10`] },
        },
      },
      asMember,
    );
    await screen.findByRole("heading", { name: "Library" });
    expect(screen.queryByTestId("overage-notice")).toBeNull();
  });
});

describe("monthList", () => {
  it("joins names", () => {
    expect(monthList([`${Y}-08`, `${Y}-09`, `${Y}-10`])).toBe(
      "August, September and October",
    );
  });
});
