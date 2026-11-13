// #2150: what group sync puts back after Team to Business: the one-time sync banner.
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

describe("Business has no upgrade confirm (#2404)", () => {
  it("Business is Contact us, never an upgrade or a dialog", () => {
    const upgrade = vi.fn();
    render(<PlanCompare column="team" busy={false} upgrade={upgrade} />);
    const card = within(screen.getByTestId("plan-card-business"));
    expect(
      card.queryByRole("button", { name: "Upgrade to Business" }),
    ).toBeNull();
    fireEvent.click(card.getByRole("link", { name: "Contact us" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(upgrade).not.toHaveBeenCalled();
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
