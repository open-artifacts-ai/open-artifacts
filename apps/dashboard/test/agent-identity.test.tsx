// Agent identity cards (Design ecAopo8RUyk2Xomu, contract #559): rows like
// Members with a face, title (label, then "<Name> <version>" tagged "reported
// by the agent"), where it runs and where it was approved, use and versions;
// "Add label" and a ••• menu (Rename label, View published versions, Revoke…).
import { type Me, type OAuthClient, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

const BASE = fixtures.oauthClients[0] as OAuthClient;
const serve = (clients: OAuthClient[]) =>
  http.get("*/api/v1/oauth-clients", () => HttpResponse.json(clients));
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
    // A visible field label, Save and Cancel, and the agent's line stays.
    expect(
      within(r).getByText("Your label", { selector: "label" }),
    ).toBeVisible();
    expect(within(r).getByRole("button", { name: "Save" })).toBeVisible();
    expect(within(r).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(within(r).getByText("Example MCP client 1.2.0")).toBeVisible();
    expect(within(r).getByText("reported by the agent")).toBeVisible();
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
    // #589: this connection only (agentVia), not every "Example MCP client".
    const view = within(menu).getByRole("menuitem", {
      name: "View versions from Example MCP client",
    });
    expect(view).toHaveAttribute(
      "href",
      `/?agentVia=${encodeURIComponent(`g:${BASE.grantId}`)}`,
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
    expect(card).toHaveTextContent(
      "Connect any AI agent with the MCP server above. It shows here once you approve it.",
    );
  });
});
