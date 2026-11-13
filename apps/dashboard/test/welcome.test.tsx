// #2287: the first open of Welcome (once, 404-safe) and the Solo trial chip.
import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { calendarDaysTo, chipLabel, chipPlan } from "../src/layout/PlanChip";
import { resetWelcomeRedirect } from "../src/library/useWelcomeRedirect";
import {
  calls,
  installHarness,
  mount,
  mountHosted,
  server,
  wait,
} from "./harness";

installHarness();
beforeEach(resetWelcomeRedirect);

const WELCOME = "WmCnEfGhJk4mNpQr";
const state = (over: object = {}) =>
  http.get("*/api/v1/onboarding", () =>
    HttpResponse.json({
      dismissed: true,
      completed: false,
      welcomeId: WELCOME,
      welcomeOpened: false,
      ...over,
    }),
  );
const welcomeArtifact = (over: object = {}) =>
  http.get(`*/api/v1/artifacts/${WELCOME}`, async () => {
    const { fixtures } = await import("@oa/shared/mocks");
    return HttpResponse.json({
      ...fixtures.artifacts[0],
      id: WELCOME,
      title: "Welcome",
      ...over,
    });
  });
const putOnboarding = () =>
  http.put("*/api/v1/onboarding", async ({ request }) =>
    HttpResponse.json({
      dismissed: true,
      completed: false,
      welcomeId: WELCOME,
      welcomeOpened: true,
      ...((await request.json()) as object),
    }),
  );

describe("first open of Welcome", () => {
  it("goes to Welcome once and records it", async () => {
    const puts = calls("PUT");
    server.use(state(), welcomeArtifact(), putOnboarding());
    const router = mount("/");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/a/${WELCOME}`),
    );
    await waitFor(() =>
      expect(puts.find((c) => c.path === "/api/v1/onboarding")?.body).toEqual({
        welcomeOpened: true,
      }),
    );
  });

  it("does not send the Library back to Welcome in the same session", async () => {
    server.use(state(), welcomeArtifact(), putOnboarding());
    const first = mount("/");
    await waitFor(() =>
      expect(first.state.location.pathname).toBe(`/a/${WELCOME}`),
    );
    // The server's answer has not landed anywhere yet: still unopened.
    const second = mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(second.state.location.pathname).toBe("/");
  });

  it("does not pull them off a page they moved to while Welcome loaded", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      state(),
      putOnboarding(),
      http.get(`*/api/v1/artifacts/${WELCOME}`, async () => {
        await held;
        const { fixtures } = await import("@oa/shared/mocks");
        return HttpResponse.json({
          ...fixtures.artifacts[0],
          id: WELCOME,
          title: "Welcome",
        });
      }),
    );
    const router = mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    await router.navigate({ to: "/mine" });
    release();
    await wait(300);
    expect(router.state.location.pathname).toBe("/mine");
  });

  it("leaves the Library alone once it has been opened", async () => {
    const puts = calls("PUT");
    server.use(state({ welcomeOpened: true }), welcomeArtifact());
    const router = mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(router.state.location.pathname).toBe("/");
    expect(puts.filter((c) => c.path === "/api/v1/onboarding")).toHaveLength(0);
  });

  it("leaves the Library alone when no Welcome was seeded", async () => {
    server.use(state({ welcomeId: null }));
    const router = mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("falls back to the Library when Welcome was deleted (404)", async () => {
    const puts = calls("PUT");
    server.use(
      state(),
      putOnboarding(),
      http.get(`*/api/v1/artifacts/${WELCOME}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    const router = mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    await waitFor(() =>
      expect(puts.some((c) => c.path === "/api/v1/onboarding")).toBe(true),
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it("falls back to the Library when Welcome is in the trash", async () => {
    server.use(
      state(),
      putOnboarding(),
      welcomeArtifact({ deletedAt: "2026-01-04T10:00:00.000Z" }),
    );
    const router = mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("does not redirect a member (the state is the owner's)", async () => {
    const puts = calls("PUT");
    const gets = calls("GET");
    const router = mountHosted(
      "/",
      true,
      (m) => ({ ...m, user: { ...m.user, role: "member" } }),
      [state(), welcomeArtifact(), putOnboarding()],
    );
    await wait(400);
    expect(router.state.location.pathname).toBe("/");
    expect(gets.filter((c) => c.path === "/api/v1/onboarding")).toHaveLength(0);
    expect(puts.filter((c) => c.path === "/api/v1/onboarding")).toHaveLength(0);
  });
});

const trialMe =
  (over: object = {}) =>
  (m: Me): Me => ({
    ...m,
    instance: {
      ...m.instance,
      hosted: true,
      billing: {
        tier: "solo",
        status: "active",
        trialEndsAt: null,
        soloTrialEndsAt: new Date(Date.now() + 29.5 * 86_400_000).toISOString(),
        graceUntil: null,
        readOnly: false,
        ...over,
      },
    } as Me["instance"],
  });

const inDays = (d: number, h = 12) => {
  const t = new Date();
  t.setDate(t.getDate() + d);
  t.setHours(h, 0, 0, 0);
  return t.toISOString();
};

describe("plan chip wording", () => {
  const label = (me: Me) => {
    const p = chipPlan(me);
    return p ? chipLabel(p) : null;
  };
  const withBilling = (over: object) => trialMe(over)({ instance: {} } as Me);

  it("counts calendar days to the end date, in local time", () => {
    // Late tonight is still "ends today"; just past midnight is tomorrow.
    const now = new Date(2026, 10, 13, 23, 30).getTime();
    expect(calendarDaysTo(new Date(2026, 10, 13, 23, 59).getTime(), now)).toBe(
      0,
    );
    expect(calendarDaysTo(new Date(2026, 10, 14, 0, 5).getTime(), now)).toBe(1);
    expect(calendarDaysTo(new Date(2026, 11, 13, 12).getTime(), now)).toBe(30);
  });

  it.each([
    [29, "Solo trial · 29 days left"],
    [1, "Solo trial · 1 day left"],
    [0, "Solo trial · ends today"],
  ])("Solo, %i days out: %s", (d, text) => {
    const end = d === 0 ? Date.now() + 60_000 : Date.parse(inDays(d));
    // Keep "today" for d = 0 even near midnight.
    const iso =
      d === 0
        ? new Date(new Date().setHours(23, 59, 0, 0)).toISOString()
        : new Date(end).toISOString();
    if (d === 0 && Date.parse(iso) <= Date.now()) return;
    expect(label(withBilling({ soloTrialEndsAt: iso }))).toBe(text);
  });

  it("names a Team trial the same way when its end is known", () => {
    expect(
      label(
        withBilling({
          tier: "trial",
          soloTrialEndsAt: null,
          trialEndsAt: inDays(12),
        }),
      ),
    ).toBe("Team trial · 12 days left");
  });

  it("is the plain plan name after the trial, or for a paid plan", () => {
    expect(
      label(withBilling({ soloTrialEndsAt: "2026-01-01T00:00:00.000Z" })),
    ).toBe("Solo");
    expect(label(withBilling({ soloTrialEndsAt: null }))).toBe("Solo");
    expect(label(withBilling({ tier: "team", soloTrialEndsAt: null }))).toBe(
      "Team",
    );
    expect(
      label(
        withBilling({
          tier: "trial",
          soloTrialEndsAt: null,
          trialEndsAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe("Team");
  });

  it("is nothing for another tier or a self-hosted instance", () => {
    expect(label(withBilling({ tier: "free" }))).toBeNull();
    expect(
      chipPlan({ instance: { billing: undefined } } as unknown as Me),
    ).toBeNull();
    expect(
      chipPlan({ instance: { hosted: false, billing: {} } } as unknown as Me),
    ).toBeNull();
  });
});

describe("plan chip in the top bar", () => {
  it("opens the Solo trial note", async () => {
    mountHosted("/", true, trialMe({ soloTrialEndsAt: inDays(29) }));
    const chip = await screen.findByTestId("plan-chip");
    expect(chip).toHaveTextContent("Solo trial · 29 days left");
    fireEvent.click(chip);
    expect(await screen.findByText(/No card needed/)).toBeInTheDocument();
    expect(
      screen.getByText(/\$1 a\s+month or \$10 a year/),
    ).toBeInTheDocument();
    expect(screen.getByText(/7 days before/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
  });

  it("is a plain label with no note once the trial is over", async () => {
    mountHosted("/", true, trialMe({ soloTrialEndsAt: null }));
    const chip = await screen.findByTestId("plan-chip");
    expect(chip).toHaveTextContent(/^Solo$/);
    expect(chip.tagName).toBe("SPAN");
  });

  it("shows nothing on a self-hosted instance", async () => {
    mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(screen.queryByTestId("plan-chip")).toBeNull();
  });
});
