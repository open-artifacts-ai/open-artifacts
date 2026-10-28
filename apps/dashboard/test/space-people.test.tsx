// Hosted P4 Task 12: a space's People (Design D6, gqV17VcWTQmZmUXJ v3, all
// recommendations): one reason line per person, roles that only raise,
// Remove only with a manual role, org members only, guests, people who can't
// sign in, frozen edits, search plus Load more. Interim copy from D6 v3.
import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type HttpHandler, HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import {
  type Call,
  calls,
  installHarness,
  mount,
  mountHosted,
} from "./harness";

installHarness();

const ID = "SpEngNpQrSt2uVwX";
const ENG = `/settings/spaces?space=${ID}`;
const BOB = "Bc4eFgHjKm5nPqRs";
const eng = {
  groupId: "gEng01",
  email: "eng@example.com",
  name: "Engineering",
};
const exec = { groupId: "gExec02", email: "exec@example.com", name: "Exec" };

const asManager = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "member" },
  spaces: (m.spaces ?? []).filter((s) => s.myRole === "manager"),
});
type Row = Record<string, unknown>;
const person = (o: Row): Row => ({
  status: "active",
  source: "manual",
  manualRole: null,
  syncRole: null,
  groups: [],
  cap: null,
  allMembers: null,
  ...o,
});
const serve = (
  items: Row[],
  total = items.length,
  next: string | null = null,
) =>
  http.get(`*/api/v1/spaces/${ID}/members`, () =>
    HttpResponse.json({ items, nextCursor: next, total }),
  );
const people = () => screen.findByRole("region", { name: "People" });
/** GET R.members for active people (no status, or one including active). */
const activeLookup = (c: Call) =>
  c.path === "/api/v1/members" &&
  (c.search.get("status") ?? "active").split(",").includes("active");
const row = async (name: string) => {
  const el = (await within(await people()).findByText(name)).closest("li");
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
};
const openMenu = async (name: string) => {
  const r = await row(name);
  fireEvent.pointerDown(
    within(r).getByRole("button", { name: `More for ${name}` }),
    { button: 0, pointerType: "mouse" },
  );
  return screen.findByRole("menu");
};
const mountWith = (handlers: HttpHandler[], me?: (m: Me) => Me) =>
  mountHosted(ENG, true, me, handlers);

it("self-hosted: no People card (the page redirects)", async () => {
  const router = mount(ENG);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/agents"),
  );
  await screen.findByRole("heading", { name: "Settings" });
  expect(screen.queryByRole("region", { name: "People" })).toBeNull();
});

it("lists Ada (manually added) and Bob (via eng@), with the All members note", async () => {
  mountHosted(ENG);
  const card = await people();
  expect(card).toHaveTextContent(
    "Everyone at Acme Artifacts can also view through All members. They aren't listed.",
  );
  expect(await row("Ada Lovelace")).toHaveTextContent(
    "ada@example.com · manually added",
  );
  expect(await row("Bob Builder")).toHaveTextContent(
    "bob@example.com · via eng@",
  );
  expect(card).not.toHaveTextContent(/last seen|hand-added|by hand/i);
});

it("a combined row reads winning role first", async () => {
  mountWith([
    serve([
      person({
        userId: "r1",
        user: { id: "r1", name: "Rina Patel", email: "rina@example.com" },
        role: "manager",
        manualRole: "manager",
        syncRole: "editor",
        groups: [{ ...eng, role: "editor", via: "space" }],
      }),
      person({
        userId: "s1",
        user: { id: "s1", name: "Sam Ortiz", email: "sam@example.com" },
        role: "editor",
        source: "sync",
        syncRole: "editor",
        groups: [
          { ...eng, role: "editor", via: "space" },
          { ...exec, role: "viewer", via: "every" },
        ],
      }),
    ]),
  ]);
  expect(await row("Rina Patel")).toHaveTextContent(
    "rina@example.com · Manager (manually added), Editor via eng@",
  );
  expect(await row("Sam Ortiz")).toHaveTextContent(
    "sam@example.com · via eng@, exec@ (every space)",
  );
});

it("a group mapped both ways shows only its stronger entry", async () => {
  mountWith([
    serve([
      person({
        userId: "s1",
        user: { id: "s1", name: "Sam Ortiz", email: "sam@example.com" },
        role: "manager",
        manualRole: "manager",
        syncRole: "editor",
        groups: [
          { ...eng, role: "viewer", via: "space" },
          { ...eng, role: "editor", via: "every" },
        ],
      }),
    ]),
  ]);
  const r = await row("Sam Ortiz");
  expect(r).toHaveTextContent(
    "sam@example.com · Manager (manually added), Editor via eng@ (every space)",
  );
  expect(r).not.toHaveTextContent("Viewer via eng@");
});

it("a synced person's select only raises; it PUTs the manual role by user id", async () => {
  const seen = calls("PUT");
  mountHosted(ENG);
  const r = await row("Bob Builder");
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for Bob Builder" }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Editor · via eng@", "Manager · manually added"]);
  fireEvent.click(
    screen.getByRole("option", { name: "Manager · manually added" }),
  );
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ID}/members/${BOB}`,
        body: { role: "manager" },
      }),
    ),
  );
});

it("synced-only rows offer no Remove; the menu says where to change it", async () => {
  mountHosted(ENG);
  const menu = await openMenu("Bob Builder");
  expect(within(menu).queryByRole("menuitem", { name: /Remove/ })).toBeNull();
  const info = within(menu).getByRole("menuitem", { name: /Synced from eng@/ });
  expect(info).toHaveAttribute("aria-disabled", "true");
  expect(info).toHaveTextContent(
    "Change it in Google, or under Who gets access",
  );
});

it("removing a manually added person asks, names All members, then DELETEs", async () => {
  const seen = calls("DELETE");
  mountWith([
    serve([
      person({
        userId: "l1",
        user: { id: "l1", name: "Lee Chen", email: "lee@example.com" },
        role: "editor",
        manualRole: "editor",
        allMembers: "viewer",
      }),
    ]),
  ]);
  fireEvent.click(
    within(await openMenu("Lee Chen")).getByRole("menuitem", {
      name: "Remove from Engineering…",
    }),
  );
  const d = screen.getByRole("alertdialog");
  expect(
    within(d).getByRole("heading", {
      name: "Remove Lee Chen from Engineering?",
    }),
  ).toBeVisible();
  expect(d).toHaveTextContent(
    "Lee keeps Viewer through All members. Artifacts Lee made here stay in the space.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(`/api/v1/spaces/${ID}/members/l1`),
  );
});

it("removing a combined row's manual role says what they keep", async () => {
  mountWith([
    serve([
      person({
        userId: "r1",
        user: { id: "r1", name: "Rina Patel", email: "rina@example.com" },
        role: "manager",
        manualRole: "manager",
        syncRole: "editor",
        groups: [{ ...eng, role: "editor", via: "space" }],
      }),
    ]),
  ]);
  fireEvent.click(
    within(await openMenu("Rina Patel")).getByRole("menuitem", {
      name: /Remove manually added role/,
    }),
  );
  const d = screen.getByRole("alertdialog");
  expect(
    within(d).getByRole("heading", {
      name: "Remove Rina's manually added role?",
    }),
  ).toBeVisible();
  expect(d).toHaveTextContent(
    "Rina goes from Manager to Editor, the role eng@ gives. To take Rina out of the space, change eng@ in Google or under Who gets access.",
  );
  expect(within(d).getByRole("button", { name: "Remove role" })).toBeVisible();
});

it("leaving yourself has its own confirm", async () => {
  mountHosted(ENG);
  fireEvent.click(
    within(await openMenu("Ada Lovelace")).getByRole("menuitem", {
      name: "Leave Engineering…",
    }),
  );
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent(
    "You won't be able to manage this space after this. An admin can add you back.",
  );
  expect(within(d).getByRole("button", { name: "Leave" })).toBeVisible();
});

it("restricted and guest rows show Viewer as text with their chip and reason", async () => {
  mountWith([
    serve([
      person({
        userId: "d1",
        user: { id: "d1", name: "Dan Contractor", email: "dan@example.com" },
        role: "editor",
        manualRole: "editor",
        cap: "restricted",
      }),
      person({
        userId: "g1",
        user: { id: "g1", name: "Gia Ruiz", email: "gia@partner.io" },
        role: "viewer",
        source: "sync",
        syncRole: "viewer",
        groups: [{ ...eng, role: "viewer", via: "space" }],
        cap: "guest",
      }),
    ]),
  ]);
  const dan = await row("Dan Contractor");
  expect(within(dan).getByText("Restricted")).toHaveAttribute(
    "data-tone",
    "warning",
  );
  expect(dan).toHaveTextContent("dan@example.com · Can only view · restricted");
  expect(within(dan).queryByRole("combobox")).toBeNull();
  expect(within(dan).getByText("Viewer")).toBeVisible();
  const gia = await row("Gia Ruiz");
  expect(within(gia).getByText("Guest")).toBeVisible();
  expect(gia).toHaveTextContent(
    "Gia Ruiz, guest, can only view. Guests sign in by link and can't publish, edit or write live data, from the app or any AI agent.",
  );
  expect(gia).toHaveTextContent(
    "gia@partner.io · Guest · can only view · via eng@",
  );
  expect(within(gia).queryByRole("combobox")).toBeNull();
});

it("a restricted row's reason comes from the row itself, with no member lookup", async () => {
  const gets = calls("GET");
  mountWith([
    serve([
      person({
        userId: "d1",
        user: { id: "d1", name: "Dan Contractor", email: "dan@example.com" },
        role: "editor",
        manualRole: "editor",
        cap: "restricted",
        restriction: {
          manual: false,
          groups: [
            {
              groupId: "gCon09",
              email: "contractors@example.com",
              name: "Contractors",
            },
          ],
        },
      }),
    ]),
  ]);
  expect(await row("Dan Contractor")).toHaveTextContent(
    "Can only view · restricted via Contractors",
  );
  // No active-member lookup (Departed's suspended,removed list is admin-only and separate).
  expect(gets.some(activeLookup)).toBe(false);
});

it("suspended and removed people sort last, say No access, and show the role as text", async () => {
  mountWith([
    serve([
      person({
        userId: "c1",
        user: { id: "c1", name: "Carol King", email: "carol@example.com" },
        status: "suspended",
        role: "editor",
        manualRole: "editor",
      }),
      person({
        userId: "s1",
        user: { id: "s1", name: "Sam Ortiz", email: "sam@example.com" },
        role: "editor",
        source: "sync",
        syncRole: "editor",
        groups: [{ ...eng, role: "editor", via: "space" }],
      }),
      person({
        userId: "t1",
        user: { id: "t1", name: "Tom Weber", email: "tom@example.com" },
        status: "removed",
        role: "viewer",
        source: "sync",
        syncRole: "viewer",
        groups: [{ ...eng, role: "viewer", via: "space" }],
      }),
    ]),
  ]);
  const card = await people();
  await within(card).findByText("Carol King");
  expect(
    [...card.querySelectorAll("li b span:first-child")].map(
      (s) => s.textContent,
    ),
  ).toEqual(["Sam Ortiz", "Carol King", "Tom Weber"]);
  const carol = await row("Carol King");
  expect(carol).toHaveTextContent(
    "carol@example.com · No access while suspended · Editor (manually added)",
  );
  expect(within(carol).queryByRole("combobox")).toBeNull();
  expect(await row("Tom Weber")).toHaveTextContent(
    "tom@example.com · No access · via eng@",
  );
  const menu = await openMenu("Carol King");
  expect(
    within(menu).getByRole("menuitem", { name: "Manage in Members" }),
  ).toBeVisible();
});

it("a space manager can't raise to Manager or touch an admin-set Manager row", async () => {
  mountWith(
    [
      serve([
        person({
          userId: "r1",
          user: { id: "r1", name: "Rina Patel", email: "rina@example.com" },
          role: "manager",
          manualRole: "manager",
        }),
        person({
          userId: BOB,
          user: { id: BOB, name: "Bob Builder", email: "bob@example.com" },
          role: "editor",
          source: "sync",
          syncRole: "editor",
          groups: [{ ...eng, role: "editor", via: "space" }],
        }),
      ]),
    ],
    asManager,
  );
  const rina = await row("Rina Patel");
  expect(within(rina).queryByRole("combobox")).toBeNull();
  expect(within(rina).queryByRole("button", { name: /More for/ })).toBeNull();
  // Bob's only higher role is Manager, which a space manager can't give: plain text.
  const bob = await row("Bob Builder");
  expect(within(bob).queryByRole("combobox")).toBeNull();
  expect(within(bob).getByText("Editor")).toBeVisible();
});

const managerRows = () =>
  serve([
    person({
      userId: "r1",
      user: { id: "r1", name: "Rina Patel", email: "rina@example.com" },
      role: "manager",
      manualRole: "manager",
    }),
    person({
      userId: "m2",
      user: { id: "m2", name: "Max Weber", email: "max@example.com" },
      role: "manager",
      source: "sync",
      syncRole: "manager",
      groups: [{ ...eng, role: "manager", via: "space" }],
    }),
  ]);

it("a non-admin space manager sees every other manager row, manual or synced, as text with no controls", async () => {
  mountWith([managerRows()], asManager);
  for (const name of ["Rina Patel", "Max Weber"]) {
    const r = await row(name);
    expect(within(r).queryByRole("combobox")).toBeNull();
    expect(within(r).queryByRole("button", { name: /More for/ })).toBeNull();
    expect(within(r).getByText("Manager")).toBeVisible();
  }
});

it("a non-admin space manager sees a frozen kept manager row as text too", async () => {
  mountHosted(ENG, { directory: "frozen" }, asManager, [managerRows()]);
  const r = await row("Max Weber");
  expect(within(r).queryByRole("combobox")).toBeNull();
  expect(within(r).queryByRole("button", { name: /More for/ })).toBeNull();
  expect(within(r).getByText("Manager")).toBeVisible();
});

it("an org admin keeps the role select and Remove on manager rows", async () => {
  mountWith([managerRows()]);
  const r = await row("Rina Patel");
  expect(
    within(r).getByRole("combobox", { name: "Role for Rina Patel" }),
  ).toBeVisible();
  expect(
    within(r).getByRole("button", { name: "More for Rina Patel" }),
  ).toBeVisible();
});

it("an org admin can change a frozen kept manager row", async () => {
  mountHosted(ENG, { directory: "frozen" }, undefined, [managerRows()]);
  const r = await row("Max Weber");
  expect(
    within(r).getByRole("combobox", { name: "Role for Max Weber" }),
  ).toBeVisible();
});

it("a stale 403 on Remove (a manager row the list showed as removable) says why by the row", async () => {
  mountWith([
    serve([
      person({
        userId: "l1",
        user: { id: "l1", name: "Lee Chen", email: "lee@example.com" },
        role: "editor",
        manualRole: "editor",
      }),
    ]),
    http.delete(`*/api/v1/spaces/${ID}/members/:u`, () =>
      HttpResponse.json(
        {
          error: {
            code: "space_forbidden",
            message: "server text",
            details: { target: "member" },
          },
        },
        { status: 403 },
      ),
    ),
  ]);
  const r = await row("Lee Chen");
  fireEvent.pointerDown(
    within(r).getByRole("button", { name: "More for Lee Chen" }),
    { button: 0, pointerType: "mouse" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /^Remove from/ }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  expect(
    await within(r).findByText(
      "Only an admin can change another manager's access.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("server text")).toBeNull();
});

it("a 403 on Remove or a non-promoting role change refetches the members", async () => {
  const seen = calls("GET");
  mountWith([
    serve([
      person({
        userId: "l1",
        user: { id: "l1", name: "Lee Chen", email: "lee@example.com" },
        role: "editor",
        manualRole: "editor",
      }),
    ]),
    http.put(`*/api/v1/spaces/${ID}/members/:u`, () =>
      HttpResponse.json(
        {
          error: {
            code: "space_forbidden",
            message: "server text",
            details: { target: "member" },
          },
        },
        { status: 403 },
      ),
    ),
  ]);
  const r = await row("Lee Chen");
  const loads = () =>
    seen.filter((c) => c.path === `/api/v1/spaces/${ID}/members`).length;
  const before = loads();
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for Lee Chen" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Viewer" }));
  expect(
    await within(r).findByText(
      "Only an admin can change another manager's access.",
    ),
  ).toBeVisible();
  await waitFor(() => expect(loads()).toBeGreaterThan(before));
});

it("only a non-admin manager who can see another manager gets the muted line under the intro", async () => {
  const line = "Only an admin can change another manager's access.";
  mountWith([managerRows()], asManager);
  await row("Rina Patel");
  expect(await within(await people()).findAllByText(line)).toHaveLength(1);
});

it("the muted manager line is not shown to an org admin", async () => {
  mountWith([managerRows()]);
  await row("Rina Patel");
  expect(
    within(await people()).queryByText(
      "Only an admin can change another manager's access.",
    ),
  ).toBeNull();
});

it("no muted manager line for a non-admin manager when no one else manages", async () => {
  mountWith(
    [
      serve([
        person({
          userId: "l1",
          user: { id: "l1", name: "Lee Chen", email: "lee@example.com" },
          role: "editor",
          manualRole: "editor",
        }),
      ]),
    ],
    asManager,
  );
  await row("Lee Chen");
  expect(
    within(await people()).queryByText(
      "Only an admin can change another manager's access.",
    ),
  ).toBeNull();
});

it("a 403 space_forbidden on a role change shows the copy by the row and snaps back", async () => {
  mountWith([
    http.put(`*/api/v1/spaces/${ID}/members/:u`, () =>
      HttpResponse.json(
        {
          error: {
            code: "space_forbidden",
            message: "server text",
            details: { target: "member" },
          },
        },
        { status: 403 },
      ),
    ),
  ]);
  const r = await row("Bob Builder");
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for Bob Builder" }),
  );
  fireEvent.click(
    await screen.findByRole("option", { name: "Manager · manually added" }),
  );
  expect(
    await within(r).findByText("Only an admin can make someone a manager."),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      within(r).getByRole("combobox", { name: "Role for Bob Builder" }),
    ).toHaveTextContent("Editor"),
  );
  expect(screen.queryByText("server text")).toBeNull();
});

it("a 409 member_synced on remove says where the access comes from", async () => {
  mountWith([
    serve([
      person({
        userId: "r1",
        user: { id: "r1", name: "Rina Patel", email: "rina@example.com" },
        role: "manager",
        manualRole: "manager",
        syncRole: "editor",
        groups: [{ ...eng, role: "editor", via: "space" }],
      }),
    ]),
    http.delete(`*/api/v1/spaces/${ID}/members/:u`, () =>
      HttpResponse.json(
        { error: { code: "member_synced", message: "server text" } },
        { status: 409 },
      ),
    ),
  ]);
  fireEvent.click(
    within(await openMenu("Rina Patel")).getByRole("menuitem", {
      name: /Remove manually added role/,
    }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Remove role",
    }),
  );
  expect(
    await within(await row("Rina Patel")).findByText(
      "Rina is here through eng@. Change it in Google, or remove the group under Who gets access.",
    ),
  ).toBeVisible();
});

// -- adding

it("Add people: org members only, already-here marked, Viewer by default, one PUT each", async () => {
  const seen = calls("PUT");
  mountHosted(ENG);
  fireEvent.click(
    within(await people()).getByRole("button", { name: "Add people" }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Add people to Engineering",
  });
  expect(d).toHaveTextContent(
    "They get access within a minute. Recorded in the audit log.",
  );
  expect(within(d).getByRole("radio", { name: /^Viewer/ })).toBeChecked();
  expect(within(d).getByRole("radio", { name: /^Manager/ })).toBeVisible();
  const box = within(d).getByRole("combobox", { name: "People" });
  fireEvent.change(box, { target: { value: "bo" } });
  const bob = await screen.findByRole("option", { name: /Bob Builder/ });
  expect(bob).toHaveTextContent("Already here as Editor");
  expect(bob).toHaveAttribute("aria-disabled", "true");
  fireEvent.change(box, { target: { value: "da" } });
  fireEvent.click(
    await screen.findByRole("option", { name: /Dan Contractor/ }),
  );
  expect(d).toHaveTextContent(
    "Dan Contractor can only view, whatever the role: restricted via Contractors.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Add 1 person" }));
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ID}/members/Dn8uPqRsTu9vWxYz`,
        body: { role: "viewer" },
      }),
    ),
  );
});

it("Add people with nobody picked says so", async () => {
  mountHosted(ENG);
  fireEvent.click(
    within(await people()).getByRole("button", { name: "Add people" }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Add people to Engineering",
  });
  fireEvent.click(within(d).getByRole("button", { name: "Add" }));
  expect(await within(d).findByText("Pick at least one person.")).toBeVisible();
});

// Review item 3: GET /members is admin-only, so a manager's search can't use it.
it("a space manager who isn't an org admin finds and adds people (R.spaceCandidates)", async () => {
  const seen = calls("PUT");
  const gets = calls("GET");
  mountHosted(ENG, true, asManager);
  fireEvent.click(
    within(await people()).getByRole("button", { name: "Add people" }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Add people to Engineering",
  });
  fireEvent.change(within(d).getByRole("combobox", { name: "People" }), {
    target: { value: "da" },
  });
  fireEvent.click(
    await screen.findByRole("option", { name: /Dan Contractor/ }),
  );
  fireEvent.click(within(d).getByRole("button", { name: "Add 1 person" }));
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ID}/members/Dn8uPqRsTu9vWxYz`,
        body: { role: "viewer" },
      }),
    ),
  );
  expect(
    gets.some(
      (c) =>
        c.path === `/api/v1/spaces/${ID}/candidates` &&
        c.search.get("q") === "da",
    ),
  ).toBe(true);
  // No active-member lookup (Departed's suspended,removed list is admin-only and separate).
  expect(gets.some(activeLookup)).toBe(false);
});

it("a space manager's Add people has no Manager role", async () => {
  mountHosted(ENG, true, asManager);
  fireEvent.click(
    within(await people()).getByRole("button", { name: "Add people" }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Add people to Engineering",
  });
  expect(within(d).queryByRole("radio", { name: /^Manager/ })).toBeNull();
});

// -- search and paging

it("search shows above 20 people, sends q, and Load more pages on", async () => {
  const seen = calls("GET");
  // The search box and paging key off the total (312), not the rows on the
  // page: a few rows per page keep the render cheap under a loaded suite.
  const page = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      person({
        userId: `u${from + i}`,
        user: {
          id: `u${from + i}`,
          name: `Person ${String(from + i).padStart(2, "0")}`,
          email: `p${from + i}@example.com`,
        },
        role: "viewer",
        manualRole: "viewer",
      }),
    );
  mountWith([
    http.get(`*/api/v1/spaces/${ID}/members`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("cursor") === "c1"
          ? { items: page(3, 2), nextCursor: null, total: 312 }
          : { items: page(0, 3), nextCursor: "c1", total: 312 },
      ),
    ),
  ]);
  const card = await people();
  expect(await within(card).findByText("Showing 3 of 312")).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Load more" }));
  // Wait for the page to land, not just the request: nothing is left in flight
  // when the search starts.
  expect(await within(card).findByText("Person 04")).toBeVisible();
  expect(
    seen.some(
      (c) =>
        c.path === `/api/v1/spaces/${ID}/members` &&
        c.search.get("cursor") === "c1",
    ),
  ).toBe(true);
  fireEvent.change(
    within(card).getByRole("searchbox", {
      name: "Search people in Engineering",
    }),
    { target: { value: "sam" } },
  );
  await waitFor(() =>
    expect(
      seen.some(
        (c) =>
          c.path === `/api/v1/spaces/${ID}/members` &&
          c.search.get("q") === "sam",
      ),
    ).toBe(true),
  );
});

it("20 or fewer: no search box", async () => {
  mountHosted(ENG);
  await row("Ada Lovelace");
  expect(screen.queryByRole("searchbox", { name: /Search people/ })).toBeNull();
});

// -- frozen

it("frozen: the note, kept rows say kept from, any role, and Remove from the space", async () => {
  mountHosted(ENG, { directory: "frozen" });
  const card = await people();
  expect(card).toHaveTextContent(
    "Group sync is off. Everyone below was kept as of the last sync and is edited manually.",
  );
  const bob = await row("Bob Builder");
  expect(bob).toHaveTextContent("bob@example.com · kept from eng@");
  fireEvent.click(
    within(bob).getByRole("combobox", { name: "Role for Bob Builder" }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Viewer", "Editor", "Manager"]);
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  fireEvent.click(
    within(await openMenu("Bob Builder")).getByRole("menuitem", {
      name: "Remove from Engineering…",
    }),
  );
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "Bob loses access to Engineering within a minute. If sync comes back and eng@ still includes Bob, Bob gets Editor again.",
  );
});

it("frozen: Edit people on a kept group filters People to it, and Show everyone clears it", async () => {
  const seen = calls("GET");
  mountHosted(ENG, { directory: "frozen" });
  const access = await screen.findByRole("table", { name: "Groups" });
  fireEvent.click(
    await within(access).findByRole("button", {
      name: "Edit people from eng@example.com",
    }),
  );
  await waitFor(() =>
    expect(
      seen.some(
        (c) =>
          c.path === `/api/v1/spaces/${ID}/members` &&
          c.search.get("group") === "gEng01",
      ),
    ).toBe(true),
  );
  const card = await people();
  expect(
    await within(card).findByText(
      /(person|people) from eng@ as of .+ · Editor/,
    ),
  ).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Show everyone" }));
  await waitFor(() =>
    expect(within(card).queryByText(/from eng@ as of/)).toBeNull(),
  );
});

it("Add people is a full-width sheet on a phone", async () => {
  mountHosted(ENG);
  fireEvent.click(
    within(await people()).getByRole("button", { name: "Add people" }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Add people to Engineering",
  });
  expect(d.className).toContain("max-[640px]:max-w-full");
  expect(d.className).toContain("max-[640px]:bottom-0");
});

it("Ada (an owner in the mock) can give Manager; a non-admin manager gets only Viewer and Editor", async () => {
  const viewerRow = serve([
    person({
      userId: "l1",
      user: { id: "l1", name: "Lee Chen", email: "lee@example.com" },
      role: "viewer",
      manualRole: "viewer",
    }),
  ]);
  mountWith([viewerRow], asManager);
  fireEvent.click(
    within(await row("Lee Chen")).getByRole("combobox", {
      name: "Role for Lee Chen",
    }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Viewer", "Editor"]);
});

it("as an admin the same row offers Viewer, Editor and Manager", async () => {
  mountWith([
    serve([
      person({
        userId: "l1",
        user: { id: "l1", name: "Lee Chen", email: "lee@example.com" },
        role: "viewer",
        manualRole: "viewer",
      }),
    ]),
  ]);
  fireEvent.click(
    within(await row("Lee Chen")).getByRole("combobox", {
      name: "Role for Lee Chen",
    }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Viewer", "Editor", "Manager"]);
});

// -- review item 19: people here only through an Every space group

const everyOnly = person({
  userId: "e1",
  user: { id: "e1", name: "Eve Park", email: "eve@example.com" },
  role: "editor",
  source: "sync",
  syncRole: "editor",
  groups: [{ ...exec, role: "editor", via: "every" }],
});

it("an org admin: no Remove, no role below the Every space group's, and a link to Every space", async () => {
  mountWith([serve([everyOnly])]);
  const r = await row("Eve Park");
  expect(
    within(r).queryByRole("button", { name: "More for Eve Park" }),
  ).toBeNull();
  expect(r).toHaveTextContent(
    "Set by an Every space group. Change it in Settings › Spaces › Every space.",
  );
  expect(
    within(r).getByRole("link", { name: "Settings › Spaces › Every space" }),
  ).toHaveAttribute("href", "/settings/spaces#oa-every-space");
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for Eve Park" }),
  );
  const roles = (await screen.findAllByRole("option")).map(
    (o) => o.textContent,
  );
  expect(roles.some((t) => t?.startsWith("Viewer"))).toBe(false);
  expect(roles.some((t) => t?.startsWith("Manager"))).toBe(true);
});

it("a space manager who isn't an admin: asked to go to an admin, no link", async () => {
  mountWith([serve([everyOnly])], asManager);
  const r = await row("Eve Park");
  expect(r).toHaveTextContent(
    "Set by an Every space group. Ask an admin to change it.",
  );
  expect(within(r).queryByRole("link")).toBeNull();
});

it("a frozen install keeps the floor and still offers no Remove", async () => {
  mountHosted(ENG, { directory: "frozen" }, undefined, [serve([everyOnly])]);
  const r = await row("Eve Park");
  expect(
    within(r).queryByRole("button", { name: "More for Eve Park" }),
  ).toBeNull();
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for Eve Park" }),
  );
  const roles = (await screen.findAllByRole("option")).map(
    (o) => o.textContent,
  );
  expect(roles.some((t) => t?.startsWith("Viewer"))).toBe(false);
});

it("a manual role on top of an Every space group: Remove takes the manual part, and says what stays", async () => {
  mountWith([
    serve([
      person({
        userId: "e2",
        user: { id: "e2", name: "Kai Moss", email: "kai@example.com" },
        role: "manager",
        manualRole: "manager",
        syncRole: "viewer",
        groups: [{ ...exec, role: "viewer", via: "every" }],
      }),
    ]),
  ]);
  const menu = await openMenu("Kai Moss");
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: /Remove manually added role/ }),
  );
  const d = await screen.findByRole("alertdialog");
  expect(d).toHaveTextContent(
    "Kai goes from Manager to Viewer. They keep Viewer from an Every space group.",
  );
  expect(screen.queryByText(/Change it in Google/)).toBeNull();
});

it("409 managed_by_org_mapping shows the Every space line by the row", async () => {
  mountWith([
    serve([everyOnly]),
    http.put(`*/api/v1/spaces/${ID}/members/e1`, () =>
      HttpResponse.json(
        {
          error: {
            code: "managed_by_org_mapping",
            message: "server text",
            details: { userId: "e1" },
          },
        },
        { status: 409 },
      ),
    ),
  ]);
  const r = await row("Eve Park");
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for Eve Park" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /^Manager/ }));
  expect(
    await within(r).findByText(
      "Set by an Every space group. Change it in Settings › Spaces › Every space.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("server text")).toBeNull();
});
