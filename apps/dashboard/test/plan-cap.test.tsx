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
import {
  arts,
  calls,
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
