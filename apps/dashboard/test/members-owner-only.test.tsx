// Backend #475 / #553: only an uncapped owner acts on an owner or admin row
// (PATCH and DELETE /members/:id, DELETE identities/google are 403 owner_only
// otherwise). Admins and capped owners see those rows read-only; a stale 403
// says why inline on the row and refetches.
import type { Me } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { calls, installHarness, mountHosted } from "./harness";

installHarness();

const ADMIN_COPY = "Only the owner can change another admin's access.";
const RESET_COPY = "Only the owner can reset another admin's Google link.";
const row = async (name: string) => {
  const el = (await screen.findByText(name)).closest("li");
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
};
const openMenu = async (r: HTMLElement, name: string) => {
  fireEvent.pointerDown(
    within(r).getByRole("button", { name: `More for ${name}` }),
    { button: 0, pointerType: "mouse" },
  );
  return screen.findByRole("menu");
};
const asAdmin = (m: Me): Me => ({ ...m, user: { ...m.user, role: "admin" } });
const cappedOwner = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "owner" },
  auth: m.auth ? { ...m.auth, readOnly: true, cap: "restricted" } : m.auth,
});
const BOB = fixtures.members[1] as { id: string; name: string };
/** Bob as an admin linked to Google, next to the owner. */
const withAdminBob = http.get("*/api/v1/members", () =>
  HttpResponse.json([
    { ...fixtures.members[0], role: "owner", identities: ["google"] },
    {
      ...BOB,
      role: "admin",
      status: "active",
      identities: ["google"],
      restriction: null,
    },
  ]),
);
const owner403 = (method: "patch" | "delete", path: string) =>
  http[method](path, () =>
    HttpResponse.json(
      { error: { code: "owner_only", message: "server text" } },
      { status: 403 },
    ),
  );

it.each([
  ["an admin", asAdmin],
  ["a capped owner", cappedOwner],
])(
  "%s sees an admin row read-only: role as text, no Remove or Reset",
  async (_n, me) => {
    mountHosted("/settings/members", true, me, [withAdminBob]);
    const r = await row(BOB.name);
    expect(within(r).getByText("Admin")).toBeVisible();
    expect(within(r).queryByRole("combobox")).toBeNull();
    expect(
      within(r).queryByRole("button", { name: `More for ${BOB.name}` }),
    ).toBeNull();
    expect(
      within(r).queryByRole("button", { name: `Remove ${BOB.name}` }),
    ).toBeNull();
  },
);

it("the owner keeps the role select, Remove and Reset on an admin row", async () => {
  mountHosted("/settings/members", true, undefined, [withAdminBob]);
  const r = await row(BOB.name);
  expect(
    within(r).getByRole("combobox", { name: `Role for ${BOB.name}` }),
  ).toBeVisible();
  const menu = await openMenu(r, BOB.name);
  expect(within(menu).getByRole("menuitem", { name: "Remove…" })).toBeVisible();
  expect(
    within(menu).getByRole("menuitem", { name: "Reset Google link…" }),
  ).toBeVisible();
});

it("a stale owner_only on the role change: inline on the row, no toast, refetched", async () => {
  const gets = calls("GET");
  mountHosted("/settings/members", true, undefined, [
    withAdminBob,
    owner403("patch", "*/api/v1/members/:id"),
  ]);
  const r = await row(BOB.name);
  fireEvent.click(
    within(r).getByRole("combobox", { name: `Role for ${BOB.name}` }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /Member/ }));
  expect(
    await within(await row(BOB.name)).findByText(ADMIN_COPY),
  ).toBeVisible();
  expect(screen.queryByText("server text")).toBeNull();
  expect(screen.queryByText("Couldn't change the role.")).toBeNull();
  await waitFor(() =>
    expect(
      gets.filter((c) => c.path === "/api/v1/members").length,
    ).toBeGreaterThan(1),
  );
});

it("a stale owner_only on Remove: inline on the row, no toast, refetched", async () => {
  const gets = calls("GET");
  mountHosted("/settings/members", true, undefined, [
    withAdminBob,
    owner403("delete", "*/api/v1/members/:id"),
  ]);
  const menu = await openMenu(await row(BOB.name), BOB.name);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove member" }));
  expect(
    await within(await row(BOB.name)).findByText(ADMIN_COPY),
  ).toBeVisible();
  expect(screen.queryByText("Couldn't remove the member.")).toBeNull();
  await waitFor(() =>
    expect(
      gets.filter((c) => c.path === "/api/v1/members").length,
    ).toBeGreaterThan(1),
  );
});

it("a stale owner_only on Reset Google link: inline on the row", async () => {
  mountHosted("/settings/members", true, undefined, [
    withAdminBob,
    owner403("delete", "*/api/v1/members/:id/identities/google"),
  ]);
  const menu = await openMenu(await row(BOB.name), BOB.name);
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Reset Google link…" }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Reset link",
    }),
  );
  expect(
    await within(await row(BOB.name)).findByText(RESET_COPY),
  ).toBeVisible();
});
