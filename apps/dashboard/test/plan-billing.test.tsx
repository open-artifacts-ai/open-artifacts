// #953 / #1639: the Plan and billing screens, and the unpaid-Solo (solo_unpaid)
// view-only lock in the dashboard. The owner carries no cap under that lock,
// so useCan and the Library read the billing reason.

import type { ArtifactSummary, Me } from "@oa/shared";
import {
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { isSoloPaused, useCan } from "../src/auth/permissions";
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
  trialEndsAt: "2026-12-01T00:00:00.000Z",
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
      "Your Solo plan is paused. Keep publishing for $1/month or $12/year.",
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
  mountHosted("/settings/plan", { billing: TRIAL });
  expect(
    await screen.findByRole("heading", { name: "Plan and billing" }),
  ).toBeVisible();
  expect(screen.getAllByText("Solo").length).toBeGreaterThan(0);
  expect(
    screen.getByText(
      "Your free month ends Dec 1, 2026. Then $1/month or $12/year.",
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
      "Your Solo plan is paused. Keep publishing for $1/month or $12/year.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Pay $1/month" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Pay $12/year" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Upgrade to Team" })).toBeVisible();
});

it("Plan and billing: Pay $12/year starts Solo Checkout with the year interval", async () => {
  const posts = calls("POST");
  mountHosted("/settings/plan", { billing: TRIAL });
  fireEvent.click(await screen.findByRole("button", { name: "Pay $12/year" }));
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
  expect(screen.queryByText("Price", { selector: "dt" })).toBeNull();
});

it("Plan and billing: Pay $1/month is the primary button, the rest are outline", async () => {
  mountHosted("/settings/plan", { billing: TRIAL });
  const month = await screen.findByRole("button", { name: "Pay $1/month" });
  const cls = (n: string) =>
    screen.getByRole("button", { name: n }).getAttribute("data-variant");
  expect(month.getAttribute("data-variant")).toBe("default");
  for (const n of ["Pay $12/year", "Upgrade to Business", "Upgrade to Team"])
    expect(cls(n)).toBe("outline");
});

it("Plan and billing: the footer scopes per-creator billing to Team and Business", async () => {
  mountHosted("/settings/plan", { billing: TRIAL });
  expect(
    await screen.findByText(
      "Team and Business bill per creator: people who publish or edit live data in a month. Viewers are free.",
    ),
  ).toBeVisible();
});
