// #2150: what group sync puts back after Team to Business. The Upgrade to
// Business confirm (before) and the one-time sync banner (after).
import type { InstanceDirectory, Me } from "@oa/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THAW_COPY } from "../src/layout/thawCopy";
import { PlanCompare } from "../src/settings/PlanCompare";
import { calls, installHarness, mountHosted } from "./harness";

installHarness();
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const dir =
  (d: Partial<InstanceDirectory>, tier?: "business" | "team") => (m: Me) => ({
    ...m,
    instance: {
      ...m.instance,
      ...(tier && m.instance.billing
        ? { billing: { ...m.instance.billing, tier } }
        : {}),
      directory: {
        ...(m.instance.directory as InstanceDirectory),
        mode: "google" as const,
        state: "ok" as const,
        banner: false,
        tokensUnverified: false,
        ...d,
      },
    },
  });
const BUSINESS = {
  tier: "business" as const,
  status: "active" as const,
  trialEndsAt: null,
  graceUntil: null,
  creatorsThisMonth: 1,
  readOnly: false,
};

describe("Upgrade to Business confirm", () => {
  const view = (pendingReverts: number, upgrade = vi.fn()) => {
    render(
      <PlanCompare
        column="team"
        busy={false}
        pendingReverts={pendingReverts}
        upgrade={upgrade}
      />,
    );
    fireEvent.click(
      within(screen.getByTestId("plan-card-business")).getByRole("button", {
        name: "Upgrade to Business",
      }),
    );
    return upgrade;
  };

  it("0 reverts: no confirm, the upgrade starts", () => {
    const upgrade = view(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(upgrade).toHaveBeenCalledWith("business");
  });

  it("asks first with the count, and Upgrade continues", () => {
    const upgrade = view(3);
    expect(upgrade).not.toHaveBeenCalled();
    const d = screen.getByRole("dialog", { name: "Upgrade to Business" });
    expect(d).toHaveTextContent(
      "Directory sync turns back on. 3 people whose roles were changed by hand on Team will go back to the role their group gives them. People you removed stay removed, and people you added stay.",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Upgrade" }));
    expect(upgrade).toHaveBeenCalledWith("business");
  });

  it("says one person for 1, and Cancel does not upgrade", () => {
    const upgrade = view(1);
    const d = screen.getByRole("dialog");
    expect(d).toHaveTextContent(
      "1 person whose role was changed by hand on Team will go back to the role their group gives them.",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("Team's upgrade never asks", () => {
    const upgrade = vi.fn();
    render(
      <PlanCompare
        column="solo"
        busy={false}
        pendingReverts={4}
        upgrade={upgrade}
      />,
    );
    fireEvent.click(
      within(screen.getByTestId("plan-card-team")).getByRole("button", {
        name: "Upgrade to Team",
      }),
    );
    expect(upgrade).toHaveBeenCalledWith("team");
  });
});

describe("yearly path", () => {
  it("the confirm's Upgrade opens the seat step with focus, and checkout carries seats", async () => {
    const posts = calls("POST");
    mountHosted(
      "/settings/plan",
      {
        billing: {
          tier: "trial",
          status: "active",
          trialEndsAt: null,
          graceUntil: null,
          creatorsThisMonth: 4,
          readOnly: false,
          yearlyTeamBusiness: true,
        },
      },
      dir({ mode: "frozen", bound: true, pendingReverts: 3 }),
    );
    const card = await screen.findByTestId("plan-card-business");
    fireEvent.click(
      within(card).getByRole("button", { name: "Upgrade to Business" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Upgrade to Business",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Upgrade" }));
    const input = (await screen.findByLabelText(
      "Creators",
    )) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(
        posts.find((c) => c.path.endsWith("/billing/checkout"))?.body,
      ).toEqual({ tier: "business", interval: "year", seats: 4 }),
    );
  });
});

describe("thaw banner (Members)", () => {
  const T = {
    id: "1000",
    reverted: 3,
    names: ["Alex Kim", "Sam Lee"],
    at: "2026-11-12T00:00:00.000Z",
  };
  const MEMBERS = "/settings/members";
  const mount = (t: typeof T | undefined, path = MEMBERS) =>
    mountHosted(
      path,
      { billing: BUSINESS },
      dir(t ? { lastThaw: t } : {}, "business"),
    );
  const note = (s: string) => screen.queryByText(s, { exact: false });

  it.each([
    [
      ["Alex Kim"],
      1,
      "Directory sync is back on. Alex Kim is back on the role their group gives them.",
    ],
    [
      ["Alex Kim", "Sam Lee"],
      2,
      "Directory sync is back on. Alex Kim and Sam Lee are back on the role their group gives them.",
    ],
    [
      ["Alex Kim", "Sam Lee"],
      3,
      "Directory sync is back on. Alex Kim, Sam Lee and 1 other are back on the role their group gives them.",
    ],
    [
      ["Alex Kim", "Sam Lee"],
      4,
      "Directory sync is back on. Alex Kim, Sam Lee and 2 others are back on the role their group gives them.",
    ],
  ])("names %j for %i people", async (names, reverted, text) => {
    mount({ ...T, names, reverted });
    expect(await screen.findByText(text)).toBeVisible();
    expect(screen.queryByRole("link", { name: "See what changed" })).toBeNull();
  });

  it("dismisses once per thaw and stays dismissed", async () => {
    mount(T);
    await screen.findByText("Directory sync is back on.", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(note("Directory sync is back on")).toBeNull());
    expect(localStorage.getItem("oa.thawNotice.dismissed")).toBe("1000");
  });

  it("stays hidden after a reload for the same thaw, shows for a new one", async () => {
    localStorage.setItem("oa.thawNotice.dismissed", "1000");
    mount(T);
    await screen.findByRole("main");
    expect(note("Directory sync is back on")).toBeNull();
    cleanup();
    mount({ ...T, id: "2000" });
    expect(
      await screen.findByText("Directory sync is back on.", { exact: false }),
    ).toBeVisible();
  });

  it("no thaw, no banner; and not off Members", async () => {
    mount(undefined);
    await screen.findByRole("main");
    expect(note("Directory sync is back on")).toBeNull();
    cleanup();
    mount(T, "/");
    await screen.findByRole("main");
    expect(note("Directory sync is back on")).toBeNull();
  });
});
