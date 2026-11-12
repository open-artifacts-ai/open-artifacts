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
import { installHarness, mountHosted } from "./harness";

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
      "Directory sync turns back on. 3 people whose roles you changed on Team will go back to the role their group gives them. People you removed stay removed, and people you added stay.",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Upgrade" }));
    expect(upgrade).toHaveBeenCalledWith("business");
  });

  it("says one person for 1, and Cancel does not upgrade", () => {
    const upgrade = view(1);
    const d = screen.getByRole("dialog");
    expect(d).toHaveTextContent(
      "1 person whose role you changed on Team will go back to the role their group gives them.",
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

describe("thaw banner", () => {
  const T = { id: "1000", reverted: 3, at: "2026-11-12T00:00:00.000Z" };
  const text =
    "Directory sync is back on: 3 role changes you made on Team were replaced by your groups.";

  it("shows once with the audit link and stays dismissed for that thaw", async () => {
    mountHosted("/", { billing: BUSINESS }, dir({ lastThaw: T }, "business"));
    const note = await screen.findByText(
      (_, el) =>
        el?.tagName === "P" && el.textContent?.startsWith(text) === true,
    );
    expect(
      within(note).getByRole("link", { name: THAW_COPY.link }),
    ).toHaveAttribute("href", expect.stringContaining("/audit?actor=sync"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByText(text, { exact: false })).toBeNull(),
    );
    expect(localStorage.getItem("oa.thawNotice.dismissed")).toBe("1000");
  });

  it("stays hidden after a reload for the same thaw, shows for a new one", async () => {
    localStorage.setItem("oa.thawNotice.dismissed", "1000");
    mountHosted("/", { billing: BUSINESS }, dir({ lastThaw: T }, "business"));
    await screen.findByRole("main");
    expect(screen.queryByText(text, { exact: false })).toBeNull();
    cleanup();
    mountHosted(
      "/",
      { billing: BUSINESS },
      dir({ lastThaw: { ...T, id: "2000" } }, "business"),
    );
    expect(await screen.findByText(text, { exact: false })).toBeVisible();
  });

  it("says 1 role change for one", async () => {
    mountHosted(
      "/",
      { billing: BUSINESS },
      dir({ lastThaw: { ...T, reverted: 1 } }, "business"),
    );
    expect(
      await screen.findByText(
        "Directory sync is back on: 1 role change you made on Team was replaced by your groups.",
        { exact: false },
      ),
    ).toBeVisible();
  });

  it("no thaw, no banner", async () => {
    mountHosted("/", { billing: BUSINESS }, dir({}, "business"));
    await screen.findByRole("main");
    expect(
      screen.queryByText("Directory sync is back on", { exact: false }),
    ).toBeNull();
  });
});
