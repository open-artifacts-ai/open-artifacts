import { R } from "@oa/shared";
import { act, fireEvent, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { accessLabel, canPublishTo } from "../src/auth/permissions";
import {
  arts,
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
  }),
}));

installHarness();

// Radix Tooltip measures its content; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const none = {
  edit: false,
  share: false,
  setVisibility: false,
  delete: false,
  transfer: false,
  move: false,
  dataWrite: true,
};
const managerCan = {
  ...none,
  edit: true,
  share: true,
  setVisibility: true,
  delete: true,
  move: true,
};
const handler = (a: object) =>
  http.get(`*${R.artifact(arts[0].id)}`, () =>
    HttpResponse.json({ ...arts[0], ...a }),
  );
const serve = (a: object) => server.use(handler(a));

it("viewer sees no edit affordance but keeps data writes", async () => {
  serve({
    access: "viewer",
    can: none,
    capabilities: { db: true, viewer: false, storage: false },
  });
  mount(`/a/${arts[0].id}`);
  await screen.findByRole("heading", { name: arts[0].title });
  for (const name of ["Rename", "Restore", "Delete", "Share", "Move"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByTitle("Rename")).toBeNull();
});

const guestCan = { ...none, dataWrite: false };
const live = { db: true, viewer: false, storage: false };

it("hosted guest on a live-data artifact sees the chip, a tooltip on focus, no buttons", async () => {
  mountHosted(`/a/${arts[0].id}`, true, undefined, [
    handler({ access: "viewer", can: guestCan, capabilities: live }),
  ]);
  const chip = await screen.findByText("View only");
  expect(chip).toBeVisible();
  expect(chip).toHaveAttribute("tabindex", "0");
  act(() => chip.focus());
  expect(
    (
      await screen.findAllByText(
        "You can view this, but you can't change its data.",
      )
    )[0],
  ).toBeInTheDocument();
  for (const name of ["Rename", "Share", "Delete"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

it("employee + db: a hosted employee viewer (dataWrite true) gets no chip", async () => {
  mountHosted(`/a/${arts[0].id}`, true, undefined, [
    handler({ access: "viewer", can: none, capabilities: live }),
  ]);
  await screen.findByRole("heading", { name: arts[0].title });
  expect(screen.queryByText("View only")).toBeNull();
});

it("contractor + db: a restricted member on a live-data artifact gets the chip", async () => {
  mountHosted(
    `/a/${arts[0].id}`,
    true,
    (m) => ({
      ...m,
      auth: {
        method: "google",
        readOnly: true,
        cap: "restricted",
        expiresAt: null,
      },
    }),
    [handler({ access: "viewer", can: guestCan, capabilities: live })],
  );
  expect(await screen.findByText("View only")).toBeVisible();
  for (const name of ["Rename", "Share", "Delete"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

it("hosted guest on an artifact without live data gets no chip", async () => {
  mountHosted(`/a/${arts[0].id}`, true, undefined, [
    handler({
      access: "viewer",
      can: guestCan,
      capabilities: { db: false, viewer: false, storage: false },
    }),
  ]);
  await screen.findByRole("heading", { name: arts[0].title });
  expect(screen.queryByText("View only")).toBeNull();
});

it("self-hosted guest-shaped viewer gets no chip", async () => {
  serve({
    access: "viewer",
    can: guestCan,
    space: undefined,
    capabilities: live,
  });
  mount(`/a/${arts[0].id}`);
  await screen.findByRole("heading", { name: arts[0].title });
  expect(screen.queryByText("View only")).toBeNull();
});

it("self-hosted viewer share (no can, no space): no notice, no access label", async () => {
  serve({
    access: "viewer",
    can: undefined,
    space: undefined,
    capabilities: { db: true, viewer: false, storage: true },
  });
  mount(`/a/${arts[0].id}`);
  await screen.findByRole("heading", { name: arts[0].title });
  expect(screen.queryByText("Viewer")).toBeNull();
});

it("a space manager gets Share and Delete, is labelled Manager, never Owner", async () => {
  serve({
    access: "manager",
    can: managerCan,
    space: {
      id: "SpEngNpQrSt2uVwX",
      kind: "shared",
      name: "Engineering",
      publicLinks: true,
    },
  });
  mount(`/a/${arts[0].id}`);
  expect(await screen.findByRole("button", { name: "Share" })).toBeVisible();
  // Radix opens the menu on keydown, not a synthetic click.
  fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
    key: "Enter",
  });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  expect(screen.getByText("Manager")).toBeVisible();
  expect(screen.queryByText(/you own this/i)).toBeNull();
});

it("share without delete: Share shows, Delete doesn't", async () => {
  serve({
    access: "editor",
    can: { ...none, edit: true, share: true, setVisibility: true },
  });
  mount(`/a/${arts[0].id}`);
  expect(await screen.findByRole("button", { name: "Share" })).toBeVisible();
  // Radix opens the menu on keydown, not a synthetic click.
  fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
    key: "Enter",
  });
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
});

it("readOnly guest gets no Create artifact control", async () => {
  mountHosted("/shared", true, (m) => ({
    ...m,
    user: { ...m.user, role: "guest" },
    auth: { method: "code", readOnly: true, cap: "guest", expiresAt: null },
  }));
  await screen.findByRole("heading", { name: "Library" });
  expect(screen.queryByRole("button", { name: "Create artifact" })).toBeNull();
});

it("a restricted member (role member, cap restricted) can't create anywhere", async () => {
  mountHosted("/", true, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
    auth: {
      method: "google",
      readOnly: false,
      cap: "restricted",
      expiresAt: null,
    },
  }));
  await screen.findByRole("heading", { name: "Library" });
  expect(screen.queryByRole("button", { name: "Create artifact" })).toBeNull();
  fireEvent.drop(document.body, {
    dataTransfer: { files: [new File(["# x"], "a.md")], types: ["Files"] },
  });
  expect(screen.queryByRole("dialog", { name: "Create artifact" })).toBeNull();
  expect(
    canPublishTo({ kind: "personal", myRole: "manager" }, "restricted"),
  ).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: "editor" }, "restricted")).toBe(
    false,
  );
});

it("404 on rename toasts the server message and keeps the title", async () => {
  server.use(
    http.patch(`*${R.artifact(arts[0].id)}`, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    ),
  );
  mount(`/a/${arts[0].id}`);
  // The editable title is a button named by the title, with title="Rename".
  fireEvent.click(await screen.findByTitle("Rename"));
  const box = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(box, { target: { value: "New" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await findVisibleToast("Not found");
  expect(screen.getByRole("heading", { name: arts[0].title })).toBeVisible();
});

it("canPublishTo", () => {
  expect(canPublishTo({ kind: "shared", myRole: "viewer" }, null)).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: null }, null)).toBe(false);
  expect(canPublishTo({ kind: "shared", myRole: "editor" }, null)).toBe(true);
  expect(canPublishTo({ kind: "personal", myRole: "manager" }, null)).toBe(
    true,
  );
});

it("accessLabel", () => {
  expect(
    (["owner", "manager", "editor", "viewer"] as const).map(accessLabel),
  ).toEqual(["Owner", "Manager", "Editor", "Viewer"]);
});
