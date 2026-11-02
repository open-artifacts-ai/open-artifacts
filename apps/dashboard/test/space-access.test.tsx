// Hosted P4 Task 11: who gets access to a space (Design D5): "All members",
// per-space group mappings, read-only Every space rows, space-manager
// mappings (Viewer or Editor, Backend #422) and the Every space card.
import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { calls, installHarness, mountHosted } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const ID = "SpEngNpQrSt2uVwX";
const ENG = `/settings/spaces?space=${ID}`;

const asManager = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "member" },
  spaces: (m.spaces ?? []).filter((s) => s.myRole === "manager"),
});
/** Engineering as the server describes it to its manager while the switch is off. */
const engWithoutMapping = http.get("*/api/v1/spaces", () =>
  HttpResponse.json({
    items: [
      {
        id: ID,
        kind: "shared",
        name: "Engineering",
        publicLinks: true,
        owner: null,
        allMembersRole: "viewer",
        myRole: "manager",
        memberCount: 2,
        artifactCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        can: { manageMappings: false },
      },
    ],
    nextCursor: null,
  }),
);
const EXEC_EVERY = {
  groupId: "gExec02",
  email: "exec@example.com",
  name: "Exec",
  role: "viewer",
  memberCount: 5,
  lastSyncedAt: null,
};
const serveOrg = http.get("*/api/v1/directory/org-mappings", () =>
  HttpResponse.json({ items: [EXEC_EVERY], nextCursor: null }),
);

/** The first wait after a mount gets the page-load deadline. */
const firstLoad = { timeout: FIRST_LOAD_MS };
const groups = () => screen.findByRole("table", { name: "Groups" }, firstLoad);
/** A Groups row, under one page-load deadline for the table and its rows. */
const row = (re: RegExp) =>
  waitFor(
    () =>
      within(screen.getByRole("table", { name: "Groups" })).getByRole("row", {
        name: re,
      }),
    firstLoad,
  );
const chooseOption = async (label: string, option: string) => {
  fireEvent.click(
    await screen.findByRole("combobox", { name: label }, firstLoad),
  );
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("All members comes first, then Engineering's group mapping", async () => {
  mountHosted(ENG);
  await row(/eng@example.com/);
  const t = screen.getByRole("table", { name: "Groups" });
  const rows = within(t).getAllByRole("row");
  expect(rows[0]).toHaveTextContent("All members");
  expect(rows[0]).toHaveTextContent("Everyone at Acme Artifacts · built in");
  expect(rows[1]).toHaveTextContent("eng@example.com");
  expect(rows[1]).toHaveTextContent("Engineering");
  expect(
    screen.getByText(
      "Someone in more than one group gets the highest role. Changes apply within a minute and are recorded in the audit log.",
    ),
  ).toBeVisible();
});

it("an admin's role choices are exactly Viewer, Editor, Manager", async () => {
  mountHosted(ENG);
  fireEvent.click(
    within(await row(/eng@example.com/)).getByRole("combobox", {
      name: "Role for eng@example.com",
    }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Viewer", "Editor", "Manager"]);
});

it("adding a group PUTs viewer keyed by groupId; mapped groups are excluded from the picker", async () => {
  const seen = calls("PUT");
  mountHosted(ENG);
  await row(/eng@example.com/);
  fireEvent.change(screen.getByRole("combobox", { name: "Add a group" }), {
    target: { value: "e" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Add a group" }), {
    target: { value: "ex" },
  });
  expect(
    await screen.findByRole("option", { name: /exec@example.com/ }),
  ).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Add a group" }), {
    target: { value: "sa" },
  });
  fireEvent.click(
    await screen.findByRole("option", { name: /sales@example.com/ }),
  );
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ID}/mappings/gSales03`,
        body: { role: "viewer" },
      }),
    ),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Add a group" }), {
    target: { value: "en" },
  });
  await screen.findByRole("listbox");
  expect(screen.queryByRole("option", { name: /eng@example.com/ })).toBeNull();
});

it("changing a role PUTs it and shows it right away", async () => {
  const seen = calls("PUT");
  mountHosted(ENG);
  await chooseOption("Role for eng@example.com", "Viewer");
  expect(
    screen.getByRole("combobox", { name: "Role for eng@example.com" }),
  ).toHaveTextContent("Viewer");
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ID}/mappings/gEng01`,
        body: { role: "viewer" },
      }),
    ),
  );
});

it("Remove DELETEs the mapping", async () => {
  const seen = calls("DELETE");
  mountHosted(ENG);
  fireEvent.click(
    within(await row(/eng@example.com/)).getByRole("button", {
      name: "Remove eng@example.com",
    }),
  );
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(`/api/v1/spaces/${ID}/mappings/gEng01`),
  );
});

it("frozen: the mapping shows, but no control adds or changes one", async () => {
  mountHosted(ENG, { directory: "frozen" });
  const r = await row(/eng@example.com/);
  expect(r).toHaveTextContent("Editor");
  expect(screen.queryByRole("combobox", { name: "Add a group" })).toBeNull();
  expect(
    within(r).queryByRole("combobox", { name: "Role for eng@example.com" }),
  ).toBeNull();
  expect(
    within(r).queryByRole("button", { name: "Remove eng@example.com" }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Group sync is off, so mappings can't change. Edit people manually under People.",
    ),
  ).toBeVisible();
});

it("a 409 directory_sync_off shows the message once, with the link, and restores the role", async () => {
  mountHosted(ENG, true, undefined, [
    http.put("*/api/v1/spaces/:id/mappings/:g", () =>
      HttpResponse.json(
        { error: { code: "directory_sync_off", message: "server text" } },
        { status: 409 },
      ),
    ),
  ]);
  await chooseOption("Role for eng@example.com", "Manager");
  expect(
    await screen.findByText(
      "Directory sync is off, so this isn't available right now.",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open directory settings" }),
  ).toHaveAttribute("href", "/settings/directory");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Role for eng@example.com" }),
    ).toHaveTextContent("Editor"),
  );
  expect(
    screen.getAllByText(
      "Directory sync is off, so this isn't available right now.",
    ),
  ).toHaveLength(1);
});

// -- space managers (Backend #422)

it("a space manager maps groups as Viewer or Editor only, with the hint", async () => {
  mountHosted(ENG, true, asManager);
  const r = await row(/eng@example.com/);
  expect(screen.getByRole("combobox", { name: "Add a group" })).toBeVisible();
  expect(within(await groups()).queryByText("All members")).toBeNull();
  expect(
    screen.getByText(
      "You can give a group Viewer or Editor. Only an admin can make a group a manager. Changes are recorded in the audit log.",
    ),
  ).toBeVisible();
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for eng@example.com" }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Viewer", "Editor"]);
});

it("a manager row set by an admin is read-only for a space manager", async () => {
  mountHosted(ENG, true, asManager, [
    http.get(`*/api/v1/spaces/${ID}/mappings`, () =>
      HttpResponse.json([
        {
          groupId: "gEng01",
          email: "eng-leads@example.com",
          name: "Eng leads",
          role: "manager",
          memberCount: 6,
          lastSyncedAt: null,
        },
      ]),
    ),
  ]);
  const r = await row(/eng-leads@example.com/);
  expect(r).toHaveTextContent("Manager · set by an admin");
  expect(within(r).queryByRole("combobox")).toBeNull();
  expect(within(r).queryByRole("button", { name: /Remove/ })).toBeNull();
});

it("mapping off: a space manager can still remove viewer/editor rows; add and role changes are disabled", async () => {
  const del = calls("DELETE");
  const put = calls("PUT");
  mountHosted(ENG, true, asManager, [engWithoutMapping]);
  const r = await row(/eng@example.com/);
  expect(
    within(r).getByRole("combobox", { name: "Role for eng@example.com" }),
  ).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Add a group" })).toBeDisabled();
  expect(
    screen.getByText(
      "An admin has turned off group mapping by space managers. Ask an admin to add or change groups.",
    ),
  ).toBeVisible();
  const remove = within(r).getByRole("button", {
    name: "Remove eng@example.com",
  });
  expect(remove).toBeEnabled();
  fireEvent.click(remove);
  await waitFor(() =>
    expect(del.at(-1)?.path).toBe(`/api/v1/spaces/${ID}/mappings/gEng01`),
  );
  expect(put).toHaveLength(0);
});

it("Remove is a ghost button named after the group", async () => {
  mountHosted(ENG);
  const remove = within(await row(/eng@example.com/)).getByRole("button", {
    name: "Remove eng@example.com",
  });
  expect(remove).toHaveAttribute("data-variant", "ghost");
  expect(remove).toHaveTextContent("Remove");
});

it("space managers don't see Every space rows, only a line saying they exist", async () => {
  mountHosted(ENG, true, asManager, [serveOrg]);
  await row(/eng@example.com/);
  expect(
    within(await groups()).queryByRole("row", { name: /exec@example.com/ }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Groups an admin set for every space also get access here.",
    ),
  ).toBeVisible();
});

it("admins see Every space rows and not the managers' line", async () => {
  mountHosted(ENG, true, undefined, [serveOrg]);
  await row(/exec@example.com/);
  expect(
    screen.queryByText(
      "Groups an admin set for every space also get access here.",
    ),
  ).toBeNull();
});

it("a 403 directory_mapping_off (switch turned off in another tab) shows the reason and restores the role", async () => {
  mountHosted(ENG, true, asManager, [
    http.put("*/api/v1/spaces/:id/mappings/:g", () =>
      HttpResponse.json(
        { error: { code: "directory_mapping_off", message: "server text" } },
        { status: 403 },
      ),
    ),
  ]);
  await chooseOption("Role for eng@example.com", "Viewer");
  expect(
    await screen.findByText(
      "An admin has turned off group mapping by space managers. Ask an admin to add or change groups.",
    ),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Role for eng@example.com" }),
    ).toHaveTextContent("Editor"),
  );
  expect(screen.queryByText("server text")).toBeNull();
});

it("a 403 space_forbidden for a mapping (a race) says the group changed and reloads the groups", async () => {
  const seen = calls("GET");
  mountHosted(ENG, true, asManager, [
    http.put("*/api/v1/spaces/:id/mappings/:g", () =>
      HttpResponse.json(
        {
          error: {
            code: "space_forbidden",
            message: "server text",
            details: { target: "mapping" },
          },
        },
        { status: 403 },
      ),
    ),
  ]);
  await groups();
  const loads = () =>
    seen.filter((c) => c.path === `/api/v1/spaces/${ID}/mappings`).length;
  const before = loads();
  await chooseOption("Role for eng@example.com", "Viewer");
  const msg = await screen.findByText(
    "This group's access just changed. Check it and try again.",
  );
  expect(msg).toBeVisible();
  // A status, not an alert: it is information, not a failure to act on.
  expect(msg).toHaveAttribute("role", "status");
  // On the affected row, not in a line under the table.
  const eng = await row(/eng@example.com/);
  const note = eng.nextElementSibling;
  expect(note).toContainElement(msg);
  await waitFor(() => expect(loads()).toBeGreaterThan(before));
  expect(screen.queryByText("server text")).toBeNull();
  expect(document.body.textContent).not.toMatch(/mapping/i);
});

// -- Every space (org mappings)

it("the Every space card adds a group for every shared space", async () => {
  const seen = calls("PUT");
  mountHosted("/settings/spaces");
  const card = await screen.findByRole(
    "region",
    { name: "Every space" },
    firstLoad,
  );
  expect(card).toHaveTextContent(
    "Groups here get their role in every shared space, including ones created later. Never in anyone's Personal space.",
  );
  fireEvent.change(
    within(card).getByRole("combobox", { name: "Add a group to every space" }),
    { target: { value: "ex" } },
  );
  fireEvent.click(
    await screen.findByRole("option", { name: /exec@example.com/ }),
  );
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: "/api/v1/directory/org-mappings/gExec02",
        body: { role: "viewer" },
      }),
    ),
  );
  expect(
    await within(card).findByRole("row", { name: /exec@example.com/ }),
  ).toHaveTextContent("Exec · 1 person");
});

it("an Every space row changes role and removes", async () => {
  const put = calls("PUT");
  const del = calls("DELETE");
  mountHosted("/settings/spaces", true, undefined, [serveOrg]);
  const card = await screen.findByRole(
    "region",
    { name: "Every space" },
    firstLoad,
  );
  const r = await within(card).findByRole("row", { name: /exec@example.com/ });
  fireEvent.click(
    within(r).getByRole("combobox", { name: "Role for exec@example.com" }),
  );
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Viewer", "Editor", "Manager"]);
  fireEvent.click(screen.getByRole("option", { name: "Editor" }));
  await waitFor(() =>
    expect(put.at(-1)).toEqual(
      expect.objectContaining({
        path: "/api/v1/directory/org-mappings/gExec02",
        body: { role: "editor" },
      }),
    ),
  );
  fireEvent.click(
    within(r).getByRole("button", { name: "Remove exec@example.com" }),
  );
  await waitFor(() =>
    expect(del.at(-1)?.path).toBe("/api/v1/directory/org-mappings/gExec02"),
  );
});

it("Every space rows show read-only on a space, with where to change them", async () => {
  mountHosted(ENG, true, undefined, [serveOrg]);
  const r = await row(/exec@example.com/);
  expect(r).toHaveTextContent("via Every space · 5 people");
  expect(r).toHaveTextContent("Viewer");
  expect(within(r).queryByRole("combobox")).toBeNull();
  expect(
    within(r).getByRole("link", { name: "Change in Every space" }),
  ).toHaveAttribute("href", "/settings/spaces");
});

it("frozen: the Every space card is read-only", async () => {
  mountHosted("/settings/spaces", { directory: "frozen" }, undefined, [
    serveOrg,
  ]);
  const card = await screen.findByRole(
    "region",
    { name: "Every space" },
    firstLoad,
  );
  const r = await within(card).findByRole("row", { name: /exec@example.com/ });
  expect(within(r).queryByRole("combobox")).toBeNull();
  expect(within(card).queryByRole("combobox")).toBeNull();
});
