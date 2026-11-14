// #2472: hosted Solo hides spaces behind what they come with. The sidebar
// tells an owner or admin that spaces come with Team and links the plans; a
// member sees no empty note. /settings/spaces has no New space, and links
// Invite people (while the Team trial is still there) and See plans. Team
// and self-hosted keep what they had.
import type { Me, PlanView } from "@oa/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { isHostedSolo, soloSettingsLinks } from "../src/spaces/solo";
import { installHarness, mount, mountHosted } from "./harness";

installHarness();

// Radix Checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const solo = (trialEndsAt: string | null): PlanView => ({
  tier: "solo",
  status: "active",
  trialEndsAt,
  graceUntil: null,
  creatorsThisMonth: 1,
  readOnly: false,
  reason: "solo",
});
const TRIAL = solo(null);
const USED = solo("2026-10-01T00:00:00.000Z");
const TEAM: PlanView = { ...TRIAL, tier: "team", reason: undefined };
const TITLE = "Spaces come with Team";
const LINE =
  "Shared spaces are part of the Team plan. What you publish stays in Personal.";

/** The settings page's Spaces card, once it says what spaces come with. */
const soloCard = () =>
  waitFor(() => {
    const el = document.getElementById("oa-spaces-list")?.closest("section");
    expect(el).toHaveTextContent(TITLE);
    return el as HTMLElement;
  });
const nav = () => screen.findByRole("navigation", { name: "Spaces" });
const links = (el: HTMLElement) =>
  within(el)
    .getAllByRole("link")
    .map((l) => [l.textContent, l.getAttribute("href")]);
const asRole =
  (role: Me["user"]["role"]) =>
  (m: Me): Me => ({
    ...m,
    user: { ...m.user, role },
  });

it.each<[Me["user"]["role"], PlanView]>([
  ["owner", TRIAL],
  ["owner", USED],
  ["admin", TRIAL],
])(
  "sidebar, Solo %s: Spaces come with Team and See plans, no Set up spaces",
  async (role, billing) => {
    mountHosted("/", { billing, noSharedSpaces: true }, asRole(role));
    const sw = await nav();
    await waitFor(() => expect(sw).toHaveTextContent(TITLE));
    expect(sw).toHaveTextContent(LINE);
    expect(sw).not.toHaveTextContent("No spaces yet");
    expect(links(sw)).toEqual([
      ["Personal", expect.any(String)],
      ["See plans", "/settings/plan"],
    ]);
  },
);

it("sidebar, Solo member: Personal and no empty note", async () => {
  mountHosted("/", { billing: TRIAL, noSharedSpaces: true }, asRole("member"));
  const sw = await nav();
  await waitFor(() => expect(links(sw).map(([t]) => t)).toEqual(["Personal"]));
  expect(sw).not.toHaveTextContent(TITLE);
  expect(sw).not.toHaveTextContent("No spaces yet");
  expect(sw).not.toHaveTextContent("hasn't set up spaces");
});

it("sidebar, Team: the No spaces yet note and Set up spaces stay", async () => {
  mountHosted("/", { billing: TEAM, noSharedSpaces: true });
  const sw = await nav();
  await waitFor(() => expect(sw).toHaveTextContent("No spaces yet"));
  expect(sw).not.toHaveTextContent(TITLE);
  expect(within(sw).getByRole("link", { name: "Set up spaces" })).toBeVisible();
});

it("settings, Solo owner with the trial: no New space; Invite people and See plans", async () => {
  mountHosted("/settings/spaces", { billing: TRIAL, noSharedSpaces: true });
  const list = await soloCard();
  expect(list).toHaveTextContent(LINE);
  expect(links(list)).toEqual([
    ["Invite people", "/settings/members"],
    ["See plans", "/settings/plan"],
  ]);
  expect(screen.queryByRole("button", { name: "New space" })).toBeNull();
  // The Spaces card is the only one: no Every space, no Access.
  expect(screen.queryByRole("heading", { name: "Every space" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Access" })).toBeNull();
  expect(
    screen.queryByRole("switch", { name: "Space managers can map groups" }),
  ).toBeNull();
});

it("settings, Solo owner after the trial: See plans only", async () => {
  mountHosted("/settings/spaces", { billing: USED, noSharedSpaces: true });
  const list = await soloCard();
  expect(links(list)).toEqual([["See plans", "/settings/plan"]]);
  expect(screen.queryByRole("button", { name: "New space" })).toBeNull();
});

it("settings, Team: New space and no Solo note", async () => {
  mountHosted("/settings/spaces", { billing: TEAM });
  expect(
    await screen.findByRole("button", { name: "New space" }),
  ).toBeVisible();
  expect(screen.queryByText(TITLE)).toBeNull();
  expect(
    await screen.findByRole("heading", { name: "Every space" }),
  ).toBeVisible();
  expect(await screen.findByRole("heading", { name: "Access" })).toBeVisible();
});

it("self-hosted: no Spaces section, and never Solo", async () => {
  mount("/");
  await screen.findByRole("navigation", { name: "Primary" });
  expect(screen.queryByRole("navigation", { name: "Spaces" })).toBeNull();
  expect(screen.queryByText(TITLE)).toBeNull();
});

it("isHostedSolo and soloSettingsLinks", () => {
  const me = (hosted: boolean, b: Partial<PlanView> | null, role = "owner") =>
    ({
      user: { role },
      auth: null,
      instance: { hosted, ...(b ? { billing: { ...TRIAL, ...b } } : {}) },
    }) as unknown as Me;
  expect(isHostedSolo(me(true, {}))).toBe(true);
  expect(isHostedSolo(me(true, { tier: "free" }))).toBe(true);
  expect(isHostedSolo(me(true, { tier: "team" }))).toBe(false);
  expect(isHostedSolo(me(true, { tier: "trial" }))).toBe(false);
  expect(isHostedSolo(me(false, {}))).toBe(false);
  expect(isHostedSolo(me(true, null))).toBe(false);
  expect(isHostedSolo(null)).toBe(false);
  expect(soloSettingsLinks(me(true, {})).map((l) => l.label)).toEqual([
    "Invite people",
    "See plans",
  ]);
  expect(
    soloSettingsLinks(me(true, { trialEndsAt: USED.trialEndsAt })).map(
      (l) => l.label,
    ),
  ).toEqual(["See plans"]);
});
