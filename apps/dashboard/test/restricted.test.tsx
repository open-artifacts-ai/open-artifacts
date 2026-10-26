// Hosted P4 Task 15: restricted members, Design D14 A (a badge, and Restrict
// in the row's More menu). Copy: build spec t6cjQuskQ6zrZaJd v5.
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import {
  restrictionLabel,
  restrictionReason,
} from "../src/settings/restriction";
import {
  calls,
  findVisibleToast,
  installHarness,
  mount,
  mountHosted,
} from "./harness";

installHarness();

const BOB = "Bc4eFgHjKm5nPqRs";
const DAN = "Dn8uPqRsTu9vWxYz";
const con = {
  groupId: "gCon04",
  email: "contractors@example.com",
  name: "Contractors",
};
const ven = {
  groupId: "gVen05",
  email: "vendors@example.com",
  name: "Vendors",
};

/** A Members row: the list item holding `name`. */
const row = async (name: string) => {
  const el = (await screen.findByText(name)).closest("li");
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
};
const openMenu = async (name: string) => {
  const r = await row(name);
  const more = within(r).getByRole("button", { name: `More for ${name}` });
  // Radix menus open on pointerdown (jsdom has no full pointer events).
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
};
const choose = async (name: string, item: string | RegExp) => {
  const menu = await openMenu(name);
  fireEvent.click(within(menu).getByRole("menuitem", { name: item }));
};

it("restrictionLabel and restrictionReason", () => {
  expect(restrictionLabel(null)).toBeNull();
  expect(restrictionLabel(undefined)).toBeNull();
  expect(restrictionLabel({ manual: false, groups: [] })).toBeNull();
  expect(restrictionLabel({ manual: true, groups: [] })).toBe(
    "Restricted manually",
  );
  expect(restrictionLabel({ manual: false, groups: [con] })).toBe(
    "Restricted via Contractors",
  );
  expect(restrictionLabel({ manual: true, groups: [con] })).toBe(
    "Restricted manually and via Contractors",
  );
  expect(restrictionLabel({ manual: false, groups: [con, ven] })).toBe(
    "Restricted via Contractors and Vendors",
  );
  expect(
    restrictionReason({
      manual: false,
      groups: [con, ven, { ...ven, groupId: "g3", name: "Temps" }],
    }),
  ).toBe("via Contractors, Vendors and Temps");
  expect(restrictionReason({ manual: true, groups: [] })).toBe("manually");
});

it("Dan shows the badge and the reason, and the group cause can't be cleared here", async () => {
  mountHosted("/settings/members");
  const r = await row("Dan Contractor");
  expect(within(r).getAllByText("Restricted")[0]).toBeVisible();
  expect(r).toHaveTextContent("dan@example.com · via Contractors");
  const menu = await openMenu("Dan Contractor");
  const group = within(menu).getByRole("menuitem", {
    name: /Restricted via Contractors/,
  });
  expect(group).toHaveAttribute("aria-disabled", "true");
  expect(group).toHaveTextContent("Lift it in Directory, Restricted groups");
  expect(
    within(menu).queryByRole("menuitem", { name: /Lift manual restriction/ }),
  ).toBeNull();
  expect(
    within(menu).getByRole("menuitem", { name: "Restrict manually…" }),
  ).toBeVisible();
});

it("the Restricted badge uses the warning-soft tone, not the role badge's outline", async () => {
  mountHosted("/settings/members");
  const badges = within(await row("Dan Contractor")).getAllByText("Restricted");
  const owner = within(await row("Ada Lovelace")).getByText("Owner");
  for (const b of badges) {
    expect(b).toHaveAttribute("data-tone", "warning");
    expect(b.className).toContain("bg-[var(--oa-warning-soft)]");
    expect(b.className).toContain("text-[var(--oa-warning)]");
    expect(b.className).not.toBe(owner.className);
  }
});

it("an admin restricts Bob manually: confirm, then PUT, then the badge", async () => {
  const seen = calls("PUT");
  mountHosted("/settings/members");
  await choose("Bob Builder", "Restrict manually…");
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Restrict Bob Builder?");
  expect(d).toHaveTextContent(
    "Bob will only be able to view, in every space and in their personal space. They can't publish, edit, share or write live data, from the app or any AI agent. Their artifacts stay where they are.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Restrict" }));
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(`/api/v1/members/${BOB}/restricted`),
  );
  const r = await row("Bob Builder");
  await waitFor(() =>
    expect(r).toHaveTextContent("bob@example.com · manually"),
  );
  expect(within(r).getAllByText("Restricted")[0]).toBeVisible();
});

it("Cancel restricts nobody", async () => {
  const seen = calls("PUT");
  mountHosted("/settings/members");
  await choose("Bob Builder", "Restrict manually…");
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(seen).toHaveLength(0);
});

it("lifting Dan's manual restriction DELETEs and keeps the group restriction", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/members");
  await choose("Dan Contractor", "Restrict manually…");
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Restrict",
    }),
  );
  await waitFor(async () =>
    expect(await row("Dan Contractor")).toHaveTextContent(
      "manually and via Contractors",
    ),
  );
  await choose("Dan Contractor", "Lift manual restriction…");
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Lift Dan's manual restriction?");
  expect(d).toHaveTextContent(
    "Dan stays restricted via Contractors. To lift that, remove Contractors from Restricted groups in Directory.",
  );
  fireEvent.click(
    within(d).getByRole("button", { name: "Lift manual restriction" }),
  );
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(`/api/v1/members/${DAN}/restricted`),
  );
  await waitFor(async () =>
    expect(await row("Dan Contractor")).toHaveTextContent(
      "dan@example.com · via Contractors",
    ),
  );
  expect(await row("Dan Contractor")).not.toHaveTextContent("manually");
});

it("lifting a manual-only restriction says they get their roles back", async () => {
  mountHosted("/settings/members");
  await choose("Bob Builder", "Restrict manually…");
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Restrict",
    }),
  );
  await waitFor(async () =>
    expect(await row("Bob Builder")).toHaveTextContent("manually"),
  );
  await choose("Bob Builder", "Lift manual restriction…");
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "Bob gets back the roles their spaces and groups give them.",
  );
});

it("works in frozen Team installs (the manual flag ignores sync mode)", async () => {
  mountHosted("/settings/members", { tier: "team", directory: "frozen" });
  const menu = await openMenu("Bob Builder");
  expect(
    within(menu).getByRole("menuitem", { name: "Restrict manually…" }),
  ).not.toHaveAttribute("aria-disabled");
});

it("owners and admins never get Restrict", async () => {
  mountHosted("/settings/members", true, undefined, [
    http.get("*/api/v1/members", () =>
      HttpResponse.json([
        {
          ...fixtures.members[0],
          role: "owner",
          status: "active",
          identities: ["google"],
          restriction: null,
        },
        {
          ...fixtures.members[1],
          role: "admin",
          status: "active",
          identities: [],
          restriction: null,
        },
      ]),
    ),
  ]);
  await row("Ada Lovelace");
  const bob = await openMenu("Bob Builder");
  expect(within(bob).queryByRole("menuitem", { name: /Restrict/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "More for Ada Lovelace" }),
  ).toBeNull();
});

it("guests never get Restrict", async () => {
  mountHosted("/settings/members", true, undefined, [
    http.get("*/api/v1/members", () =>
      HttpResponse.json([
        {
          ...fixtures.members[1],
          role: "guest",
          status: "active",
          restriction: null,
        },
      ]),
    ),
  ]);
  const menu = await openMenu("Bob Builder");
  expect(within(menu).queryByRole("menuitem", { name: /Restrict/ })).toBeNull();
});

it("a 400 restrict_admin (promoted in another tab) shows the copy and no badge", async () => {
  mountHosted("/settings/members", true, undefined, [
    http.put(`*${R.memberRestricted(BOB)}`, () =>
      HttpResponse.json(
        { error: { code: "restrict_admin", message: "server text" } },
        { status: 400 },
      ),
    ),
  ]);
  await choose("Bob Builder", "Restrict manually…");
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Restrict",
    }),
  );
  await findVisibleToast(
    "Owners and admins can't be restricted. Make them a member first.",
  );
  expect(screen.queryByText("server text")).toBeNull();
  expect(
    within(await row("Bob Builder")).queryAllByText("Restricted"),
  ).toHaveLength(0);
});

it("Remove moves into the More menu on hosted rows and still confirms", async () => {
  mountHosted("/settings/members");
  const r = await row("Bob Builder");
  expect(
    within(r).queryByRole("button", { name: "Remove Bob Builder" }),
  ).toBeNull();
  await choose("Bob Builder", "Remove…");
  expect(
    screen.getByRole("dialog", { name: "Remove Bob Builder?" }),
  ).toBeVisible();
});

it("self-hosted: today's Remove button, no More menu, no Restrict", async () => {
  mount("/settings/members");
  const r = await row("Bob Builder");
  expect(
    within(r).getByRole("button", { name: "Remove Bob Builder" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /^More for / })).toBeNull();
  expect(screen.queryAllByText("Restricted")).toHaveLength(0);
});

it("no copy contains an em dash", async () => {
  mountHosted("/settings/members");
  await choose("Dan Contractor", "Restrict manually…");
  expect(document.body.textContent).not.toContain("—");
});
