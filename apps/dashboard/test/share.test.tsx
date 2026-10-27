import { R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { installHarness, mount, seen, server, wait } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

const id = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const OWNED = id("Landing page");
const POLL = id("Team poll");
const VIEWER = id("Onboarding guide");
const EDITOR = id("Shared draft");
const panel = (aid: string, tab = "share") =>
  `${viewerPath(aid)}?panel=open&tab=${tab}`;
const writes = () => seen.filter((u) => u.pathname.includes("/artifacts/"));

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const patches = () => {
  const bodies: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "PATCH") bodies.push(await request.clone().json());
  });
  return bodies;
};

describe("share panel", () => {
  it("going public asks first; cancelling keeps the visibility and sends no PATCH", async () => {
    const bodies = patches();
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    await screen.findByText(
      "Anyone with the link can view. It won't appear in search engines.",
      { selector: '[role="dialog"] *' },
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([]);
    expect(
      within(group).getByRole("radio", { name: "Private" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("an invalid or non-ASCII email never calls the API", async () => {
    mount(panel(OWNED));
    const input = await screen.findByRole("textbox", { name: "Email" });
    for (const bad of ["nope", "josé@example.com", "a@exämple.com"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await screen.findByRole("alert");
    }
    const puts = seen.filter((u) => u.pathname === R.shares(OWNED));
    // Only the initial GET of the list.
    expect(puts).toHaveLength(1);
  });

  it("invites a trimmed, lowercased email", async () => {
    mount(panel(OWNED));
    const input = await screen.findByRole("textbox", { name: "Email" });
    fireEvent.change(input, { target: { value: "  Eve@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("eve@example.com");
  });

  it("after adding, shows the artifact link to send, with no email promise", async () => {
    mount(panel(OWNED));
    expect(
      await screen.findByText(
        "No email is sent. Copy the link and share it yourself.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
      target: { value: "eve@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByText("Shared with eve@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Artifact link" })).toHaveValue(
      location.origin + viewerPath(OWNED),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByText("Shared with eve@example.com")).toBeNull(),
    );
  });

  it("a share row renders its email with a title", async () => {
    mount(panel(OWNED));
    expect(await screen.findByTitle("bob@example.com")).toHaveTextContent(
      "bob@example.com",
    );
  });

  it("changes a share role and removes it", async () => {
    mount(panel(OWNED));
    const trigger = await screen.findByRole("combobox", {
      name: "Role for bob@example.com",
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Editor" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Role for bob@example.com" }),
      ).toHaveTextContent("Editor"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove bob@example.com" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("bob@example.com")).toBeNull(),
    );
  });

  it("who can change the live data: shown only with db, and says who", async () => {
    mount(panel(OWNED));
    await screen.findByRole("checkbox", { name: "Database" });
    expect(
      screen.queryByRole("radiogroup", {
        name: "Who can change the live data",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Database" }),
    ).toHaveAccessibleDescription(/./);
  });

  it("choosing Only editors sends dataWriters, never allowAnonymousWrites", async () => {
    const bodies = patches();
    mount(panel(POLL));
    const group = await screen.findByRole("radiogroup", {
      name: "Who can change the live data",
    });
    const everyone = within(group).getByRole("radio", {
      name: "Everyone who can see it",
    });
    await waitFor(() => expect(everyone).toBeChecked());
    expect(group).toHaveAccessibleDescription(
      "Anyone with the link, signed in or not.",
    );
    fireEvent.click(within(group).getByRole("radio", { name: "Only editors" }));
    await waitFor(() => expect(bodies).toEqual([{ dataWriters: "editors" }]));
    await waitFor(() =>
      expect(group).toHaveAccessibleDescription(
        "Only you and people who can edit it.",
      ),
    );
  });

  it("turning db off leaves dataWriters as set", async () => {
    const bodies = patches();
    mount(panel(POLL));
    await screen.findByRole("radiogroup", {
      name: "Who can change the live data",
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Database" }));
    await waitFor(() =>
      expect(bodies).toEqual([{ capabilities: { db: false } }]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("radiogroup", {
          name: "Who can change the live data",
        }),
      ).toBeNull(),
    );
  });

  it("a failed save toasts and leaves the UI as the server has it", async () => {
    server.use(
      http.patch("*/api/v1/artifacts/:id", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Boom" } },
          { status: 500 },
        ),
      ),
    );
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    await screen.findByText("Boom");
    expect(
      within(group).getByRole("radio", { name: "Private" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it.each([
    ["editor", EDITOR],
    ["viewer", VIEWER],
  ])("%s sees no editing controls but can copy the link", async (_, aid) => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mount(panel(aid));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(screen.queryByRole("radiogroup", { name: "Visibility" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${location.origin}${viewerPath(aid)}`,
      ),
    );
  });
});

const CONFLICT_COPY = "This artifact just changed. Check it and try again.";
const conflictPatch = http.patch("*/api/v1/artifacts/:id", () =>
  HttpResponse.json(
    { error: { code: "conflict", message: "server text" } },
    { status: 409 },
  ),
);

describe("409 conflict", () => {
  it("details: the edits stay, a status says so, Save is the retry, and the artifact reloads", async () => {
    server.use(conflictPatch);
    const gets = () =>
      seen.filter((u) => u.pathname === R.artifact(EDITOR) && u.search === "")
        .length;
    mount(panel(EDITOR, "details"));
    const title = await screen.findByRole("textbox", { name: "Title" });
    const before = gets();
    fireEvent.change(title, { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const note = await screen.findByText(CONFLICT_COPY);
    expect(note).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("server text")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Mine");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    // The next edit clears it.
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Mine again" },
    });
    expect(screen.queryByText(CONFLICT_COPY)).toBeNull();
  });

  it("visibility: the choice reverts to the server's value, with the status under it", async () => {
    server.use(conflictPatch);
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    const note = await screen.findByText(CONFLICT_COPY);
    expect(note).toHaveAttribute("role", "status");
    await waitFor(() =>
      expect(
        within(group).getByRole("radio", { name: "Private" }),
      ).toBeChecked(),
    );
    expect(
      screen.queryByRole("button", { name: "Save visibility" }),
    ).toBeNull();
    // Choosing again clears it.
    fireEvent.click(within(group).getByRole("radio", { name: "Team" }));
    expect(screen.queryByText(CONFLICT_COPY)).toBeNull();
  });
});

describe("details panel", () => {
  it("editors edit the title and description", async () => {
    const bodies = patches();
    mount(panel(EDITOR, "details"));
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "  New name " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "About" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(bodies).toEqual([{ title: "New name", description: "About" }]),
    );
  });

  it("viewers see read-only info with file sizes and no Delete", async () => {
    mount(panel(VIEWER, "details"));
    await screen.findByText("1.0 KB");
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete artifact" }),
    ).toBeNull();
  });

  it("delete confirms, navigates home, and Undo restores and returns to the viewer", async () => {
    const router = mount(panel(OWNED, "details"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete artifact" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
    expect(writes().some((u) => u.pathname === R.restoreDeleted(OWNED))).toBe(
      true,
    );
  });
});

describe("share panel review fixes", () => {
  it("arrowing Private to Public with the keyboard and cancelling sends no PATCH", async () => {
    const bodies = patches();
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    const priv = within(group).getByRole("radio", { name: "Private" });
    priv.focus();
    fireEvent.keyDown(priv, { key: "ArrowRight" });
    fireEvent.keyDown(within(group).getByRole("radio", { name: "Team" }), {
      key: "ArrowRight",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await wait(50);
    expect(bodies).toEqual([]);
    expect(
      within(group).getByRole("radio", { name: "Private" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("confirming Make public sends only the visibility", async () => {
    const bodies = patches();
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make public" }));
    await waitFor(() => expect(bodies).toEqual([{ visibility: "public" }]));
  });

  // #418: making an artifact public must not turn anonymous writes off.
  it("making a private artifact with anonymous writes public keeps them on", async () => {
    const owned = fixtures.artifacts.find((a) => a.id === OWNED);
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({ ...owned, dataWriters: "viewers" }),
      ),
    );
    const bodies = patches();
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make public" }));
    await waitFor(() => expect(bodies).toEqual([{ visibility: "public" }]));
  });

  it("leaving public sends only the visibility (#681)", async () => {
    const bodies = patches();
    mount(panel(POLL));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    await waitFor(() => expect(bodies).toEqual([{ visibility: "team" }]));
  });

  it("a denied or missing clipboard toasts Couldn't copy with the link", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    mount(panel(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await screen.findByText("Couldn't copy");
    await screen.findByText(`${location.origin}${viewerPath(OWNED)}`);
  });

  it("shows the owner by display name", async () => {
    mount(panel(EDITOR));
    await screen.findByText("Bob Builder");
  });

  it("someone who can't share sees the owner and why, and never asks for the list", async () => {
    mount(panel(EDITOR));
    await screen.findByText("Bob Builder");
    expect(
      screen.getByText(
        "Only people who can share this artifact see who else has access.",
      ),
    ).toBeVisible();
    await wait(50);
    expect(seen.some((u) => u.pathname === R.shares(EDITOR))).toBe(false);
  });

  it("someone who can share sees no such note", async () => {
    mount(panel(OWNED));
    await screen.findByRole("heading", { name: "People" });
    expect(screen.queryByText(/see who else has access/)).toBeNull();
  });
});

describe("details review fixes", () => {
  it("saving the description after an inline rename keeps the new title", async () => {
    const bodies = patches();
    mount(panel(OWNED, "details"));
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.click(screen.getByTitle("Rename"));
    const inline = await waitFor(
      () => document.querySelector("input.oa-vt-input") as HTMLInputElement,
    );
    fireEvent.change(inline, { target: { value: "Renamed" } });
    fireEvent.keyDown(inline, { key: "Enter" });
    await waitFor(() => expect(bodies).toEqual([{ title: "Renamed" }]));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
        "Renamed",
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "About" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ description: "About" });
  });

  it("a failed save toasts the error and restores the fields", async () => {
    server.use(
      http.patch("*/api/v1/artifacts/:id", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Nope" } },
          { status: 500 },
        ),
      ),
    );
    mount(panel(EDITOR, "details"));
    const title = await screen.findByRole("textbox", { name: "Title" });
    const before = (title as HTMLInputElement).value;
    fireEvent.change(title, { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Nope");
    expect(title).toHaveValue(before);
  });
});

describe("undo toast", () => {
  const del = async () => {
    const router = mount(panel(OWNED, "details"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete artifact" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    return router;
  };

  it("offers Undo, which restores and navigates back", async () => {
    const router = await del();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/a\//),
    );
  });

  it("toasts the error when undo fails", async () => {
    server.use(
      http.post("*/api/v1/artifacts/:id/undelete", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Too late" } },
          { status: 500 },
        ),
      ),
    );
    await del();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Too late");
  });
});

describe("one request per action (useSingleFlight)", () => {
  const count = (method: string) => {
    const hits: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === method) hits.push(request.url);
    });
    return hits;
  };

  it("two Save visibility clicks in one tick send one PATCH", async () => {
    const bodies = patches();
    mount(panel(OWNED));
    const group = await screen.findByRole("radiogroup", { name: "Visibility" });
    fireEvent.click(within(group).getByRole("radio", { name: "Team" }));
    const save = screen.getByRole("button", { name: "Save visibility" });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save visibility" }),
      ).toBeNull(),
    );
    expect(bodies).toEqual([{ visibility: "team" }]);
  });

  it("two invite submits in one tick send one PUT", async () => {
    const puts = count("PUT");
    mount(panel(OWNED));
    const email = await screen.findByRole("textbox", { name: "Email" });
    fireEvent.change(email, { target: { value: "eve@example.com" } });
    const form = email.closest("form") as HTMLFormElement;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await screen.findByText("Shared with eve@example.com");
    expect(puts).toHaveLength(1);
  });

  it("two Remove clicks in one tick send one DELETE", async () => {
    const dels = count("DELETE");
    mount(panel(OWNED));
    const remove = await screen.findByRole("button", {
      name: /^Remove .+@/,
    });
    act(() => {
      fireEvent.click(remove);
      fireEvent.click(remove);
    });
    await waitFor(() => expect(dels).toHaveLength(1));
    await waitFor(() => expect(remove).not.toBeInTheDocument());
    expect(dels).toHaveLength(1);
  });
});
