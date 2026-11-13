// #2287: the first open of Welcome (once, 404-safe) and the Solo trial chip.
import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { resetWelcomeRedirect } from "../src/library/useWelcomeRedirect";
import { soloTrialDaysLeft } from "../src/layout/PlanChip";
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
      expect(
        puts.find((c) => c.path === "/api/v1/onboarding")?.body,
      ).toEqual({ welcomeOpened: true }),
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

describe("Solo trial chip", () => {
  it("shows 'Solo · 30 days free' and opens the note", async () => {
    mountHosted("/", true, trialMe());
    const chip = await screen.findByTestId("plan-chip");
    expect(chip).toHaveTextContent("Solo · 30 days free");
    fireEvent.click(chip);
    expect(await screen.findByText(/No card needed/)).toBeInTheDocument();
    expect(screen.getByText(/\$1 a\s+month or \$10 a year/)).toBeInTheDocument();
    expect(screen.getByText(/7 days before/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
  });

  it("counts the days down", () => {
    const me = trialMe({
      soloTrialEndsAt: new Date(Date.now() + 2.2 * 86_400_000).toISOString(),
    })({ instance: {} } as Me);
    expect(soloTrialDaysLeft(me)).toBe(3);
  });

  it.each([
    ["a paid Solo (no trial date)", { soloTrialEndsAt: null }],
    ["a trial that has ended", { soloTrialEndsAt: "2026-01-01T00:00:00.000Z" }],
    ["a card on file", { soloCheckedOut: true }],
    ["another tier", { tier: "team" }],
  ])("shows nothing for %s", async (_n, over) => {
    mountHosted("/", true, trialMe(over));
    await screen.findByRole("link", { name: "Landing page" });
    expect(screen.queryByTestId("plan-chip")).toBeNull();
  });

  it("shows nothing on a self-hosted instance", async () => {
    mount("/");
    await screen.findByRole("link", { name: "Landing page" });
    expect(screen.queryByTestId("plan-chip")).toBeNull();
  });
});
