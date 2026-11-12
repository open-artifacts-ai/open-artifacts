// #953 / #1639: the Plan and billing screens, and the unpaid-Solo (solo_unpaid)
// view-only lock in the dashboard. The owner carries no cap under that lock,
// so useCan and the Library read the billing reason.

import type { ArtifactSummary, Me } from "@oa/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { isSoloPaused, useCan } from "../src/auth/permissions";
import { planStatus } from "../src/settings/Plan";
import { type Column, PlanCompare } from "../src/settings/PlanCompare";
import {
  arts,
  calls,
  findVisibleToast,
  installHarness,
  lastRedirect,
  mountHosted,
  wrapper,
} from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const PAUSED = {
  tier: "solo" as const,
  status: "lapsed" as const,
  trialEndsAt: null,
  graceUntil: null,
  creatorsThisMonth: 1,
  readOnly: true,
  reason: "solo_unpaid" as const,
};
const TRIAL = {
  tier: "solo" as const,
  status: "active" as const,
  trialEndsAt: null,
  soloTrialEndsAt: "2026-12-01T00:00:00.000Z",
  graceUntil: null,
  creatorsThisMonth: 1,
  readOnly: false,
};
const TEAM = {
  tier: "team" as const,
  status: "active" as const,
  trialEndsAt: null,
  graceUntil: null,
  creatorsThisMonth: 4,
  readOnly: false,
};
const FULL = {
  edit: true,
  share: true,
  setVisibility: true,
  delete: true,
  transfer: false,
  move: false,
  dataWrite: true,
};

/** The plan locked the instance for an admin, as the server's cap "plan". */
const lockedAdmin = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "admin" },
  auth: { method: "google", readOnly: true, cap: "plan", expiresAt: null },
});

const meOf = (billing: unknown) => ({ instance: { billing } }) as unknown as Me;

it("isSoloPaused only for solo_unpaid with readOnly", () => {
  expect(isSoloPaused(meOf(PAUSED))).toBe(true);
  expect(isSoloPaused(meOf(TRIAL))).toBe(false);
  expect(isSoloPaused(meOf({ ...PAUSED, reason: "lapsed" }))).toBe(false);
  expect(isSoloPaused(null)).toBe(false);
});

it("useCan turns edit and data writes off for the uncapped owner on a paused Solo, keeps sharing", async () => {
  mountHosted("/", { billing: PAUSED });
  await screen.findByRole("heading", { name: "Library" });
  const a = { ...arts[0], access: "owner", can: FULL } as ArtifactSummary;
  const { result } = renderHook(() => useCan(a), { wrapper });
  await waitFor(() => expect(result.current.edit).toBe(false));
  expect(result.current).toMatchObject({
    edit: false,
    dataWrite: false,
    share: true,
    setVisibility: true,
  });
});

it("useCan leaves the owner alone on a Solo trial", async () => {
  mountHosted("/", { billing: TRIAL });
  await screen.findByRole("heading", { name: "Library" });
  const a = { ...arts[0], access: "owner", can: FULL } as ArtifactSummary;
  const { result } = renderHook(() => useCan(a), { wrapper });
  expect(result.current.edit).toBe(true);
  expect(result.current.dataWrite).toBe(true);
});

it("a paused Solo owner sees the paused prompt and no upload control", async () => {
  mountHosted("/", { billing: PAUSED });
  const banner = within(await screen.findByTestId("plan-banner"));
  expect(
    banner.getByText(
      "Your Solo plan is paused. Keep publishing for $1/month or $10/year.",
    ),
  ).toBeVisible();
  expect(banner.getByRole("link", { name: "Plan and billing" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
});

it("a paused Solo member is told whom to ask, with no billing link", async () => {
  mountHosted("/", { billing: PAUSED }, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
    auth: { method: "google", readOnly: true, cap: "plan", expiresAt: null },
  }));
  const banner = within(await screen.findByTestId("plan-banner"));
  expect(
    banner.getByText(
      "Publishing is paused until this instance's Solo plan is paid. Ask your instance owner.",
    ),
  ).toBeVisible();
  expect(banner.queryByRole("link", { name: "Plan and billing" })).toBeNull();
});

it("the mock refuses a publish with 403 plan_read_only on a paused Solo", async () => {
  mountHosted("/", { billing: PAUSED });
  await screen.findByRole("heading", { name: "Library" });
  const res = await fetch("/api/v1/artifacts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OA-Request": "1" },
    body: JSON.stringify({ title: "x", content: "# x", format: "markdown" }),
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as {
    error: { code: string; details: { reason: string } };
  };
  expect(body.error.code).toBe("plan_read_only");
  expect(body.error.details.reason).toBe("solo_unpaid");
});

it("Plan and billing: a Solo trial shows its end and the two upgrades", async () => {
  // The note hides a date already past: pin Date (timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  onTestFinished(() => {
    vi.useRealTimers();
  });
  mountHosted("/settings/plan", { billing: TRIAL });
  expect(
    await screen.findByRole("heading", { name: "Plan and billing" }),
  ).toBeVisible();
  expect(screen.getAllByText("Solo").length).toBeGreaterThan(0);
  expect(screen.getByText("Free month")).toBeVisible();
  expect(screen.queryByText("Trial")).toBeNull();
  expect(
    screen.getByText(
      "Your free month ends Dec 1, 2026. Then $1/month or $10/year.",
    ),
  ).toBeVisible();
  // Solo is a flat price per instance: no creator count.
  expect(screen.queryByText("Creators this month")).toBeNull();
  expect(screen.getByRole("button", { name: "Upgrade to Team" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Upgrade to Business" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
});

it("Plan and billing: links to how to leave hosted, in a new tab (#2108)", async () => {
  mountHosted("/settings/plan", { billing: TRIAL });
  const link = await screen.findByRole("link", {
    name: /Leaving\? Here's how/,
  });
  expect(link).toHaveAttribute(
    "href",
    "https://open-artifacts.com/docs/hosted/",
  );
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener");
});

it("Plan and billing: Team shows Manage billing, which opens the portal", async () => {
  const posts = calls("POST");
  mountHosted("/settings/plan", { billing: TEAM });
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage billing" }),
  );
  await waitFor(() =>
    expect(lastRedirect).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_mock_portal",
    ),
  );
  expect(posts.some((c) => c.path.endsWith("/billing/portal"))).toBe(true);
  expect(screen.getByText("4")).toBeVisible();
});

it("Plan and billing: a paid plan with no Stripe customer has no Manage billing", async () => {
  mountHosted("/settings/plan", { billing: { ...TEAM, hasCustomer: false } });
  expect(
    await screen.findByText(/Open Artifacts set up this plan for you/),
  ).toBeVisible();
  const card = within(document.getElementById("plan-card") as HTMLElement);
  expect(card.queryByText("Price")).toBeNull();
  expect(screen.getByText("Creators this month")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
  expect(screen.queryByText(/Invoices and card/)).toBeNull();
});

it("Plan and billing: hasCustomer true or unknown keeps Manage billing", async () => {
  mountHosted("/settings/plan", { billing: { ...TEAM, hasCustomer: true } });
  expect(
    await screen.findByRole("button", { name: "Manage billing" }),
  ).toBeVisible();
  cleanup();
  mountHosted("/settings/plan", { billing: TEAM });
  expect(
    await screen.findByRole("button", { name: "Manage billing" }),
  ).toBeVisible();
});

it("Plan and billing: a solo plan with no customer still offers Checkout", async () => {
  mountHosted("/settings/plan", { billing: { ...TRIAL, hasCustomer: false } });
  expect(
    await screen.findByRole("button", { name: "Upgrade to Team" }),
  ).toBeVisible();
  expect(screen.queryByText(/set up this plan for you/)).toBeNull();
});

describe("Plan and billing: Manage billing for Solo (#2127)", () => {
  const PAID = { ...TRIAL, soloTrialEndsAt: null, hasCustomer: true };
  const manage = () => screen.queryByRole("button", { name: "Manage billing" });
  const pay = () => screen.queryByRole("button", { name: "Pay $1/month" });
  const pinNovember = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
  };
  const payShown = async () => {
    expect(
      await screen.findByRole("button", { name: "Pay $1/month" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Pay $10/year" })).toBeVisible();
    expect(manage()).toBeNull();
  };
  it("paid Solo (customer, active, no free month): only Manage billing, primary", async () => {
    mountHosted("/settings/plan", { billing: PAID });
    const b = await screen.findByRole("button", { name: "Manage billing" });
    expect(b).toBeVisible();
    expect(b.className).toContain("bg-primary");
    expect(pay()).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay $10/year" })).toBeNull();
    expect(screen.queryByText(/set up this plan for you/)).toBeNull();
  });
  it("a Solo in its free month with soloCheckedOut: Manage billing and the first charge date, no Pay", async () => {
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, hasCustomer: true, soloCheckedOut: true },
    });
    expect(
      await screen.findByRole("button", { name: "Manage billing" }),
    ).toBeVisible();
    expect(screen.getByText("First charge on Dec 1, 2026.")).toBeVisible();
    expect(screen.getByText("Your free month ends Dec 1, 2026.")).toBeVisible();
    expect(screen.queryByText(/Then \$1\/month/)).toBeNull();
    expect(pay()).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay $10/year" })).toBeNull();
  });
  it("a free-month Solo with soloCheckedOut false or absent keeps Pay and no charge date", async () => {
    for (const extra of [{ soloCheckedOut: false }, {}]) {
      cleanup();
      mountHosted("/settings/plan", {
        billing: { ...TRIAL, hasCustomer: true, ...extra },
      });
      await payShown();
      expect(screen.queryByText(/First charge on/)).toBeNull();
    }
  });
  describe("a scheduled cancel (cancelsAt)", () => {
    const ENDS = "2026-12-20T00:00:00.000Z";
    const NOTE =
      "Your plan ends on Dec 20, 2026. After that you can still read everything, but nothing new can be published or edited. To keep it, resume in Manage billing.";
    it("a free-month Solo that cancelled: the pill, the warning in place of the free-month banner, Manage billing, no first charge", async () => {
      mountHosted("/settings/plan", {
        billing: {
          ...TRIAL,
          hasCustomer: true,
          soloCheckedOut: true,
          cancelsAt: ENDS,
        },
      });
      expect(await screen.findByText(NOTE)).toBeVisible();
      expect(screen.getByText("Ends Dec 20")).toBeVisible();
      expect(screen.queryByText("Free month")).toBeNull();
      expect(screen.queryByText(/Your free month ends/)).toBeNull();
      expect(screen.queryByText(/First charge on/)).toBeNull();
      expect(screen.queryByText(/^Ends on /)).toBeNull();
      expect(screen.queryByText(/Then \$1\/month/)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Manage billing" }),
      ).toBeVisible();
      expect(pay()).toBeNull();
    });
    it("a paid Solo that cancelled", async () => {
      mountHosted("/settings/plan", { billing: { ...PAID, cancelsAt: ENDS } });
      expect(await screen.findByText(NOTE)).toBeVisible();
      expect(screen.getByText("Ends Dec 20")).toBeVisible();
      expect(screen.queryByText("Active")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Manage billing" }),
      ).toBeVisible();
    });
    it("a Team plan that cancelled", async () => {
      mountHosted("/settings/plan", {
        billing: { ...TEAM, hasCustomer: true, cancelsAt: ENDS },
      });
      expect(await screen.findByText(NOTE)).toBeVisible();
      expect(screen.getByText("Ends Dec 20")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Manage billing" }),
      ).toBeVisible();
    });
    it("a Business plan that cancelled", async () => {
      mountHosted("/settings/plan", {
        billing: {
          ...TEAM,
          tier: "business",
          hasCustomer: true,
          cancelsAt: ENDS,
        },
      });
      expect(await screen.findByText(NOTE)).toBeVisible();
    });
    it("null, absent or a past date: the Active pill and no warning", async () => {
      for (const cancelsAt of [null, undefined, "2026-01-01T00:00:00.000Z"]) {
        cleanup();
        mountHosted("/settings/plan", {
          billing: { ...TEAM, hasCustomer: true, cancelsAt },
        });
        await screen.findByRole("button", { name: "Manage billing" });
        expect(screen.getByText("Active")).toBeVisible();
        expect(screen.queryByText(/^Ends /)).toBeNull();
        expect(screen.queryByText(/Your plan ends on/)).toBeNull();
      }
    });
    it("planStatus: a warn pill and a warning note; a read-only plan keeps its own status", () => {
      const r = planStatus({ ...TEAM, cancelsAt: ENDS });
      expect(r.pill).toEqual({ label: "Ends Dec 20", tone: "warn" });
      expect(r.note).toEqual({ tone: "warning", text: NOTE });
      expect(
        planStatus({
          ...TEAM,
          readOnly: true,
          reason: "suspended",
          cancelsAt: ENDS,
        }).pill.label,
      ).toBe("Suspended");
    });
  });
  describe("the price a paying plan pays and its renewal (#2135)", () => {
    const RENEWS = "2027-12-01T00:00:00.000Z";
    const priceRow = () => screen.getByText("Price").nextElementSibling;
    it("a paid Solo on the yearly interval", async () => {
      mountHosted("/settings/plan", {
        billing: {
          ...PAID,
          soloCheckedOut: true,
          interval: "year",
          renewsAt: RENEWS,
        },
      });
      await screen.findByRole("button", { name: "Manage billing" });
      expect(priceRow()).toHaveTextContent("$10 a year, renews Dec 1, 2027");
    });
    it("a paid Solo on the monthly interval", async () => {
      mountHosted("/settings/plan", {
        billing: {
          ...PAID,
          soloCheckedOut: true,
          interval: "month",
          renewsAt: "2026-12-01T00:00:00.000Z",
        },
      });
      await screen.findByRole("button", { name: "Manage billing" });
      expect(priceRow()).toHaveTextContent("$1 a month, renews Dec 1, 2026");
    });
    it("a free-month Solo with a card on file (soloCheckedOut)", async () => {
      mountHosted("/settings/plan", {
        billing: {
          ...TRIAL,
          hasCustomer: true,
          soloCheckedOut: true,
          interval: "year",
          renewsAt: RENEWS,
        },
      });
      await screen.findByRole("button", { name: "Manage billing" });
      expect(priceRow()).toHaveTextContent("$10 a year");
      expect(screen.queryByText(/renews/)).toBeNull();
      expect(screen.getByText("First charge on Dec 1, 2026.")).toBeVisible();
    });
    it("a no-card Solo trial shows no renewal, whatever billing sends", async () => {
      mountHosted("/settings/plan", {
        billing: { ...TRIAL, interval: "month", renewsAt: RENEWS },
      });
      await payShown();
      expect(priceRow()).toHaveTextContent("$1 a month or $10 a year");
      expect(screen.queryByText(/renews/)).toBeNull();
    });
    it("Team and Business show the per-creator price and interval", async () => {
      for (const [tier, interval, text] of [
        ["team", "month", "$10 per creator per month, renews Dec 1, 2027"],
        ["team", "year", "$100 per creator per year, renews Dec 1, 2027"],
        ["business", "month", "$25 per creator per month, renews Dec 1, 2027"],
        ["business", "year", "$250 per creator per year, renews Dec 1, 2027"],
      ] as const) {
        cleanup();
        mountHosted("/settings/plan", {
          billing: {
            ...TEAM,
            tier,
            hasCustomer: true,
            interval,
            renewsAt: RENEWS,
          },
        });
        await screen.findByRole("button", { name: "Manage billing" });
        expect(priceRow(), `${tier} ${interval}`).toHaveTextContent(text);
      }
    });
    it("without renewsAt or interval (a cancel, an older answer) the price row is unchanged", async () => {
      for (const extra of [
        {},
        { interval: "year" as const, renewsAt: null },
        { interval: null, renewsAt: RENEWS },
      ]) {
        cleanup();
        mountHosted("/settings/plan", {
          billing: { ...TEAM, hasCustomer: true, ...extra },
        });
        await screen.findByRole("button", { name: "Manage billing" });
        expect(priceRow()).toHaveTextContent("$10 per creator per month");
        expect(screen.queryByText(/renews/)).toBeNull();
      }
    });
  });
  it("a paid Solo past its free month shows no charge date", async () => {
    mountHosted("/settings/plan", { billing: PAID });
    await screen.findByRole("button", { name: "Manage billing" });
    expect(screen.queryByText(/First charge on/)).toBeNull();
  });
  it("a Solo whose free month has passed counts as paid", async () => {
    pinNovember();
    mountHosted("/settings/plan", {
      billing: {
        ...PAID,
        soloTrialEndsAt: "2026-11-01T00:00:00.000Z",
      },
    });
    expect(
      await screen.findByRole("button", { name: "Manage billing" }),
    ).toBeVisible();
    expect(pay()).toBeNull();
  });
  it("trialing Solo with a customer: Pay buttons, no Manage billing", async () => {
    pinNovember();
    mountHosted("/settings/plan", { billing: { ...TRIAL, hasCustomer: true } });
    await payShown();
  });
  it("past_due Solo with a customer: Manage billing (regression guard, shown before too)", async () => {
    mountHosted("/settings/plan", {
      billing: { ...PAID, status: "past_due" },
    });
    expect(
      await screen.findByRole("button", { name: "Manage billing" }),
    ).toBeVisible();
  });
  it("Solo with no customer, or an unknown one: Pay buttons, no Manage billing", async () => {
    mountHosted("/settings/plan", {
      billing: { ...PAID, hasCustomer: false },
    });
    await payShown();
    cleanup();
    const { hasCustomer: _, ...unknown } = PAID;
    mountHosted("/settings/plan", { billing: unknown });
    await payShown();
  });
  it("past_due Solo with no customer: Pay buttons, never the operator line (#2137)", async () => {
    mountHosted("/settings/plan", {
      billing: {
        ...PAUSED,
        status: "past_due",
        readOnly: true,
        hasCustomer: false,
      },
    });
    await payShown();
    expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
    expect(screen.queryByText(/set up this plan for you/)).toBeNull();
  });
  it("paused Solo (solo_unpaid, no customer): Pay buttons, the way the banner points (#2137)", async () => {
    mountHosted("/settings/plan", {
      billing: { ...PAUSED, hasCustomer: false },
    });
    await payShown();
    expect(screen.queryByText(/set up this plan for you/)).toBeNull();
  });
  it("tier free with a customer keeps the Pay buttons", async () => {
    mountHosted("/settings/plan", { billing: { ...PAID, tier: "free" } });
    await payShown();
  });
  it("lapsed Solo with a customer: unchanged", async () => {
    mountHosted("/settings/plan", {
      billing: { ...PAUSED, hasCustomer: true },
    });
    await payShown();
  });
  it("Solo's Upgrade to Team still goes to Checkout, not the portal", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", { billing: PAID });
    fireEvent.click(
      await screen.findByRole("button", { name: "Upgrade to Team" }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/billing/checkout"))).toBe(
        true,
      ),
    );
    expect(posts.some((c) => c.path.endsWith("/billing/portal"))).toBe(false);
  });
  it("clicking Solo's Manage billing opens the portal", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", { billing: PAID });
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage billing" }),
    );
    await waitFor(() =>
      expect(lastRedirect).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_mock_portal",
      ),
    );
    expect(posts.some((c) => c.path.endsWith("/billing/portal"))).toBe(true);
  });
});

it("Plan and billing: Upgrade starts Checkout for the chosen tier", async () => {
  const posts = calls("POST");
  mountHosted("/settings/plan", { billing: TRIAL });
  fireEvent.click(
    await screen.findByRole("button", { name: "Upgrade to Team" }),
  );
  await waitFor(() =>
    expect(lastRedirect).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_mock_checkout",
    ),
  );
  expect(posts.find((c) => c.path.endsWith("/billing/checkout"))?.body).toEqual(
    { tier: "team" },
  );
});

it("Plan and billing: a 503 billing_unavailable toasts and stays", async () => {
  mountHosted("/settings/plan", { billing: TRIAL, billingDown: true });
  fireEvent.click(
    await screen.findByRole("button", { name: "Upgrade to Business" }),
  );
  await findVisibleToast(
    "Billing isn't reachable right now. Try again in a minute.",
  );
  expect(lastRedirect).not.toHaveBeenCalled();
});

it("Plan and billing: a paused Solo says so and offers the upgrades", async () => {
  mountHosted("/settings/plan", { billing: PAUSED });
  expect(await screen.findByText("Paused")).toBeVisible();
  expect(
    within(screen.getByTestId("plan-banner")).getByText(
      "Your Solo plan is paused. Keep publishing for $1/month or $10/year.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Pay $1/month" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Pay $10/year" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Upgrade to Team" })).toBeVisible();
});

it("Plan and billing: Pay $10/year starts Solo Checkout with the year interval", async () => {
  const posts = calls("POST");
  mountHosted("/settings/plan", { billing: TRIAL });
  fireEvent.click(await screen.findByRole("button", { name: "Pay $10/year" }));
  await waitFor(() =>
    expect(lastRedirect).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_mock_checkout_solo_year",
    ),
  );
  expect(posts.find((c) => c.path.endsWith("/billing/checkout"))?.body).toEqual(
    { tier: "solo", interval: "year" },
  );
});

it("Plan and billing: Team and Business pay no Solo prices", async () => {
  mountHosted("/settings/plan", { billing: TEAM });
  await screen.findByRole("button", { name: "Manage billing" });
  expect(screen.queryByRole("button", { name: /Pay \$/ })).toBeNull();
});

it("owners and admins reach Plan and billing while the instance is locked at the plan cap", async () => {
  cleanup();
  mountHosted(
    "/settings/plan",
    {
      billing: {
        tier: "trial",
        status: "lapsed",
        trialEndsAt: null,
        graceUntil: null,
        readOnly: true,
        reason: "trial_ended",
      },
    },
    lockedAdmin,
  );
  expect(
    await screen.findByRole("heading", { name: "Plan and billing" }),
  ).toBeVisible();
  // The tab is in the settings nav and the buttons are live, not locked.
  expect(
    screen.getByRole("button", { name: "Upgrade to Business" }),
  ).toBeEnabled();
});

it("a member is sent away from Plan and billing", async () => {
  const router = mountHosted("/settings/plan", { billing: TEAM }, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
  }));
  await waitFor(() =>
    expect(router.state.location.pathname).not.toBe("/settings/plan"),
  );
});

it("self-hosted installs have no Plan and billing tab", async () => {
  mountHosted("/settings/profile", { selfHosted: true });
  await screen.findByRole("heading", { name: "Settings" });
  expect(screen.queryByRole("link", { name: "Plan and billing" })).toBeNull();
});

it("Plan and billing: an ended trial is titled Trial ended, with no price row", async () => {
  mountHosted(
    "/settings/plan",
    {
      billing: {
        tier: "trial",
        status: "lapsed",
        trialEndsAt: null,
        graceUntil: null,
        readOnly: true,
        reason: "trial_ended",
      },
    },
    lockedAdmin,
  );
  expect(await screen.findByText("Trial ended")).toBeVisible();
  expect(screen.queryByText("Business trial")).toBeNull();
  // The plan card's price row. (The stacked comparison has its own Price rows.)
  const card = document.getElementById("plan-card") as HTMLElement;
  expect(within(card).queryByText("Price", { selector: "dt" })).toBeNull();
});

it("Plan and billing: Pay $1/month is the primary button, the rest are outline", async () => {
  mountHosted("/settings/plan", { billing: TRIAL });
  const month = await screen.findByRole("button", { name: "Pay $1/month" });
  const cls = (n: string) =>
    screen.getByRole("button", { name: n }).getAttribute("data-variant");
  expect(month.getAttribute("data-variant")).toBe("default");
  for (const n of ["Pay $10/year", "Upgrade to Business"])
    expect(cls(n)).toBe("outline");
  // #2007: Team is the plan for most teams, so its card's button leads.
  expect(cls("Upgrade to Team")).toBe("default");
});

it("Plan and billing: the footer scopes per-creator billing to Team and Business", async () => {
  mountHosted("/settings/plan", { billing: TRIAL });
  expect(
    await screen.findByText(
      "Team and Business bill per creator: people who publish or edit live data in a month. Viewers are free.",
    ),
  ).toBeVisible();
});

it("Plan and billing: a lapsed Team restarts through Checkout, its own tier primary", async () => {
  const posts = calls("POST");
  mountHosted("/settings/plan", {
    billing: {
      ...TEAM,
      status: "lapsed",
      readOnly: true,
      reason: "lapsed",
    },
  });
  const restart = await screen.findByRole("button", { name: "Restart Team" });
  expect(restart.getAttribute("data-variant")).toBe("default");
  expect(
    screen
      .getByRole("button", { name: "Switch to Business" })
      .getAttribute("data-variant"),
  ).toBe("outline");
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
  fireEvent.click(restart);
  await waitFor(() =>
    expect(lastRedirect).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_mock_checkout",
    ),
  );
  expect(posts.find((c) => c.path.endsWith("/billing/checkout"))?.body).toEqual(
    { tier: "team" },
  );
});

it("Plan and billing: a lapsed Team card says why, with no date it doesn't carry", async () => {
  mountHosted("/settings/plan", {
    billing: { ...TEAM, status: "lapsed", readOnly: true, reason: "lapsed" },
  });
  expect(
    await screen.findByText("Your Team plan ended. Restart it to edit again."),
  ).toBeVisible();
});

it("Plan and billing: a lapsed Business card names Business", async () => {
  mountHosted("/settings/plan", {
    billing: {
      ...TEAM,
      tier: "business",
      status: "lapsed",
      readOnly: true,
      reason: "lapsed",
    },
  });
  expect(
    await screen.findByText(
      "Your Business plan ended. Restart it to edit again.",
    ),
  ).toBeVisible();
});

/** Scroll geometry for the table's scroll box (jsdom has no layout). */
const box = { scrollWidth: 0, clientWidth: 0, scrollLeft: 0 };
const geometry = (k: keyof typeof box) => ({
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset.slot === "table-container" ? box[k] : 0;
  },
  set(this: HTMLElement, v: number) {
    if (this.dataset.slot === "table-container") box[k] = v;
  },
});
const observers: {
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  fire: () => void;
}[] = [];
const fit = (scrollWidth: number, clientWidth: number, scrollLeft = 0) =>
  Object.assign(box, { scrollWidth, clientWidth, scrollLeft });
const scrollTo = (left: number) => {
  box.scrollLeft = left;
  fireEvent.scroll(
    document.querySelector('[data-slot="table-container"]') as HTMLElement,
  );
};

describe("the comparison table's scroll fade", () => {
  const realRO = globalThis.ResizeObserver;
  beforeAll(() => {
    for (const k of ["scrollWidth", "clientWidth", "scrollLeft"] as const)
      Object.defineProperty(HTMLElement.prototype, k, geometry(k));
    globalThis.ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      fire: () => void;
      constructor(cb: () => void) {
        this.fire = cb;
        observers.push(this);
      }
    } as unknown as typeof ResizeObserver;
  });
  afterAll(() => {
    globalThis.ResizeObserver = realRO;
    for (const k of ["scrollWidth", "clientWidth", "scrollLeft"] as const)
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  });

  it("shows while the table overflows, hides at the scroll end, is inert", async () => {
    fit(600, 300);
    mountHosted("/settings/plan", { billing: TRIAL });
    const fade = await screen.findByTestId("table-fade");
    expect(fade.className).toContain("pointer-events-none");
    expect(fade.getAttribute("aria-hidden")).toBe("true");
    scrollTo(150);
    expect(screen.getByTestId("table-fade")).toBeVisible();
    // The last column is in view (within 1px): the fade is gone.
    scrollTo(299.5);
    await waitFor(() => expect(screen.queryByTestId("table-fade")).toBeNull());
    // Scrolling back brings it back.
    scrollTo(0);
    await screen.findByTestId("table-fade");
  });

  it("is absent when the table doesn't overflow", async () => {
    fit(300, 300);
    mountHosted("/settings/plan", { billing: TRIAL });
    await screen.findByRole("button", { name: "Pay $1/month" });
    expect(screen.queryByTestId("table-fade")).toBeNull();
  });

  it("follows a resize: the fade appears once the table starts to overflow", async () => {
    fit(300, 300);
    observers.length = 0;
    mountHosted("/settings/plan", { billing: TRIAL });
    await screen.findByRole("button", { name: "Pay $1/month" });
    expect(screen.queryByTestId("table-fade")).toBeNull();
    fit(600, 300);
    act(() => {
      for (const o of observers) o.fire();
    });
    await screen.findByTestId("table-fade");
  });

  it("observes the table as well as its box", async () => {
    fit(600, 300);
    observers.length = 0;
    mountHosted("/settings/plan", { billing: TRIAL });
    await screen.findByTestId("table-fade");
    const seen = observers.flatMap((o) =>
      o.observe.mock.calls.map((c) => c[0]),
    );
    expect(seen.some((n) => (n as HTMLElement).tagName === "TABLE")).toBe(true);
    expect(
      seen.some((n) => (n as HTMLElement).dataset.slot === "table-container"),
    ).toBe(true);
  });

  it("cleans up on unmount: scroll listener removed, observer disconnected", async () => {
    fit(600, 300);
    observers.length = 0;
    const remove = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    mountHosted("/settings/plan", { billing: TRIAL });
    await screen.findByTestId("table-fade");
    cleanup();
    expect(observers.some((o) => o.disconnect.mock.calls.length > 0)).toBe(
      true,
    );
    expect(remove.mock.calls.some(([type, ,]) => type === "scroll")).toBe(true);
    remove.mockRestore();
  });
});

it("planStatus: a lapsed solo_unpaid plan reads Paused", () => {
  expect(planStatus(PAUSED).pill).toEqual({ label: "Paused", tone: "warn" });
});

it("planStatus: a past_due Team gets the past-due note", () => {
  const r = planStatus({
    ...TEAM,
    status: "past_due",
    graceUntil: "2026-11-20T00:00:00.000Z",
  });
  expect(r.pill.label).toBe("Past due");
  expect(r.note?.text).toBe(
    "Payment failed. Update your card by Nov 20, 2026. After that, this instance becomes read-only.",
  );
});

describe("planStatus: the Solo month and the Team trial are separate dates", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("a Solo trial reads soloTrialEndsAt", () => {
    const r = planStatus(TRIAL);
    // #1843: not "Trial", the Team trial's word.
    expect(r.pill.label).toBe("Free month");
    expect(r.note?.text).toBe(
      "Your free month ends Dec 1, 2026. Then $1/month or $10/year.",
    );
  });

  it("a Solo row with a used Business trial shows no note and the Active pill", () => {
    const used = {
      ...TRIAL,
      trialEndsAt: "2026-10-01T00:00:00.000Z",
      soloTrialEndsAt: null,
    };
    expect(planStatus(used)).toEqual({ pill: { label: "Active", tone: "ok" } });
    // An older answer carries no soloTrialEndsAt at all.
    const { soloTrialEndsAt: _, ...old } = used;
    expect(planStatus(old)).toEqual({ pill: { label: "Active", tone: "ok" } });
  });

  it("a paused Solo with a used Business trial reads Paused, no note", () => {
    expect(
      planStatus({ ...PAUSED, trialEndsAt: "2026-10-01T00:00:00.000Z" }),
    ).toEqual({ pill: { label: "Paused", tone: "warn" } });
  });

  it("a Solo month already past shows no note", () => {
    expect(
      planStatus({ ...TRIAL, soloTrialEndsAt: "2026-11-01T00:00:00.000Z" }),
    ).toEqual({ pill: { label: "Active", tone: "ok" } });
  });

  it("the Team trial keeps trialEndsAt and its Trial pill (#2113)", () => {
    const r = planStatus({
      ...TRIAL,
      tier: "trial",
      trialEndsAt: "2026-11-20T00:00:00.000Z",
      soloTrialEndsAt: null,
    });
    expect(r.pill.label).toBe("Trial");
    expect(r.note?.text).toBe(
      "Trial ends Nov 20, 2026. Everything in Team is on.",
    );
  });
});

// #2007: Design's pricing A in Settings. Cards and a grouped table with a
// Monthly/Yearly toggle, yearly first. The current plan's card says so; higher
// plans upgrade; lower plans have no button.
describe("plan cards and comparison (#2007)", () => {
  const card = (c: string) => screen.getByTestId(`plan-card-${c}`);
  it("opens on yearly; only Solo has a yearly price until Billing makes Team and Business ones", async () => {
    mountHosted("/settings/plan", { billing: TEAM });
    const year = await screen.findByRole("button", { name: "Yearly" });
    expect(year).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 months free on Solo")).toBeVisible();
    expect(card("solo")).toHaveTextContent("$0.83 a month");
    expect(card("solo")).toHaveTextContent("$10 billed yearly");
    expect(card("solo")).toHaveTextContent("2 months free");
    // No price checkout can't charge: Team and Business stay monthly.
    expect(card("team")).toHaveTextContent("$10 per creator a month");
    expect(card("business")).toHaveTextContent("$25 per creator a month");
    expect(screen.queryByText(/\$100|\$250|Proposed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(card("solo")).toHaveTextContent("$1 a month");
    expect(card("solo")).toHaveTextContent("or $10 a year");
    expect(card("team")).toHaveTextContent("$10 per creator a month");
  });

  it("Team: its card is the current plan, Business upgrades through the portal, Solo has no button", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", { billing: TEAM });
    await screen.findByTestId("plan-card-team");
    expect(
      within(card("team")).getByRole("button", { name: "Current plan" }),
    ).toBeDisabled();
    expect(within(card("solo")).queryByRole("button")).toBeNull();
    fireEvent.click(
      within(card("business")).getByRole("button", {
        name: "Upgrade to Business",
      }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/billing/portal"))).toBe(true),
    );
    expect(posts.some((c) => c.path.endsWith("/billing/checkout"))).toBe(false);
  });

  it("with Yearly on, an upgrade sends only the tier: the card showed the monthly price it charges", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", { billing: TRIAL });
    await screen.findByTestId("plan-card-team");
    expect(screen.getByRole("button", { name: "Yearly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(card("team")).toHaveTextContent("$10 per creator a month");
    fireEvent.click(
      within(card("team")).getByRole("button", { name: "Upgrade to Team" }),
    );
    await waitFor(() =>
      expect(
        posts.find((c) => c.path.endsWith("/billing/checkout"))?.body,
      ).toEqual({ tier: "team" }),
    );
  });

  it("the Team trial offers both upgrades and marks Team as the trial (#2113)", async () => {
    mountHosted("/settings/plan", { billing: { ...TEAM, tier: "trial" } });
    await screen.findByTestId("plan-card-business");
    expect(within(card("team")).getByText("Your trial")).toBeVisible();
    expect(within(card("business")).queryByText("Your trial")).toBeNull();
    expect(screen.getByText("Team trial")).toBeVisible();
    expect(
      within(card("team")).getByRole("button", { name: "Upgrade to Team" }),
    ).toBeEnabled();
    expect(
      within(card("business")).getByRole("button", {
        name: "Upgrade to Business",
      }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Current plan" })).toBeNull();
  });

  it("groups the table and tints Team; the current plan's column is named for screen readers", async () => {
    mountHosted("/settings/plan", { billing: TEAM });
    const table = await screen.findByRole("table");
    for (const g of ["Work with agents", "People", "Admin and security"])
      expect(
        within(table).getByRole("columnheader", { name: g }),
      ).toBeVisible();
    const head = within(table).getByRole("columnheader", {
      name: /^Team\s*\(your plan\)$/,
    });
    expect(head.className).toContain("bg-[var(--oa-accent-soft)]");
    expect(within(table).getAllByText("Included").length).toBeGreaterThan(0);
  });

  it("an operator-set plan shows the cards with no buttons", async () => {
    mountHosted("/settings/plan", { billing: { ...TEAM, hasCustomer: false } });
    await screen.findByTestId("plan-card-team");
    for (const c of ["solo", "team", "business"])
      expect(within(card(c)).queryByRole("button")).toBeNull();
  });
});

// Yearly Team and Business when billing says yearlyTeamBusiness: the seat step (#2007).
describe("yearly Team and Business seat step", () => {
  const card = (c: string) => screen.getByTestId(`plan-card-${c}`);
  const checkout = (posts: ReturnType<typeof calls>) =>
    posts.find((c) => c.path.endsWith("/billing/checkout"))?.body;
  const renderPlanCompare = (props: { column: Column }) => {
    const view = (p: { column: Column }) => (
      <PlanCompare
        column={p.column}
        busy={false}
        yearly
        seatsDefault={3}
        upgrade={() => {}}
      />
    );
    const r = render(view(props));
    return { rerender: (p: { column: Column }) => r.rerender(view(p)) };
  };
  const open = async (tier = "Team") => {
    fireEvent.click(
      within(card(tier.toLowerCase())).getByRole("button", {
        name: `Upgrade to ${tier}`,
      }),
    );
    return (await screen.findByLabelText("Creators")) as HTMLInputElement;
  };

  it("shows the yearly prices and asks for seats, defaulting to creatorsThisMonth", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, yearlyTeamBusiness: true, creatorsThisMonth: 7 },
    });
    await screen.findByTestId("plan-card-team");
    expect(card("team")).toHaveTextContent("$8.33 per creator a month");
    expect(card("team")).toHaveTextContent("$100 per creator, billed yearly");
    expect(card("business")).toHaveTextContent("$20.83 per creator a month");
    expect(card("business")).toHaveTextContent(
      "$250 per creator, billed yearly",
    );
    const input = await open();
    expect(
      screen.getByRole("dialog", { name: "How many creators on Team?" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Creators are people who publish or edit live data. Viewers are free. You can change this later in billing.",
      ),
    ).toBeVisible();
    expect(input.value).toBe("7");
    expect(input).toHaveFocus();
    expect(screen.getByText("7 creators × $100 = $700 a year")).toBeVisible();
    fireEvent.change(input, { target: { value: "12" } });
    expect(
      screen.getByText("12 creators × $100 = $1,200 a year"),
    ).toBeVisible();
    expect(checkout(posts)).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(checkout(posts)).toEqual({
        tier: "team",
        interval: "year",
        seats: 12,
      }),
    );
  });

  it("Business prices at $250 and Enter submits", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: { ...TEAM, yearlyTeamBusiness: true, tier: "trial" },
    });
    await screen.findByTestId("plan-card-business");
    const input = await open("Business");
    expect(screen.getByText("4 creators × $250 = $1,000 a year")).toBeVisible();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(checkout(posts)).toEqual({
        tier: "business",
        interval: "year",
        seats: 4,
      }),
    );
  });

  it("defaults to at least 1 creator", async () => {
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, yearlyTeamBusiness: true, creatorsThisMonth: 0 },
    });
    await screen.findByTestId("plan-card-team");
    expect((await open()).value).toBe("1");
  });

  it.each(["0", "10001", "2.5", ""])(
    "refuses %j with an inline error",
    async (v) => {
      const posts = calls("POST");
      mountHosted("/settings/plan", {
        billing: { ...TRIAL, yearlyTeamBusiness: true },
      });
      await screen.findByTestId("plan-card-team");
      const input = await open();
      fireEvent.change(input, { target: { value: v } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Enter a whole number from 1 to 10,000.",
      );
      expect(checkout(posts)).toBeUndefined();
    },
  );

  it("Cancel and Esc send nothing and return focus to the button", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, yearlyTeamBusiness: true },
    });
    await screen.findByTestId("plan-card-team");
    const button = within(card("team")).getByRole("button", {
      name: "Upgrade to Team",
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
    const input = await open();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
    expect(checkout(posts)).toBeUndefined();
  });

  it("formats a large count with a thousands separator", async () => {
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, yearlyTeamBusiness: true },
    });
    await screen.findByTestId("plan-card-team");
    const input = await open();
    fireEvent.change(input, { target: { value: "10000" } });
    expect(
      screen.getByText("10,000 creators × $100 = $1,000,000 a year"),
    ).toBeVisible();
  });

  it("closes the step when the plan changes under it, and reopens at the default", async () => {
    const { rerender } = renderPlanCompare({ column: "solo" });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Team" }));
    fireEvent.change(await screen.findByLabelText("Creators"), {
      target: { value: "9" },
    });
    rerender({ column: "team" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rerender({ column: "solo" });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Team" }));
    expect(
      ((await screen.findByLabelText("Creators")) as HTMLInputElement).value,
    ).toBe("3");
  });

  it("monthly sends only the tier and asks nothing", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, yearlyTeamBusiness: true },
    });
    await screen.findByTestId("plan-card-team");
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    // The yearly alternative is per creator on Team and Business, not on Solo.
    expect(card("team")).toHaveTextContent("or $100 per creator a year");
    expect(card("business")).toHaveTextContent("or $250 per creator a year");
    expect(card("solo")).toHaveTextContent("or $10 a year");
    expect(card("solo")).not.toHaveTextContent("per creator a year");
    fireEvent.click(
      within(card("team")).getByRole("button", { name: "Upgrade to Team" }),
    );
    expect(screen.queryByLabelText("Creators")).toBeNull();
    await waitFor(() => expect(checkout(posts)).toEqual({ tier: "team" }));
  });

  it("a paid plan still goes to the portal with no seat step", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: { ...TEAM, yearlyTeamBusiness: true },
    });
    await screen.findByTestId("plan-card-team");
    fireEvent.click(
      within(card("business")).getByRole("button", {
        name: "Upgrade to Business",
      }),
    );
    expect(screen.queryByLabelText("Creators")).toBeNull();
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/billing/portal"))).toBe(true),
    );
  });

  it("yearlyTeamBusiness absent: sends only the tier and shows no seat step", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", { billing: TRIAL });
    await screen.findByTestId("plan-card-team");
    fireEvent.click(
      within(card("team")).getByRole("button", { name: "Upgrade to Team" }),
    );
    expect(screen.queryByLabelText("Creators")).toBeNull();
    await waitFor(() => expect(checkout(posts)).toEqual({ tier: "team" }));
  });

  it("yearlyTeamBusiness false: sends only the tier and shows no seat step", async () => {
    const posts = calls("POST");
    mountHosted("/settings/plan", {
      billing: { ...TRIAL, yearlyTeamBusiness: false },
    });
    await screen.findByTestId("plan-card-team");
    fireEvent.click(
      within(card("team")).getByRole("button", { name: "Upgrade to Team" }),
    );
    expect(screen.queryByLabelText("Creators")).toBeNull();
    await waitFor(() => expect(checkout(posts)).toEqual({ tier: "team" }));
  });
});

// #2326: a hosted install with no billing answer cannot pay yet.
describe("hosted install with no billing answer", () => {
  const LINE = "Paid plans open soon. We'll email you before anything changes.";

  it("hosted without billing: the line, no buttons", async () => {
    mountHosted("/settings/plan", true, (m) => {
      const { billing: _, ...instance } = m.instance;
      return { ...m, instance };
    });
    expect(await screen.findByText(LINE)).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(screen.queryByTestId("plan-card-team")).toBeNull();
  });

  it("hosted without billing still has the Plan and billing tab", async () => {
    mountHosted("/settings/profile", true, (m) => {
      const { billing: _, ...instance } = m.instance;
      return { ...m, instance };
    });
    expect(
      await screen.findByRole("link", { name: "Plan and billing" }),
    ).toBeVisible();
  });

  it("self-hosted keeps its own line", async () => {
    mountHosted("/settings/plan", { selfHosted: true });
    expect(
      await screen.findByText("This install has no plan to manage."),
    ).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it("hosted with billing is unchanged", async () => {
    mountHosted("/settings/plan", { billing: { ...TRIAL } });
    expect(
      await screen.findByRole("button", { name: "Pay $1/month" }),
    ).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
  });
});
