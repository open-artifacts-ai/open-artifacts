// Agent identity cards (Design ecAopo8RUyk2Xomu, contract #559): rows like
// Members with a face, title (label, then "<Name> <version>" tagged "reported
// by the agent"), where it runs and where it was approved, use and versions;
// "Add label" and a ••• menu (Rename label, View published versions, Revoke…).
import { type Me, type OAuthClient, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

const BASE = fixtures.oauthClients[0] as OAuthClient;
const serve = (clients: OAuthClient[]) =>
  http.get("*/api/v1/oauth-clients", () => HttpResponse.json(clients));
const SUBTITLE = "Agents you approved can publish as you.";
const rowOf = async (text: string) => {
  const card = await screen.findByRole("region", { name: "Connected agents" });
  const el = (await within(card).findByText(text)).closest("li");
  if (!el) throw new Error(`no row for ${text}`);
  return el as HTMLElement;
};
const openMenu = (r: HTMLElement) => {
  fireEvent.pointerDown(within(r).getByRole("button", { name: /^More for / }), {
    button: 0,
    pointerType: "mouse",
  });
  return screen.findByRole("menu");
};

describe("the card", () => {
  it("says what connecting means, under the title", async () => {
    mount("/settings/agents");
    const r = await rowOf("Example MCP client 1.2.0");
    const card = r.closest("section") as HTMLElement;
    const line = within(card).getByText(SUBTITLE);
    expect(line).toBeVisible();
    // Beside the heading, above the list.
    expect(line.previousElementSibling).toContainElement(
      within(card).getByRole("heading", { name: "Connected agents" }),
    );
    expect(line.compareDocumentPosition(r)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("underlines Add label", async () => {
    mount("/settings/agents");
    const r = await rowOf("Example MCP client 1.2.0");
    const add = within(r).getByRole("button", { name: "Add label" });
    expect(add).toHaveClass("underline", "underline-offset-3");
  });
});

describe("a row", () => {
  it("names the agent with its reported version, where it runs, approval, use", async () => {
    mount("/settings/agents");
    const r = await rowOf("Example MCP client 1.2.0");
    expect(within(r).getByText("reported by the agent")).toBeVisible();
    expect(r).toHaveTextContent("Runs on a computer");
    expect(r).toHaveTextContent(/Approved from Chrome on macOS, .+ ago/);
    expect(r).toHaveTextContent(/Last used .+ ago/);
    expect(r).toHaveTextContent("3 versions published");
    expect(within(r).getByRole("button", { name: "Add label" })).toBeVisible();
    expect(r.textContent).not.toMatch(/verified/i);
  });

  it("a hosted service names its host", async () => {
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(
      serve([
        { ...BASE, redirectKind: "hosted", redirectHost: "agents.example.net" },
      ]),
    );
    const r = await rowOf("agents.example.net");
    expect(r).toHaveTextContent("Hosted service at agents.example.net");
  });

  it("an old connection says so in one muted line; never used; no versions line", async () => {
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(
      serve([
        {
          grantId: BASE.grantId,
          clientName: "Old client",
          createdAt: "2026-01-02T10:00:00.000Z",
        },
      ]),
    );
    const r = await rowOf("Old client");
    expect(
      within(r).getByText(
        /^Connected Jan 2, before these details were recorded\.$/,
      ),
    ).toBeVisible();
    expect(r).toHaveTextContent("Never used");
    expect(r.textContent).not.toMatch(/versions? published/);
    expect(r.textContent).not.toMatch(/Runs on|Hosted service/);
  });

  it("with a label, the label is the title and the name and version follow, muted", async () => {
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(serve([{ ...BASE, label: "Work laptop" }]));
    const r = await rowOf("Work laptop");
    expect(within(r).getByText("Example MCP client 1.2.0")).toBeVisible();
    expect(within(r).queryByRole("button", { name: "Add label" })).toBeNull();
  });

  it("a 60-character label is shown in full to assistive tech and on hover", async () => {
    const long = "L".repeat(60);
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(serve([{ ...BASE, label: long }]));
    const t = within(await rowOf(long)).getByText(long);
    expect(t).toHaveAttribute("title", long);
  });
});

describe("labels", () => {
  it("Add label: type, Enter saves; the label shows", async () => {
    const patches = calls("PATCH");
    mount("/settings/agents");
    const r = await rowOf("Example MCP client 1.2.0");
    fireEvent.click(within(r).getByRole("button", { name: "Add label" }));
    const box = within(r).getByRole("textbox", { name: "Your label" });
    expect(r).toHaveTextContent("Only you see it. Up to 60 characters.");
    expect(
      within(r).getByText("Your label", { selector: "label" }),
    ).toBeVisible();
    expect(within(r).getByRole("button", { name: "Save" })).toBeVisible();
    expect(within(r).getByRole("button", { name: "Cancel" })).toBeVisible();
    fireEvent.change(box, { target: { value: "  Work laptop  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(
        patches.find((c) => c.path === R.oauthClient(BASE.grantId))?.body,
      ).toEqual({ label: "Work laptop" }),
    );
    expect(await rowOf("Work laptop")).toBeTruthy();
  });

  it("Escape cancels; empty clears; over 60 says so and sends nothing", async () => {
    const patches = calls("PATCH");
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(serve([{ ...BASE, label: "Work laptop" }]));
    let r = await rowOf("Work laptop");
    let menu = await openMenu(r);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Rename label" }),
    );
    let box = within(r).getByRole("textbox", { name: "Your label" });
    fireEvent.change(box, { target: { value: "x".repeat(61) } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(within(r).getByText("Use 60 characters or fewer.")).toBeVisible();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(r).queryByRole("textbox")).toBeNull();
    expect(patches).toEqual([]);
    r = await rowOf("Work laptop");
    menu = await openMenu(r);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Rename label" }),
    );
    box = within(r).getByRole("textbox", { name: "Your label" });
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(
        patches.find((c) => c.path === R.oauthClient(BASE.grantId))?.body,
      ).toEqual({ label: null }),
    );
  });

  it("a capped viewer can't label (no Add label or Rename), but can revoke", async () => {
    const capped = (m: Me): Me => ({
      ...m,
      auth: m.auth ? { ...m.auth, readOnly: true, cap: "restricted" } : m.auth,
    });
    mountHosted("/settings/agents", true, capped);
    const r = await rowOf("Example MCP client 1.2.0");
    expect(within(r).queryByRole("button", { name: "Add label" })).toBeNull();
    const menu = await openMenu(r);
    expect(
      within(menu).queryByRole("menuitem", { name: "Rename label" }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Revoke…" }),
    ).toBeVisible();
  });
});

describe("the face", () => {
  it("initials come from the agent's name, not the label", async () => {
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(
      serve([
        { ...BASE, clientName: "Claude Code", label: "Studio work laptop" },
      ]),
    );
    const r = await rowOf("Studio work laptop");
    expect(r.querySelector("[data-face]")).toHaveTextContent("CC");
  });
});

describe("labels, with the buttons", () => {
  it("edit state: Save and Cancel beside the field, the hint below, nothing else", async () => {
    const { server } = await import("./harness");
    server.use(serve([{ ...BASE, versionsPublished: 3 }]));
    mount("/settings/agents");
    const r = await rowOf("Example MCP client 1.2.0");
    const details = r.textContent;
    fireEvent.click(within(r).getByRole("button", { name: "Add label" }));

    const box = within(r).getByRole("textbox", { name: "Your label" });
    const line = within(r).getByTestId("label-edit");
    expect(line).toContainElement(box);
    // On a phone the field takes the line, so Save and Cancel stay together.
    expect(box).toHaveClass("max-[600px]:basis-full");
    expect(line).toContainElement(
      within(r).getByRole("button", { name: "Save" }),
    );
    expect(line).toContainElement(
      within(r).getByRole("button", { name: "Cancel" }),
    );
    const hint = within(r).getByText("Only you see it. Up to 60 characters.");
    expect(line).not.toContainElement(hint);
    expect(line.compareDocumentPosition(hint)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(box).toHaveAccessibleDescription(
      "Only you see it. Up to 60 characters.",
    );

    // The face, the field and its hint: no details, agent line or ••• menu.
    expect(r).toHaveTextContent(
      /^EMYour labelSaveCancelOnly you see it\. Up to 60 characters\.$/,
    );
    expect(within(r).queryByRole("button", { name: /^More for / })).toBeNull();

    // Cancel brings the row back as it was.
    fireEvent.click(within(r).getByRole("button", { name: "Cancel" }));
    expect(r.textContent).toBe(details);
    expect(within(r).getByRole("button", { name: /^More for / })).toBeVisible();
  });

  it("an error shows under the hint while the details stay hidden", async () => {
    mount("/settings/agents");
    const r = await rowOf("Example MCP client 1.2.0");
    fireEvent.click(within(r).getByRole("button", { name: "Add label" }));
    const box = within(r).getByRole("textbox", { name: "Your label" });
    fireEvent.change(box, { target: { value: "x".repeat(61) } });
    fireEvent.click(within(r).getByRole("button", { name: "Save" }));
    expect(within(r).getByRole("alert")).toHaveTextContent(
      "Use 60 characters or fewer.",
    );
    expect(within(r).queryByText("reported by the agent")).toBeNull();
    expect(within(r).queryByRole("button", { name: /^More for / })).toBeNull();
  });

  it("Rename label from the menu leaves the focus in the field", async () => {
    const { server } = await import("./harness");
    server.use(serve([{ ...BASE, label: "Work laptop" }]));
    mount("/settings/agents");
    const r = await rowOf("Work laptop");
    const menu = await openMenu(r);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Rename label" }),
    );
    const box = within(r).getByRole("textbox", { name: "Your label" });
    expect(box).toHaveValue("Work laptop");
    // Radix returns the focus on a later tick, and frees the page.
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(box).toHaveFocus();
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Save saves and Cancel cancels", async () => {
    const patches = calls("PATCH");
    mount("/settings/agents");
    let r = await rowOf("Example MCP client 1.2.0");
    fireEvent.click(within(r).getByRole("button", { name: "Add label" }));
    fireEvent.click(within(r).getByRole("button", { name: "Cancel" }));
    expect(within(r).queryByRole("textbox")).toBeNull();
    expect(patches).toEqual([]);
    r = await rowOf("Example MCP client 1.2.0");
    fireEvent.click(within(r).getByRole("button", { name: "Add label" }));
    fireEvent.change(within(r).getByRole("textbox", { name: "Your label" }), {
      target: { value: "Desk" },
    });
    fireEvent.click(within(r).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        patches.find((c) => c.path === R.oauthClient(BASE.grantId))?.body,
      ).toEqual({ label: "Desk" }),
    );
  });
});

describe("the menu and the empty state", () => {
  it("View published versions and Revoke… (the existing confirm)", async () => {
    mount("/settings/agents");
    const menu = await openMenu(await rowOf("Example MCP client 1.2.0"));
    // The server filters by agent name only (#589): the item says so.
    const view = within(menu).getByRole("menuitem", {
      name: "View versions from Example MCP client",
    });
    expect(view).toHaveAttribute(
      "href",
      `/?agent=${encodeURIComponent("Example MCP client")}`,
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Revoke…" }));
    expect(
      await screen.findByRole("alertdialog", {
        name: 'Revoke "Example MCP client"?',
      }),
    ).toBeVisible();
  });

  it("empty: Design's copy", async () => {
    mount("/settings/agents");
    const { server } = await import("./harness");
    server.use(serve([]));
    const card = await screen.findByRole("region", {
      name: "Connected agents",
    });
    expect(
      await within(card).findByText("No agents connected yet."),
    ).toBeVisible();
    expect(within(card).getByText(SUBTITLE)).toBeVisible();
    expect(card).toHaveTextContent(
      "Connect any AI agent with the MCP server above. It shows here once you approve it.",
    );
  });
});
