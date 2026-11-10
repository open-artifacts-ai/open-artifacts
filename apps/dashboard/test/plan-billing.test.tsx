// #953 / #1639: the Plan and billing screens, and the unpaid-Solo (solo_unpaid)
// view-only lock in the dashboard. The owner carries no cap under that lock,
// so useCan and the Library read the billing reason.

import type { ArtifactSummary, Me } from "@oa/shared";
import {
  act,
  cleanup,
  fireEvent,
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
  for (const n of ["Pay $10/year", "Upgrade to Business", "Upgrade to Team"])
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

describe("planStatus: the Solo month and the Business trial are separate dates", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("a Solo trial reads soloTrialEndsAt", () => {
    const r = planStatus(TRIAL);
    // #1843: not "Trial", the Business trial's word.
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

  it("the Business trial keeps trialEndsAt and its Trial pill", () => {
    const r = planStatus({
      ...TRIAL,
      tier: "trial",
      trialEndsAt: "2026-11-20T00:00:00.000Z",
      soloTrialEndsAt: null,
    });
    expect(r.pill.label).toBe("Trial");
    expect(r.note?.text).toBe(
      "Trial ends Nov 20, 2026. Everything in Business is on.",
    );
  });
});

// #1837: at 390px the comparison used to cut off Team and Business and the
// Solo price. Below the sm breakpoint it stacks, one block per plan with every
// row in full; from sm up it is the table. jsdom has no CSS, so these pin the
// structure and the breakpoint classes; e2e/billing-ui.spec.ts measures it.
describe("the comparison on a phone (#1837)", () => {
  it("stacks every plan with every row, none cut off", async () => {
    mountHosted("/settings/plan", { billing: TEAM });
    const stack = await screen.findByTestId("compare-stacked");
    expect(stack.className).toContain("sm:hidden");
    for (const plan of ["Solo", "Team", "Business"])
      expect(
        within(stack).getByRole("heading", { name: plan }),
      ).toBeInTheDocument();
    // The Solo price in full, not "$1 a month or $10 a year, pe".
    expect(
      within(stack).getByText("$1 a month or $10 a year, per instance"),
    ).toBeInTheDocument();
    expect(within(stack).getByText("$10 per creator")).toBeInTheDocument();
    expect(within(stack).getByText("$25 per creator")).toBeInTheDocument();
    // 5 rows for each of the 3 plans.
    expect(within(stack).getAllByRole("term")).toHaveLength(15);
    expect(within(stack).getAllByRole("definition")).toHaveLength(15);
  });

  it("marks the current plan and no other", async () => {
    mountHosted("/settings/plan", { billing: TEAM });
    const stack = await screen.findByTestId("compare-stacked");
    const current = stack.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Team");
  });

  it("the table shows only from sm up", async () => {
    mountHosted("/settings/plan", { billing: TEAM });
    const table = await screen.findByRole("table");
    expect(table.closest('[data-testid="compare-table"]')?.className).toContain(
      "hidden sm:block",
    );
  });
});
