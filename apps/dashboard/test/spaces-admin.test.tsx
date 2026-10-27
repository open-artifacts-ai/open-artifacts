// Hosted P4 Task 10: /settings/spaces, Design D5 as drawn (build spec
// t6cjQuskQ6zrZaJd v5), with the Every space card and the "Space managers can
// map groups" switch (Backend #422).
import type { Me } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

const ENG = "SpEngNpQrSt2uVwX";
const CLIENTS = "SpCliNpQrSt4uVwX";

/** A member who manages Engineering only (the UI's view; the mock still answers as Ada). */
const asManager = (m: Me): Me => ({
  ...m,
  user: { ...m.user, role: "member" },
  spaces: (m.spaces ?? []).filter((s) => s.myRole === "manager"),
});

const chooseOption = async (label: string, option: string) => {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("?space=<personal id> is refused: the detail never opens and the param clears", async () => {
  const seen = calls("GET");
  const router = mountHosted("/settings/spaces?space=Ab3dEfGhJk4mNpQr");
  await screen.findByRole("list", { name: "Spaces" });
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(
    screen.queryByRole("heading", { level: 2, name: "Ada Lovelace" }),
  ).toBeNull();
  expect(seen.some((c) => c.path === "/api/v1/spaces/Ab3dEfGhJk4mNpQr")).toBe(
    false,
  );
});

it("guests are redirected to /shared", async () => {
  const router = mountHosted("/settings/spaces", true, (m) => ({
    ...m,
    user: { ...m.user, role: "guest" },
  }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/shared"));
});

it("members who manage no space are redirected", async () => {
  const router = mountHosted("/settings/spaces", true, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
    spaces: [],
  }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/agents"),
  );
});

it("without the spaces feature the route redirects", async () => {
  const router = mount("/settings/spaces");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/agents"),
  );
});

it("an admin sees every shared space by name, never personal ones", async () => {
  mountHosted("/settings/spaces");
  const list = await screen.findByRole("list", { name: "Spaces" });
  await waitFor(() =>
    expect(
      within(list)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Clients", "Engineering", "Exec"]),
  );
  expect(
    screen.getByText("3 shared spaces. Personal spaces aren't listed."),
  ).toBeVisible();
  const clients = within(list).getByRole("link", { name: /Clients/ });
  expect(clients).toHaveAttribute("href", `/settings/spaces?space=${CLIENTS}`);
  expect(clients).toHaveTextContent("No role for you");
  const exec = within(list).getByRole("link", { name: /Exec/ });
  expect(exec).toHaveTextContent("Public links off");
  // A muted status chip with an icon, not the role badge's outline.
  const chip = within(exec)
    .getByText("Public links off")
    .closest("[data-status]");
  expect(chip).toHaveAttribute("data-status", "muted");
  expect(chip?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  expect(chip?.getAttribute("data-slot")).not.toBe("badge");
});

it("the Spaces tab shows for admins on a hosted instance", async () => {
  mountHosted("/settings/profile");
  expect(await screen.findByRole("link", { name: "Spaces" })).toHaveAttribute(
    "href",
    "/settings/spaces",
  );
});

it("the Spaces tab shows for a member who manages a space", async () => {
  mountHosted("/settings/profile", true, asManager);
  expect(await screen.findByRole("link", { name: "Spaces" })).toBeVisible();
});

it("a manager who isn't an admin sees only their spaces, no Every space and no New space", async () => {
  mountHosted("/settings/spaces", true, asManager);
  const list = await screen.findByRole("list", { name: "Spaces" });
  await waitFor(() =>
    expect(
      within(list)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Engineering"]),
  );
  expect(screen.queryByRole("region", { name: "Every space" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New space" })).toBeNull();
  expect(
    screen.queryByRole("switch", { name: "Space managers can map groups" }),
  ).toBeNull();
});

it("create trims the name and sends the defaults", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  expect(d).toHaveTextContent(
    "Everyone at Acme Artifacts gets this role. Leave None to give access through groups or by adding people manually.",
  );
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "  Design  " },
  });
  fireEvent.click(within(d).getByRole("button", { name: "Create space" }));
  await waitFor(() =>
    expect(seen.find((c) => c.path === "/api/v1/spaces")?.body).toEqual({
      name: "Design",
      allMembersRole: null,
      publicLinks: true,
    }),
  );
});

it("a fresh New space form shows no error until the field is left or a submit is tried", async () => {
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  expect(within(d).queryByRole("alert")).toBeNull();
  expect(within(d).getByRole("textbox", { name: "Name" })).not.toHaveAttribute(
    "aria-invalid",
  );
});

it("create refuses an empty name before sending", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "   " },
  });
  fireEvent.click(within(d).getByRole("button", { name: "Create space" }));
  expect(await within(d).findByText("Enter a space name.")).toBeVisible();
  expect(seen.some((c) => c.path === "/api/v1/spaces")).toBe(false);
});

const CTRL = "\u202e\u0007";

it("create sends the cleaned name: controls and bidi stripped, trimmed", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: `${CTRL} Design${CTRL} ` },
  });
  fireEvent.click(within(d).getByRole("button", { name: "Create space" }));
  await waitFor(() =>
    expect(seen.find((c) => c.path === "/api/v1/spaces")?.body).toEqual(
      expect.objectContaining({ name: "Design" }),
    ),
  );
});

it("a name that is only controls is empty: the error shows before submit and nothing is sent", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  const field = within(d).getByRole("textbox", { name: "Name" });
  expect(within(d).queryByText("Enter a space name.")).toBeNull();
  expect(field).not.toHaveAttribute("aria-invalid");
  fireEvent.change(field, { target: { value: CTRL } });
  // Typing alone says nothing: the error waits for blur or a submit.
  expect(within(d).queryByText("Enter a space name.")).toBeNull();
  fireEvent.blur(field);
  const msg = await within(d).findByText("Enter a space name.");
  expect(msg).toBeVisible();
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field.getAttribute("aria-describedby")).toBe(msg.id);
  expect(d.textContent).not.toMatch(/control|character was|removed/i);
  fireEvent.click(within(d).getByRole("button", { name: "Create space" }));
  expect(seen.some((c) => c.path === "/api/v1/spaces")).toBe(false);
});

it("81 characters says to use 80 or fewer; 80 is fine", async () => {
  const seen = calls("POST");
  mountHosted("/settings/spaces");
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  const field = within(d).getByRole("textbox", { name: "Name" });
  fireEvent.change(field, { target: { value: "x".repeat(81) } });
  fireEvent.blur(field);
  expect(
    await within(d).findByText("Use 80 characters or fewer."),
  ).toBeVisible();
  fireEvent.click(within(d).getByRole("button", { name: "Create space" }));
  expect(seen.some((c) => c.path === "/api/v1/spaces")).toBe(false);
  fireEvent.change(field, { target: { value: "x".repeat(80) } });
  await waitFor(() =>
    expect(within(d).queryByText("Use 80 characters or fewer.")).toBeNull(),
  );
});

it("a server 400 on create shows the same error under the field, with no toast", async () => {
  mountHosted("/settings/spaces", true, undefined, [
    http.post("*/api/v1/spaces", () =>
      HttpResponse.json(
        { error: { code: "bad_request", message: "server text" } },
        { status: 400 },
      ),
    ),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New space" }));
  const d = screen.getByRole("dialog", { name: "New space" });
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "Design" },
  });
  fireEvent.click(within(d).getByRole("button", { name: "Create space" }));
  expect(await within(d).findByText("Enter a space name.")).toBeVisible();
  expect(screen.queryByText("server text")).toBeNull();
  expect(screen.queryByText("Couldn't create the space.")).toBeNull();
});

it("rename shows the error before submit, disables Save, and shows the cleaned saved name", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`);
  const field = await screen.findByRole("textbox", { name: "Name" });
  fireEvent.change(field, { target: { value: "" } });
  expect(screen.queryByText("Enter a space name.")).toBeNull();
  fireEvent.blur(field);
  const msg = await screen.findByText("Enter a space name.");
  expect(msg).toBeVisible();
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field.getAttribute("aria-describedby")).toBe(msg.id);
  expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  fireEvent.change(field, { target: { value: `${CTRL}  Platform ${CTRL}` } });
  expect(screen.queryByText("Enter a space name.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Platform",
    ),
  );
});

it("a server 400 on rename shows the error under the field", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`, true, undefined, [
    http.patch(`*/api/v1/spaces/${ENG}`, () =>
      HttpResponse.json(
        { error: { code: "bad_request", message: "server text" } },
        { status: 400 },
      ),
    ),
  ]);
  const field = await screen.findByRole("textbox", { name: "Name" });
  fireEvent.change(field, { target: { value: "Platform" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(await screen.findByText("Enter a space name.")).toBeVisible();
  expect(screen.queryByText("server text")).toBeNull();
});

it("the detail has a back link, the name and your role", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`);
  expect(
    await screen.findByRole("heading", { level: 2, name: "Engineering" }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "All spaces" })).toHaveAttribute(
    "href",
    "/settings/spaces",
  );
  expect(screen.getByText("You're a manager")).toBeVisible();
});

it("All members: None PATCHes allMembersRole null", async () => {
  const seen = calls("PATCH");
  mountHosted(`/settings/spaces?space=${ENG}`);
  await chooseOption("Role for All members", "None");
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ENG}`,
        body: { allMembersRole: null },
      }),
    ),
  );
});

it("renaming PATCHes the trimmed name", async () => {
  const seen = calls("PATCH");
  mountHosted(`/settings/spaces?space=${ENG}`);
  const name = await screen.findByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: " Platform " } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${ENG}`,
        body: { name: "Platform" },
      }),
    ),
  );
});

it("a space manager who isn't an admin can rename and toggle public links only", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`, true, asManager);
  expect(await screen.findByRole("textbox", { name: "Name" })).toBeEnabled();
  expect(screen.getByRole("switch", { name: "Public links" })).toBeEnabled();
  expect(
    screen.queryByRole("combobox", { name: "Role for All members" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete space" })).toBeNull();
});

it("turning public links off: Design's confirm, then PATCH", async () => {
  const seen = calls("PATCH");
  mountHosted(`/settings/spaces?space=${ENG}`);
  const sw = await screen.findByRole("switch", { name: "Public links" });
  expect(sw).toHaveAttribute("aria-checked", "true");
  fireEvent.click(sw);
  const d = screen.getByRole("alertdialog");
  expect(
    within(d).getByRole("heading", {
      name: "Turn off public links in Engineering?",
    }),
  ).toBeVisible();
  const lines = [...d.querySelectorAll("p")].map((p) => p.textContent);
  expect(lines).toEqual([
    "No one can make new public links in Engineering. Public links already here keep working.",
    "To stop an existing link, open the artifact and make it private.",
  ]);
  expect(d).not.toHaveTextContent("visible to the team only");
  fireEvent.click(
    within(d).getByRole("button", { name: "Turn off public links" }),
  );
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({ body: { publicLinks: false } }),
    ),
  );
});

it("turning public links on needs no confirm", async () => {
  const seen = calls("PATCH");
  mountHosted("/settings/spaces?space=SpExcNpQrSt3uVwX");
  fireEvent.click(await screen.findByRole("switch", { name: "Public links" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({ body: { publicLinks: true } }),
    ),
  );
});

it("a space with artifacts can't be deleted: the button is disabled, with the reason", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`);
  const del = await screen.findByRole("button", { name: "Delete space" });
  expect(del).toBeDisabled();
  expect(
    screen.getByText("Move or delete its 1 artifact first."),
  ).toBeVisible();
  expect(del).toHaveAttribute("aria-describedby");
  expect(
    document.getElementById(del.getAttribute("aria-describedby") as string),
  ).toHaveTextContent("Move or delete its 1 artifact first.");
});

it("the reason pluralizes", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`, true, undefined, [
    http.get("*/api/v1/spaces", () =>
      HttpResponse.json({
        items: [
          {
            id: ENG,
            kind: "shared",
            name: "Engineering",
            publicLinks: true,
            owner: null,
            allMembersRole: "viewer",
            myRole: "manager",
            memberCount: 2,
            artifactCount: 3,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    ),
  ]);
  expect(
    await screen.findByText("Move or delete its 3 artifacts first."),
  ).toBeVisible();
});

it("an empty space whose trash still holds artifacts: the 409 shows inline, once", async () => {
  mountHosted(`/settings/spaces?space=${CLIENTS}`, true, undefined, [
    http.delete(`*/api/v1/spaces/${CLIENTS}`, () =>
      HttpResponse.json(
        { error: { code: "space_not_empty", message: "server text" } },
        { status: 409 },
      ),
    ),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Delete space" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete space",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This space still has artifacts. Move or delete them first. Deleted artifacts count until they're permanently removed, 30 days after deletion.",
  );
  expect(
    screen.getAllByText(
      "This space still has artifacts. Move or delete them first. Deleted artifacts count until they're permanently removed, 30 days after deletion.",
    ),
  ).toHaveLength(1);
});

it("deleting an empty space returns to the list", async () => {
  const router = mountHosted(
    `/settings/spaces?space=${CLIENTS}`,
    true,
    undefined,
    [
      http.delete(
        `*/api/v1/spaces/${CLIENTS}`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete space" }));
  const d = screen.getByRole("alertdialog");
  expect(
    within(d).getByRole("heading", { name: "Delete Clients?" }),
  ).toBeVisible();
  expect(d).toHaveTextContent(
    "Clients is empty, so nothing else is deleted. This can't be undone.",
  );
  const confirm = within(d).getByRole("button", { name: "Delete space" });
  expect(confirm).toHaveAttribute("data-variant", "destructive");
  fireEvent.click(confirm);
  await waitFor(() => expect(router.state.location.search).toEqual({}));
});

it("an admin with no role in Clients can add themselves, which is recorded", async () => {
  const seen = calls("POST");
  mountHosted(`/settings/spaces?space=${CLIENTS}`);
  expect(
    await screen.findByText(
      "You can manage Clients' settings and groups, but you can't open its artifacts.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add me to this space" }));
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Add yourself to Clients?");
  expect(d).toHaveTextContent(
    "You'll be able to open its artifacts. Space managers are told, and it's recorded in the audit log.",
  );
  await chooseOption("Your role", "Viewer");
  fireEvent.click(within(d).getByRole("button", { name: "Add me" }));
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: `/api/v1/spaces/${CLIENTS}/members/self`,
        body: { role: "viewer" },
      }),
    ),
  );
});

it("the Access switch PATCHes spaceManagerMappings", async () => {
  const seen = calls("PATCH");
  mountHosted("/settings/spaces");
  const sw = await screen.findByRole("switch", {
    name: "Space managers can map groups",
  });
  await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
  expect(
    screen.getByText(
      "To spaces they manage, as Viewer or Editor. Every change is audited.",
    ),
  ).toBeVisible();
  fireEvent.click(sw);
  await waitFor(() =>
    expect(seen.at(-1)).toEqual(
      expect.objectContaining({
        path: "/api/v1/settings",
        body: { spaceManagerMappings: false },
      }),
    ),
  );
});

it("no copy contains an em dash", async () => {
  mountHosted(`/settings/spaces?space=${ENG}`);
  await screen.findByRole("heading", { level: 2, name: "Engineering" });
  expect(document.body.textContent).not.toContain("—");
});
