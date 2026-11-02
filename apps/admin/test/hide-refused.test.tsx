import type { InstallDetail, RouteId } from "@oa/shared/provisioning";
import { fixtureMe } from "@oa/shared/provisioning/fixtures";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { canCall, canSeePii } from "../src/hooks/useEnv";
import { installsByState } from "../src/mocks/fixtures";
import { http, json, renderApp, seen, use } from "./harness";

// #1074: the panel hides what the session can't do, from the shared authz table.

const session = (principal: "admin" | "test-admin") =>
  fixtureMe({
    principal,
    role: "admin",
    email: "a@example.com",
    scopes: [],
    env: "staging",
    csrf: "c",
    tokenId: null,
    tokenKind: null,
    tokenExpiresAt: null,
  });
const signIn = (principal: "admin" | "test-admin") =>
  use(http.get("*/api/v1/me", () => json(session(principal))));

// The nav renders before /me; "Signed in as" shows once it has loaded.
const navLinks = async () =>
  (await screen.findByText(/Signed in as/)) &&
  within(screen.getByRole("navigation", { name: "Main" }))
    .getAllByRole("link")
    .map((a) => a.textContent?.trim());
const openDetail = async (i: InstallDetail) => {
  use(http.get(`*/api/v1/installs/${i.id}`, () => json(i)));
  renderApp(`/installs/${i.id}`);
  await screen.findByRole("heading", { name: i.slug });
  return within(screen.getByRole("region", { name: "Actions" }))
    .queryAllByRole("button")
    .map((b) => b.textContent);
};
const ALL_ACTIONS = {
  ...installsByState.active,
  lease: { held: true, until: null },
};

const PANEL_ROUTES: RouteId[] = [
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
  "R10",
  "R11",
  "R12",
  "R13",
  "R14",
  "R15",
  "R16",
  "R17",
  "R18",
  "R19",
  "R20",
  "R21",
  "R25",
  "R27",
];

it("a real admin may call every route the panel uses, on both envs", () => {
  for (const env of ["staging", "prod"] as const)
    for (const r of PANEL_ROUTES)
      expect(canCall(r, { ...session("admin"), env }), `${r} ${env}`).toBe(
        true,
      );
  expect(canSeePii(session("admin"))).toBe(true);
});

it("the test admin may call only R1-R5 and R14-R18 of the API routes", () => {
  const ta = session("test-admin");
  expect(PANEL_ROUTES.filter((r) => canCall(r, ta))).toEqual([
    "R2",
    "R3",
    "R4",
    "R5",
    "R14",
    "R15",
    "R16",
    "R17",
    "R18",
  ]);
  expect(canSeePii(ta)).toBe(false);
});

it("test admin: no Agent tokens nav, no overview call, the no-email search, Create install stays", async () => {
  signIn("test-admin");
  renderApp("/installs");
  expect(await navLinks()).toEqual(["Installs", "Audit log"]);
  expect(
    await screen.findByRole("searchbox", { name: "Search slug, id or host" }),
  ).toHaveAttribute("placeholder", "Search slug, id or host");
  expect(screen.getByRole("link", { name: "Create install" })).toBeVisible();
  expect(seen.some((s) => s.path.startsWith("/api/v1/world"))).toBe(false);
  expect(
    screen.getByText(
      "Test admin: no overview, agent tokens, or actions beyond Create and Upgrade.",
    ),
  ).toBeVisible();
});

it("test admin Audit: no tokens call, the page still works, and the line says whose rows", async () => {
  signIn("test-admin");
  renderApp("/audit");
  expect(
    await screen.findByText("Test admin: only this session's rows."),
  ).toBeVisible();
  expect(screen.queryByText(/^Every admin action/)).toBeNull();
  await screen.findAllByRole("row");
  expect(screen.getByRole("combobox", { name: "Actor" })).toBeVisible();
  await waitFor(() =>
    expect(seen.some((s) => s.path.startsWith("/api/v1/audit"))).toBe(true),
  );
  expect(seen.some((s) => s.path.startsWith("/api/v1/tokens"))).toBe(false);
});

it("real admin Audit: asks for tokens, with the usual line", async () => {
  signIn("admin");
  renderApp("/audit");
  expect(await screen.findByText(/^Every admin action/)).toBeVisible();
  expect(screen.queryByText(/^Test admin:/)).toBeNull();
  await waitFor(() =>
    expect(seen.some((s) => s.path.startsWith("/api/v1/tokens"))).toBe(true),
  );
});

it("real admin: no test admin note", async () => {
  signIn("admin");
  renderApp("/installs");
  await navLinks();
  expect(screen.queryByText(/^Test admin:/)).toBeNull();
});

it("an install without ownerEmail (no pii) has no Owner row; with it, one", async () => {
  signIn("test-admin");
  await openDetail({ ...ALL_ACTIONS, ownerEmail: null });
  expect(screen.queryByText("Owner", { selector: "dt" })).toBeNull();
  expect(screen.queryByText("hidden")).toBeNull();
});

it("a real admin sees the Owner row", async () => {
  signIn("admin");
  await openDetail({ ...ALL_ACTIONS, ownerEmail: "owner@example.com" });
  expect(screen.getByText("Owner", { selector: "dt" })).toBeVisible();
  expect(screen.getByText("owner@example.com")).toBeVisible();
});

it("real admin: Agent tokens nav, the email search and Create install", async () => {
  signIn("admin");
  renderApp("/installs");
  expect(await navLinks()).toEqual(["Installs", "Audit log", "Agent tokens"]);
  expect(
    await screen.findByRole("searchbox", {
      name: "Search slug, id, host or email",
    }),
  ).toHaveAttribute("placeholder", "Search slug, id, host or email");
  expect(screen.getByRole("link", { name: "Create install" })).toBeVisible();
});

it("test admin: /tokens goes back to installs", async () => {
  signIn("test-admin");
  const { router } = renderApp("/tokens");
  await waitFor(() => expect(router.state.location.pathname).toBe("/installs"));
  expect(screen.queryByRole("heading", { name: "Agent tokens" })).toBeNull();
});

it("real admin: /tokens shows the page", async () => {
  signIn("admin");
  renderApp("/tokens");
  expect(
    await screen.findByRole("heading", { name: "Agent tokens" }),
  ).toBeInTheDocument();
});

it("test admin: an active install offers only Upgrade", async () => {
  signIn("test-admin");
  expect(await openDetail(ALL_ACTIONS)).toEqual(["Upgrade"]);
});

it("real admin: an active install offers every action", async () => {
  signIn("admin");
  expect(await openDetail(ALL_ACTIONS)).toEqual([
    "Upgrade",
    "Roll back",
    "Pause",
    "Delete",
    "Release lease",
  ]);
});

for (const state of ["deleting", "failed", "suspended"] as const)
  it(`test admin: a ${state} install offers no refused action`, async () => {
    signIn("test-admin");
    const want = state === "suspended" ? ["Upgrade"] : [];
    expect(await openDetail(installsByState[state])).toEqual(want);
  });

it("test admin: a busy install offers no Cancel job", async () => {
  signIn("test-admin");
  const busy = { ...installsByState.provisioning };
  expect(busy.activeJobId).not.toBeNull();
  expect(await openDetail(busy)).toEqual([]);
});
