// Billing plumbing: the plan cap (Me.auth.cap "plan") disables writes exactly
// like the restricted cap, nothing is hidden, locked admins keep admin reads,
// and a free-tier promotion refused with plan_limit shows by the member row.

import type { Me } from "@oa/shared";
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const none = {
  edit: false,
  share: false,
  setVisibility: false,
  delete: false,
  transfer: false,
  move: false,
  dataWrite: false,
};
const live = { db: true, viewer: false, storage: false };

it("canPublishTo is false under the plan cap", () => {
  expect(canPublishTo({ kind: "personal", myRole: null }, "plan")).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: "editor" }, "plan")).toBe(
    false,
  );
});

it("a locked member lists the same artifacts as with no cap, and can't create", async () => {
  mountHosted("/", true, locked("member"));
  await screen.findByRole("heading", { name: "Library" });
  for (const a of arts.slice(0, 2))
    expect((await screen.findAllByText(a.title))[0]).toBeVisible();
  expect(screen.queryByRole("button", { name: "Create artifact" })).toBeNull();
  fireEvent.drop(document.body, {
    dataTransfer: { files: [new File(["# x"], "a.md")], types: ["Files"] },
  });
  expect(screen.queryByRole("dialog", { name: "Create artifact" })).toBeNull();
});

it("a locked member opens an artifact; edit, share, delete and live-data writes are off", async () => {
  mountHosted(`/a/${arts[0].id}`, true, locked("member"), [
    http.get(`*${R.artifact(arts[0].id)}`, () =>
      HttpResponse.json({
        ...arts[0],
        access: "viewer",
        can: none,
        capabilities: live,
      }),
    ),
  ]);
  await screen.findByRole("heading", { name: arts[0].title });
  expect(await screen.findByText("View only")).toBeVisible();
  for (const name of ["Rename", "Share", "Delete", "Move"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

it("a locked member gets no label controls on connected agents", async () => {
  mountHosted("/settings/agents", true, locked("member"));
  await screen.findByText("Example MCP client 1.2.0");
  expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
});

const memberRow = async (name: string) => {
  const el = (await screen.findByText(name)).closest("li");
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
};
const BOB = fixtures.members[1] as { id: string; name: string };

it("a locked admin still lists members, with write controls disabled", async () => {
  mountHosted("/settings/members", true, locked("admin"));
  const r = await memberRow(BOB.name);
  expect(screen.getByRole("button", { name: "Add member" })).toBeDisabled();
  const role = within(r).queryByRole("combobox", {
    name: `Role for ${BOB.name}`,
  });
  if (role) expect(role).toBeDisabled();
  const more = within(r).queryByRole("button", {
    name: `More for ${BOB.name}`,
  });
  if (more) expect(more).toBeDisabled();
  const rm = within(r).queryByRole("button", { name: `Remove ${BOB.name}` });
  if (rm) expect(rm).toBeDisabled();
  expect(role ?? more ?? rm).not.toBeNull();
});

it("an unlocked admin keeps Add member enabled", async () => {
  mountHosted("/settings/members", true, (m) => ({
    ...m,
    user: { ...m.user, role: "admin" },
  }));
  await memberRow(BOB.name);
  expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
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
