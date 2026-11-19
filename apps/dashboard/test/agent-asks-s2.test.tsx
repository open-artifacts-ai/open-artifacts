// #2577 slice 2: Add a teammate, "Who asked what", and the share tick box.
import { R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { whenText } from "../src/settings/AskHistory";
import { calls, events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const LANDING = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as {
    id: string;
  }
).id;
const asks = (...first: Parameters<typeof server.use>) =>
  server.use(...first, ...createHandlers({ events, agentAsks: true }));

const pickOption = async (label: string, option: string | RegExp) => {
  fireEvent.keyDown(await screen.findByRole("combobox", { name: label }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

describe("Settings: Add a teammate", () => {
  const openDialog = async () => {
    asks();
    mount("/settings/connections");
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Add a teammate" },
        { timeout: FIRST_LOAD_MS },
      ),
    );
    return screen.findByRole("dialog", { name: "Add a teammate" });
  };

  it("shows the design's lines, with no passkey line", async () => {
    const d = await openDialog();
    expect(d).toHaveTextContent(
      "Their requests reach your agents without asking you first.",
    );
    expect(d).toHaveTextContent("Until");
    expect(d).toHaveTextContent("30 days");
    expect(d).toHaveTextContent("1 year");
    expect(d).toHaveTextContent(
      "Your agents are told to bring merging, deploying, deleting, sharing and making a page public back to you",
    );
    expect(d).not.toHaveTextContent(/passkey/i);
    expect(within(d).getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("members only: the picker lists teammates, not yourself or guests", async () => {
    await openDialog();
    fireEvent.keyDown(
      await screen.findByRole("combobox", { name: "Teammate" }),
      {
        key: "Enter",
      },
    );
    const opts = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(opts).toEqual(["Bob Builder"]);
  });

  it("adds one teammate on all pages and sends the add with via settings", async () => {
    const posts = calls("POST");
    const d = await openDialog();
    await pickOption("Teammate", "Bob Builder");
    await pickOption("Where", "All pages my agents work on");
    fireEvent.click(within(d).getByLabelText(/^90 days/));
    fireEvent.click(within(d).getByRole("button", { name: "Add Bob" }));
    await waitFor(() =>
      expect(posts.some((c) => c.path === R.agentListens)).toBe(true),
    );
    const b = posts.find((c) => c.path === R.agentListens)?.body as Record<
      string,
      unknown
    >;
    expect(b).toEqual({
      memberId: fixtures.members.find((m) => m.name === "Bob Builder")?.id,
      scope: "all",
      until: 90,
      via: "settings",
    });
    expect(b.assertion).toBeUndefined();
    expect(
      await screen.findByText(/Added Bob Builder\. Their requests reach/),
    ).toBeInTheDocument();
  });

  it("a refusal shows the server's plain message and keeps the dialog", async () => {
    asks(
      http.post(`*${R.agentListens}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "bad_request",
              message: "That person cannot edit this page",
            },
          },
          { status: 400 },
        ),
      ),
    );
    mount("/settings/connections");
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Add a teammate" },
        { timeout: FIRST_LOAD_MS },
      ),
    );
    const d = await screen.findByRole("dialog", { name: "Add a teammate" });
    await pickOption("Teammate", "Bob Builder");
    await pickOption("Where", "All pages my agents work on");
    fireEvent.click(within(d).getByRole("button", { name: "Add Bob" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(
      "That person cannot edit this page",
    );
  });

  it("Add again on an ended row opens the dialog prefilled", async () => {
    const posts = calls("POST");
    asks(
      http.get(`*${R.agentListens}`, () =>
        HttpResponse.json({
          entries: [
            {
              id: "l_ana",
              member: { id: "u_ana", name: "Ana Ruiz" },
              scope: "all",
              artifact: null,
              space: null,
              until: Date.now() - 86_400_000,
              createdAt: Date.now() - 9 * 86_400_000,
            },
          ],
        }),
      ),
    );
    mount("/settings/connections");
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Add Ana Ruiz again" },
        { timeout: FIRST_LOAD_MS },
      ),
    );
    const d = await screen.findByRole("dialog", { name: "Add a teammate" });
    expect(d).toHaveTextContent("All pages my agents work on");
    expect(
      within(d).getByRole("combobox", { name: "Teammate" }),
    ).toBeDisabled();
    expect(within(d).getByRole("button", { name: "Add Ana" })).toBeEnabled();
    expect(posts.some((c) => c.path === R.agentListens)).toBe(false);
  });
});

describe("Settings: Who asked what", () => {
  it("lists the last 30 days, outcome in words, never the words asked", async () => {
    asks();
    mount("/settings/connections");
    const h = await screen.findByRole(
      "heading",
      { name: "Who asked what" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(h).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelectorAll("[data-history-row]")).toHaveLength(2),
    );
    const rows = [...document.querySelectorAll("[data-history-row]")].map(
      (r) => r.textContent,
    );
    expect(rows[0]).toContain("Web, asked by Maya Chen");
    expect(rows[0]).toContain('on "Launch status" · yesterday · on your list');
    expect(rows[1]).toContain("Web, asked by Dev Patel");
    expect(rows[1]).toContain("today · you allowed once");
  });

  it("says today, yesterday, then a date", () => {
    const now = new Date("2026-11-19T12:00:00").getTime();
    expect(whenText(now - 1000, now)).toBe("today");
    expect(whenText(now - 86_400_000, now)).toBe("yesterday");
    expect(whenText(now - 5 * 86_400_000, now)).toBe("14 Nov");
  });

  it("an empty history says so", async () => {
    asks(
      http.get(`*${R.agentAskHistory}`, () => HttpResponse.json({ rows: [] })),
    );
    mount("/settings/connections");
    expect(
      await screen.findByText(
        "No requests to your agents in the last 30 days.",
        undefined,
        { timeout: FIRST_LOAD_MS },
      ),
    ).toBeInTheDocument();
  });
});

describe("Share: the tick box", () => {
  const panel = (aid: string) => `${viewerPath(aid)}?panel=open&tab=share`;
  const typeBob = async (role: "Editor" | "Viewer") => {
    await pickOption("Invite role", role);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "bob@example.com" },
    });
  };

  it("is unticked, then ticked shows the end date; sharing posts the add with via share_tick", async () => {
    const posts = calls("POST");
    asks();
    mount(panel(LANDING));
    await screen.findByRole("combobox", { name: "Invite role" });
    await typeBob("Editor");
    const box = await screen.findByRole("checkbox", {
      name: "Bob Builder can ask my agents about this page",
    });
    expect(box).not.toBeChecked();
    expect(
      screen.getByText(
        /Without asking me each time, for 30 days\. They treat Bob's words/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(box);
    expect(
      screen.getByText(
        /Until .*\. Change or remove it in Settings, Connections\./,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(posts.some((c) => c.path === R.agentListens)).toBe(true),
    );
    expect(posts.find((c) => c.path === R.agentListens)?.body).toEqual({
      memberId: fixtures.members.find((m) => m.name === "Bob Builder")?.id,
      scope: "page",
      artifactId: LANDING,
      until: 30,
      via: "share_tick",
    });
  });

  it("unticked: sharing adds nothing to the list", async () => {
    const posts = calls("POST");
    const puts = calls("PUT");
    asks();
    mount(panel(LANDING));
    await screen.findByRole("combobox", { name: "Invite role" });
    await typeBob("Editor");
    await screen.findByRole("checkbox", { name: /can ask my agents/ });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(puts.some((c) => c.path.includes("/shares"))).toBe(true),
    );
    expect(posts.some((c) => c.path === R.agentListens)).toBe(false);
  });

  it("is not offered to a viewer", async () => {
    asks();
    mount(panel(LANDING));
    await screen.findByRole("combobox", { name: "Invite role" });
    await typeBob("Viewer");
    expect(
      screen.queryByRole("checkbox", { name: /can ask my agents/ }),
    ).toBeNull();
  });

  it("is not offered to an outsider", async () => {
    asks();
    mount(panel(LANDING));
    await screen.findByRole("combobox", { name: "Invite role" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "kim@partner.org" },
    });
    expect(
      screen.queryByRole("checkbox", { name: /can ask my agents/ }),
    ).toBeNull();
  });
});
