// Billing plumbing: the plan cap (Me.auth.cap "plan") disables writes exactly
// like the restricted cap, nothing is hidden, locked admins keep admin reads,
// and a free-tier promotion refused with plan_limit shows by the member row.

import type { Me } from "@oa/shared";
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { canPublishTo } from "../src/auth/permissions";
import { canConnectAgents } from "../src/settings/AgentSetupCard";
import {
  arts,
  calls,
  findVisibleToast,
  installHarness,
  mount,
  mountHosted,
  server,
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

const LOCKED_PLAN = {
  tier: "trial" as const,
  status: "lapsed" as const,
  trialEndsAt: null,
  graceUntil: null,
  readOnly: true,
  reason: "trial_ended" as const,
};
const OPTS = { billing: LOCKED_PLAN };
const NOTICE = "This instance is read-only right now. Ask your instance owner.";
const locked =
  (role: "member" | "admin") =>
  (m: Me): Me => ({
    ...m,
    user: { ...m.user, role },
    auth: {
      method: "google",
      readOnly: true,
      cap: "plan",
      expiresAt: null,
    },
  });

it("canPublishTo is false under the plan cap", () => {
  expect(canPublishTo({ kind: "personal", myRole: null }, "plan")).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: "editor" }, "plan")).toBe(
    false,
  );
});

const itemsOf = async () => {
  await screen.findByRole("heading", { name: "Library" });
  await screen.findAllByText(arts[0].title);
  return screen
    .getAllByRole("link")
    .map((l) => l.textContent)
    .filter(Boolean)
    .sort();
};

it("nothing is hidden: a locked member's library lists what the uncapped one does", async () => {
  mountHosted("/", true);
  const uncapped = await itemsOf();
  cleanup();
  mountHosted("/", OPTS, locked("member"));
  expect(await itemsOf()).toEqual(uncapped);
  expect(uncapped.length).toBeGreaterThan(1);
});

it("a locked member can't create; the library and artifacts still open", async () => {
  mountHosted("/", OPTS, locked("member"));
  await screen.findByRole("heading", { name: "Library" });
  expect((await screen.findAllByText(arts[0].title))[0]).toBeVisible();
  expect(screen.queryByRole("button", { name: "Create artifact" })).toBeNull();
  fireEvent.drop(document.body, {
    dataTransfer: { files: [new File(["# x"], "a.md")], types: ["Files"] },
  });
  expect(screen.queryByRole("dialog", { name: "Create artifact" })).toBeNull();
});

it("a locked member opens a normal artifact: the cap, not the mock, turns writes off", async () => {
  // The artifact is served as the server serves an owner's: full `can`.
  const full = {
    edit: true,
    share: true,
    setVisibility: true,
    delete: true,
    transfer: false,
    move: true,
    dataWrite: true,
  };
  mountHosted(`/a/${arts[0].id}`, OPTS, locked("member"), [
    http.get(`*${R.artifact(arts[0].id)}`, () =>
      HttpResponse.json({ ...arts[0], access: "owner", can: full }),
    ),
  ]);
  await screen.findByRole("heading", { name: arts[0].title });
  // Write controls are withdrawn exactly as for a restricted member.
  for (const name of ["Rename", "Share", "Delete", "Move"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

const memberRow = async (name: string) => {
  const el = (await screen.findByText(name)).closest("li");
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
};
const BOB = fixtures.members[1] as { id: string; name: string };

const lockedAdmin = (path: string) => mountHosted(path, OPTS, locked("admin"));
const NOTE = () => screen.getAllByText(NOTICE)[0];

it("members: a locked admin sees the list, a notice, and every write control disabled", async () => {
  lockedAdmin("/settings/members");
  const r = await memberRow(BOB.name);
  expect(NOTE()).toBeVisible();
  expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();
  expect(
    within(r).getByRole("combobox", { name: `Role for ${BOB.name}` }),
  ).toBeDisabled();
  expect(
    within(r).getByRole("button", { name: `More for ${BOB.name}` }),
  ).toBeDisabled();
});

it("spaces: a locked admin sees the list; New space is disabled", async () => {
  lockedAdmin("/settings/spaces");
  expect(await screen.findByRole("list", { name: "Spaces" })).toBeVisible();
  expect(NOTE()).toBeVisible();
  expect(screen.getByRole("button", { name: "New space" })).toBeDisabled();
});

it("directory: a locked admin sees the page; its write controls are disabled", async () => {
  lockedAdmin("/settings/directory");
  expect(
    await screen.findByRole("status", { name: "Sync status" }),
  ).toBeVisible();
  expect(NOTE()).toBeVisible();
  expect(
    await screen.findByRole("combobox", { name: "Add a restricted group" }),
  ).toBeDisabled();
});

it("instance: a locked admin sees the settings; the fields are disabled", async () => {
  lockedAdmin("/settings/instance");
  const name = await screen.findByLabelText(/instance name/i);
  expect(name).toBeVisible();
  expect(NOTE()).toBeVisible();
  expect(name).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

it("tokens: a locked admin sees the token list; Create token is disabled", async () => {
  lockedAdmin("/settings/agents");
  expect(
    await screen.findByRole("region", { name: "Personal access tokens" }),
  ).toBeVisible();
  expect(NOTE()).toBeVisible();
  expect(screen.getByRole("button", { name: "Create token" })).toBeDisabled();
});

it("reads stay enabled for a locked admin: Copy URL, snippet tabs, Retry", async () => {
  lockedAdmin("/settings/agents");
  expect(await screen.findByRole("button", { name: "Copy URL" })).toBeEnabled();
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.length).toBeGreaterThan(1);
  for (const t of tabs) expect(t).toBeEnabled();
  // The write controls on the same page are off.
  expect(screen.getByRole("button", { name: "Create token" })).toBeDisabled();
});

it("reads stay enabled for a locked admin: Retry on a failed spaces list", async () => {
  mountHosted("/settings/spaces", OPTS, locked("admin"), [
    http.get("*/api/v1/spaces", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "down" } },
        { status: 500 },
      ),
    ),
  ]);
  const retries = await screen.findAllByRole("button", { name: "Retry" });
  for (const r of retries) expect(r).toBeEnabled();
  expect(screen.getByRole("button", { name: "New space" })).toBeDisabled();
});

it("reads stay enabled for a locked admin: space people search and Load more", async () => {
  const SPACE = "SpEngNpQrSt2uVwX";
  const page = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      userId: `u${from + i}`,
      user: {
        id: `u${from + i}`,
        name: `Person ${from + i}`,
        email: `p${from + i}@example.com`,
      },
      role: "viewer",
      status: "active",
      source: "manual",
      manualRole: "viewer",
      syncRole: null,
      groups: [],
      cap: null,
      allMembers: null,
    }));
  mountHosted(`/settings/spaces?space=${SPACE}`, OPTS, locked("admin"), [
    http.get(`*/api/v1/spaces/${SPACE}/members`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("cursor") === "c1"
          ? { items: page(3, 2), nextCursor: null, total: 312 }
          : { items: page(0, 3), nextCursor: "c1", total: 312 },
      ),
    ),
  ]);
  const card = await screen.findByRole("region", { name: "People" });
  expect(await within(card).findByText("Showing 3 of 312")).toBeVisible();
  expect(within(card).getByRole("button", { name: "Load more" })).toBeEnabled();
  expect(
    within(card).getByRole("searchbox", { name: /Search people/ }),
  ).toBeEnabled();
  expect(
    within(card).getByRole("button", { name: "Add people" }),
  ).toBeDisabled();
  expect(
    within(card).getAllByRole("combobox", { name: /^Role for / })[0],
  ).toBeDisabled();
});

it("nothing is hidden: the members list is the same with and without the cap", async () => {
  mountHosted("/settings/members", true);
  await memberRow(BOB.name);
  const names = () => screen.getAllByRole("listitem").map((l) => l.textContent);
  const uncapped = names();
  cleanup();
  lockedAdmin("/settings/members");
  await memberRow(BOB.name);
  expect(names()).toEqual(uncapped);
});

it("the locked owner isn't read-only: controls stay enabled and refusals use the owner copy", async () => {
  const posts = calls("POST");
  mountHosted("/settings/members", OPTS, (m) => ({
    ...m,
    user: { ...m.user, role: "owner" },
  }));
  await memberRow(BOB.name);
  expect(screen.queryByText(NOTICE)).toBeNull();
  expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Email"), {
    target: { value: "new@example.com" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));
  await waitFor(() => expect(posts.length).toBe(1));
  expect(
    await screen.findByText(
      "Your trial ended, so this instance is read-only until you pick a plan.",
    ),
  ).toBeVisible();
});

const asOwner = (m: Me): Me => ({ ...m, user: { ...m.user, role: "owner" } });
const SNOOZE_PATH = R.directoryHeldSnooze("gSales03");
const heldRegion = () =>
  screen.findByRole("region", { name: "Waiting for your confirmation" });

it.each([
  [
    "plan_read_only",
    OPTS,
    "Your trial ended, so this instance is read-only until you pick a plan.",
  ],
  [
    "plan_required",
    {
      billing: {
        tier: "free" as const,
        status: null,
        trialEndsAt: null,
        graceUntil: null,
        readOnly: false,
      },
    },
    "This needs a paid plan. Choose a plan to continue.",
  ],
])(
  "a Snooze refused with %s toasts the plan copy; the row stays held",
  async (_code, opts, copy) => {
    const posts = calls("POST");
    mountHosted("/settings/directory", opts, asOwner);
    const row = await heldRegion();
    fireEvent.click(within(row).getByRole("button", { name: "Snooze Sales" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Snooze",
      }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path === SNOOZE_PATH)).toBe(true),
    );
    expect(await findVisibleToast(copy)).toBeVisible();
    expect(await findVisibleToast("Couldn't snooze the change.")).toBeVisible();
    expect(row).not.toHaveTextContent("Snoozed until");
  },
);

it("on free, a promotion refused with plan_limit shows by the member row, not as a toast", async () => {
  const patches = calls("PATCH");
  mount("/settings/members");
  server.use(
    http.patch(`*${R.member(BOB.id)}`, () =>
      HttpResponse.json(
        {
          error: {
            code: "plan_limit",
            message: "server text",
            details: { tier: "free", limit: "storage_bytes", max: 3 },
          },
        },
        { status: 403 },
      ),
    ),
  );
  const r = await memberRow(BOB.name);
  fireEvent.click(
    within(r).getByRole("combobox", { name: `Role for ${BOB.name}` }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /admin/i }));
  const note = await within(r).findByText(
    /The free plan allows up to 3 storage/,
  );
  expect(note).toBeVisible();
  // The owner (the default test caller) sees the owner wording.
  expect(note).toHaveTextContent("Choose a paid plan to raise it.");
  await waitFor(() =>
    expect(patches.some((c) => c.path === R.member(BOB.id))).toBe(true),
  );
  expect(screen.queryByText("Couldn't change the role.")).toBeNull();
});

// Design's ruling A (#863): the plan cap is a billing state, not an access
// limit. A locked admin sees every control, disabled; guests and restricted
// members stay hidden, as main has them.

const withCap = (
  role: Me["user"]["role"],
  cap: NonNullable<Me["auth"]>["cap"],
): Me => ({
  ...fixtures.me,
  user: { ...fixtures.me.user, role },
  auth: {
    method: "google",
    readOnly: cap != null,
    cap,
    expiresAt: null,
  },
});

it("canConnectAgents: the plan cap connects; guests and restricted never do", () => {
  expect(canConnectAgents(withCap("admin", null))).toBe(true);
  expect(canConnectAgents(withCap("admin", "plan"))).toBe(true);
  expect(canConnectAgents(withCap("member", "restricted"))).toBe(false);
  expect(canConnectAgents(withCap("guest", "guest"))).toBe(false);
  expect(canConnectAgents(withCap("guest", null))).toBe(false);
  expect(canConnectAgents(withCap("guest", "plan"))).toBe(false);
});

const departedRegion = () => screen.findByRole("region", { name: "Departed" });

it("departed: a locked admin's Transfer all to me and Transfer to someone else are disabled", async () => {
  const posts = calls("POST");
  lockedAdmin("/settings/members");
  const d = await departedRegion();
  const toMe = await within(d).findByRole("button", {
    name: "Transfer all to me",
  });
  expect(toMe).toBeDisabled();
  fireEvent.pointerDown(within(d).getByRole("button", { name: /^More for / }), {
    button: 0,
    ctrlKey: false,
  });
  const other = await screen.findByRole("menuitem", {
    name: "Transfer to someone else…",
  });
  expect(other).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(other);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(posts.some((c) => c.path.endsWith("/transfer"))).toBe(false);
});

it("departed: a restricted caller still gets no Transfer all to me", async () => {
  mountHosted("/settings/members", OPTS, (m) => ({
    ...m,
    user: { ...m.user, role: "admin" },
    auth: {
      method: "google",
      readOnly: true,
      cap: "restricted",
      expiresAt: null,
    },
  }));
  const d = await departedRegion();
  expect(
    await within(d).findByRole("button", { name: /^Transfer .*'s artifacts$/ }),
  ).toBeVisible();
  expect(
    within(d).queryByRole("button", { name: "Transfer all to me" }),
  ).toBeNull();
});

it("agents: a restricted member still gets no Create token or MCP URL", async () => {
  mountHosted("/settings/agents", OPTS, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
    auth: {
      method: "google",
      readOnly: true,
      cap: "restricted",
      expiresAt: null,
    },
  }));
  expect(
    await screen.findByRole("region", { name: "Personal access tokens" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy URL" })).toBeNull();
});

it("agents: a locked admin sees Add label on a connected agent, disabled", async () => {
  lockedAdmin("/settings/agents");
  const label = await screen.findByRole("button", { name: "Add label" });
  expect(label).toBeDisabled();
  fireEvent.click(label);
  expect(screen.queryByRole("textbox", { name: /label/i })).toBeNull();
});
