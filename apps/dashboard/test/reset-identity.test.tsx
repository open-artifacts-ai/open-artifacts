// Hosted P4 Task 16: "Reset Google link…" in the Members row menu (Design
// D11, 2026-10-22). Shown for members linked to Google; never the owner, never
// yourself; only the owner can reset another admin (the server enforces it
// too: 403).
import type { Me } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import {
  calls,
  findVisibleToast,
  installHarness,
  mountHosted,
} from "./harness";

installHarness();

const CAROL = "Cr7tNpQrSt8uVwXy";
const ITEM = /^Reset Google link/;

const row = async (name: string) => {
  const el = (await screen.findByText(name)).closest("li");
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
};
const openMenu = async (name: string) => {
  const r = await row(name);
  const more = within(r).getByRole("button", { name: `More for ${name}` });
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
};
const asAdmin = (m: Me): Me => ({ ...m, user: { ...m.user, role: "admin" } });
/** Bob as an admin linked to Google, next to Carol. */
const withAdminBob = http.get("*/api/v1/members", () =>
  HttpResponse.json([
    { ...fixtures.members[0], role: "owner", identities: ["google"] },
    {
      ...fixtures.members[1],
      role: "admin",
      status: "active",
      identities: ["google"],
      restriction: null,
    },
  ]),
);

it("offered on a member linked to Google: confirm, then DELETE, then the toast", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/members", true, undefined, [
    http.get("*/api/v1/members", () =>
      HttpResponse.json([
        { ...fixtures.members[0], role: "owner", identities: ["google"] },
        {
          id: CAROL,
          email: "carol@example.com",
          name: "Carol Departed",
          role: "member",
          status: "active",
          identities: ["google"],
          restriction: null,
          lastSeenAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ),
  ]);
  const menu = await openMenu("Carol Departed");
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Reset Google link…" }),
  );
  const d = screen.getByRole("alertdialog");
  expect(
    within(d).getByRole("heading", {
      name: "Reset Google link for Carol Departed?",
    }),
  ).toBeVisible();
  expect(d).toHaveTextContent(
    "Carol Departed stays a member with the same roles but is signed out everywhere. Their next Google sign-in links their account again. Use this if they changed Google accounts or the link points to the wrong one.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Reset link" }));
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(
      `/api/v1/members/${CAROL}/identities/google`,
    ),
  );
  await findVisibleToast(
    "Google link reset for Carol Departed. They're signed out and link again at their next Google sign-in.",
  );
});

it("not offered without a Google link, on the owner, or on yourself", async () => {
  mountHosted("/settings/members");
  // Dan: identities [] in the mock.
  const dan = await openMenu("Dan Contractor");
  expect(within(dan).queryByRole("menuitem", { name: ITEM })).toBeNull();
  fireEvent.keyDown(dan, { key: "Escape" });
  // Ada is the owner and you: no menu at all.
  expect(
    within(await row("Ada Lovelace")).queryByRole("button", {
      name: /^More for/,
    }),
  ).toBeNull();
});

it("an admin can't reset another admin (only the owner can)", async () => {
  mountHosted("/settings/members", true, asAdmin, [withAdminBob]);
  // Another admin's row is read-only for an admin (#475): no menu at all.
  const r = await row("Bob Builder");
  expect(
    within(r).queryByRole("button", { name: "More for Bob Builder" }),
  ).toBeNull();
});

it("the owner can reset an admin's link", async () => {
  mountHosted("/settings/members", true, undefined, [withAdminBob]);
  const menu = await openMenu("Bob Builder");
  expect(
    within(menu).getByRole("menuitem", { name: "Reset Google link…" }),
  ).toBeVisible();
});

it("404: nothing to reset, named", async () => {
  mountHosted("/settings/members", true, undefined, [
    withAdminBob,
    http.delete("*/api/v1/members/:id/identities/google", () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    ),
  ]);
  fireEvent.click(
    within(await openMenu("Bob Builder")).getByRole("menuitem", {
      name: "Reset Google link…",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Reset link",
    }),
  );
  await findVisibleToast(
    "No Google sign-in is linked to Bob Builder, so there's nothing to reset.",
  );
  expect(screen.queryByText("Not found")).toBeNull();
});

it("owner_only: only the owner can reset another admin's link", async () => {
  mountHosted("/settings/members", true, undefined, [
    withAdminBob,
    http.delete("*/api/v1/members/:id/identities/google", () =>
      HttpResponse.json(
        { error: { code: "owner_only", message: "server text" } },
        { status: 403 },
      ),
    ),
  ]);
  fireEvent.click(
    within(await openMenu("Bob Builder")).getByRole("menuitem", {
      name: "Reset Google link…",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Reset link",
    }),
  );
  // An inline refusal on the row since #558, not a toast.
  expect(
    await screen.findByText(
      "Only the owner can reset another admin's Google link.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("server text")).toBeNull();
});

it("after owner_only, members and you refetch, so Reset leaves that row", async () => {
  // The page thinks you're the owner; the server knows you're an admin now.
  let demoted = false;
  mountHosted("/settings/members", true, (m) => (demoted ? asAdmin(m) : m), [
    withAdminBob,
    http.delete("*/api/v1/members/:id/identities/google", () => {
      demoted = true;
      return HttpResponse.json(
        { error: { code: "owner_only", message: "server text" } },
        { status: 403 },
      );
    }),
  ]);
  fireEvent.click(
    within(await openMenu("Bob Builder")).getByRole("menuitem", {
      name: "Reset Google link…",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Reset link",
    }),
  );
  await screen.findByText(
    "Only the owner can reset another admin's Google link.",
  );
  // Now an admin: Bob's admin row turns read-only (no menu, so no Reset).
  await waitFor(async () =>
    expect(
      within(await row("Bob Builder")).queryByRole("button", {
        name: "More for Bob Builder",
      }),
    ).toBeNull(),
  );
});

it("any other 403 falls back to the owner copy", async () => {
  mountHosted("/settings/members", true, undefined, [
    withAdminBob,
    http.delete("*/api/v1/members/:id/identities/google", () =>
      HttpResponse.json(
        { error: { code: "forbidden", message: "server text" } },
        { status: 403 },
      ),
    ),
  ]);
  fireEvent.click(
    within(await openMenu("Bob Builder")).getByRole("menuitem", {
      name: "Reset Google link…",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Reset link",
    }),
  );
  await findVisibleToast(
    "Only the owner can reset another admin's Google link.",
  );
  expect(screen.queryByText("server text")).toBeNull();
});
