// #2577 slice 2: Add a teammate, "Who asked what", and the share tick box.
import { type Me, R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { teammatesHandlers } from "../src/mockTeammates";
import { whenText } from "../src/settings/AskHistory";
import {
  calls,
  events,
  installHarness,
  mount,
  mountHosted,
  server,
} from "./harness";
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
const asks = (...first: Parameters<typeof server.use>) => {
  const base = createHandlers({ events, agentAsks: true });
  server.use(...first, ...teammatesHandlers(base), ...base);
};

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
    expect(d).toHaveTextContent("30 days from now");
    for (const name of [/One page/, /One space/, /All pages my agents work on/])
      expect(within(d).getByRole("radio", { name })).toBeInTheDocument();
    // The choices open behind Change.
    expect(within(d).queryByLabelText(/^90 days/)).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Change" }));
    expect(within(d).getByLabelText(/^30 days/)).toBeInTheDocument();
    expect(within(d).getByLabelText(/^1 year/)).toBeInTheDocument();
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
    fireEvent.click(
      within(d).getByRole("radio", { name: /All pages my agents work on/ }),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Change" }));
    fireEvent.click(within(d).getByLabelText(/^90 days/));
    expect(d).toHaveTextContent("90 days from now");
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
    fireEvent.click(
      within(d).getByRole("radio", { name: /All pages my agents work on/ }),
    );
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
    expect(rows[0]).toContain("Web, asked by Maya");
    expect(rows[0]).toContain('on "Launch status" · yesterday · on your list');
    expect(rows[1]).toContain("Web, asked by Dev");
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
      name: "bob@example.com can ask my agents about this page",
    });
    expect(box).not.toBeChecked();
    expect(
      screen.getByText(
        /Without asking me each time, for 30 days\. They treat their words/,
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

  it("a share with no memberId (not a member yet) adds nothing and says so", async () => {
    const posts = calls("POST");
    asks(
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const body = (await request.json()) as { email: string; role: string };
        return HttpResponse.json({
          ...body,
          createdAt: new Date().toISOString(),
          emailed: false,
          memberId: null,
        });
      }),
    );
    mount(panel(LANDING));
    await screen.findByRole("combobox", { name: "Invite role" });
    await typeBob("Editor");
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /can ask my agents/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      await screen.findByText(
        /isn't a member yet, so they aren't on your agents' list/,
      ),
    ).toBeInTheDocument();
    expect(posts.some((c) => c.path === R.agentListens)).toBe(false);
  });

  it("an older server (no /me/teammates) shows no tick box", async () => {
    server.use(
      http.get("*/api/v1/me/teammates", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "x" } },
          { status: 404 },
        ),
      ),
      ...createHandlers({ events, agentAsks: true }),
    );
    mount(panel(LANDING));
    await screen.findByRole("combobox", { name: "Invite role" });
    await typeBob("Editor");
    await waitFor(() =>
      expect(screen.getByLabelText("Email")).toHaveValue("bob@example.com"),
    );
    expect(
      screen.queryByRole("checkbox", { name: /can ask my agents/ }),
    ).toBeNull();
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

describe("First setup: one question", () => {
  const PEOPLE = [
    { id: "u_maya", name: "Maya Chen", initials: "MC" },
    { id: "u_dev", name: "Dev Patel", initials: "DP" },
    { id: "u_ana", name: "Ana Ruiz", initials: "AR" },
  ];
  const member = (m: Me): Me => ({ ...m, user: { ...m.user, role: "member" } });
  const onboarding = (over: object = {}) =>
    http.get("*/api/v1/onboarding", () =>
      HttpResponse.json({
        dismissed: false,
        completed: false,
        firstArtifact: null,
        agentConnected: true,
        listensAsked: false,
        ...over,
      }),
    );
  const base = (over: object = {}, people = PEOPLE) => [
    onboarding(over),
    http.get("*/api/v1/me/teammates", () =>
      HttpResponse.json({ members: people }),
    ),
    http.post(
      "*/api/v1/me/onboarding/listens-asked",
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.post(`*${R.agentListens}`, () => HttpResponse.json({ entries: [] })),
    http.put(`*${R.agentRequests}`, () =>
      HttpResponse.json({ on: false, phonePush: false }),
    ),
  ];
  const card = () => document.querySelector("section[data-first-setup]");
  const mountIt = (over: object = {}, people = PEOPLE) =>
    mountHosted("/", true, member, base(over, people));

  it("asks once with the design's three answers, starting on Only people I choose", async () => {
    mountIt();
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    expect(c).toHaveTextContent(
      "Let teammates ask your agents about pages they work on?",
    );
    expect(c).toHaveTextContent("Your agents run on your computer.");
    expect(c).toHaveTextContent("The 3 members of");
    expect(c).toHaveTextContent(
      "for 90 days. Not people who join later, and never people outside your team.",
    );
    expect(
      within(c).getByRole("radio", { name: /Only people I choose/ }),
    ).toBeChecked();
    expect(c).not.toHaveTextContent(/passkey/i);
  });

  it.each([
    ["already asked", { listensAsked: true }],
    ["an old server (absent)", { listensAsked: undefined }],
    ["no agent connected yet", { agentConnected: false }],
  ])("is not shown: %s", async (_n, over) => {
    mountIt(over);
    await screen
      .findByRole("heading", { name: /Get started|Library/ })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    expect(card()).toBeNull();
  });

  it("is not shown on Solo (nobody to ask)", async () => {
    mountIt({}, []);
    await new Promise((r) => setTimeout(r, 400));
    expect(card()).toBeNull();
  });

  it("Skip for now and Only people I choose just mark it asked", async () => {
    const posts = calls("POST");
    mountIt();
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    fireEvent.click(within(c).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(posts.some((p) => p.path.endsWith("/listens-asked"))).toBe(true),
    );
    expect(posts.some((p) => p.path === R.agentListens)).toBe(false);
  });

  it("No turns the switch off and marks it asked", async () => {
    const puts = calls("PUT");
    const posts = calls("POST");
    mountIt();
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    fireEvent.click(within(c).getByRole("radio", { name: /^No/ }));
    fireEvent.click(within(c).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(puts.find((p) => p.path === R.agentRequests)?.body).toEqual({
        on: false,
      }),
    );
    await waitFor(() =>
      expect(posts.some((p) => p.path.endsWith("/listens-asked"))).toBe(true),
    );
  });

  it("Yes, my colleagues confirms by name, unticking leaves people out, and adds on all pages for 90 days", async () => {
    const posts = calls("POST");
    mountIt();
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    fireEvent.click(
      within(c).getByRole("radio", { name: /Yes, my colleagues/ }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Continue" }));
    expect(
      await within(c).findByText("Add these 3 people?"),
    ).toBeInTheDocument();
    expect(posts.some((p) => p.path === R.agentListens)).toBe(false);
    fireEvent.click(within(c).getByRole("checkbox", { name: /Dev Patel/ }));
    fireEvent.click(within(c).getByRole("button", { name: "Add 2 people" }));
    await waitFor(() =>
      expect(posts.some((p) => p.path === R.agentListens)).toBe(true),
    );
    expect(posts.find((p) => p.path === R.agentListens)?.body).toEqual({
      memberIds: ["u_maya", "u_ana"],
      scope: "all",
      until: 90,
      via: "first_setup",
    });
    await waitFor(() =>
      expect(posts.some((p) => p.path.endsWith("/listens-asked"))).toBe(true),
    );
  });

  it("says this person when there is one, and 1 person on the button", async () => {
    mountIt({}, [PEOPLE[0] as (typeof PEOPLE)[number]]);
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    fireEvent.click(
      within(c).getByRole("radio", { name: /Yes, my colleagues/ }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Continue" }));
    expect(await within(c).findByText("Add this person?")).toBeInTheDocument();
    expect(
      within(c).getByRole("button", { name: "Add 1 person" }),
    ).toBeInTheDocument();
    expect(within(c).queryByText(/and \d+ more/)).toBeNull();
  });

  it("shows six names, then 'and N more' that opens the rest", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      id: `u${i}`,
      name: `Person ${i}`,
      initials: "P",
    }));
    mountIt({}, eight);
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    fireEvent.click(
      within(c).getByRole("radio", { name: /Yes, my colleagues/ }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Continue" }));
    expect(
      await within(c).findByText("Add these 8 people?"),
    ).toBeInTheDocument();
    expect(within(c).getAllByRole("checkbox")).toHaveLength(6);
    fireEvent.click(within(c).getByRole("button", { name: "and 2 more" }));
    expect(within(c).getAllByRole("checkbox")).toHaveLength(8);
    expect(
      within(c).getByRole("button", { name: "Add 8 people" }),
    ).toBeInTheDocument();
  });

  it("adds in batches of 50", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `u${i}`,
      name: `Person ${i}`,
      initials: "P",
    }));
    const posts = calls("POST");
    mountIt({}, many);
    const c = await waitFor(() => {
      expect(card()).not.toBeNull();
      return card() as HTMLElement;
    });
    fireEvent.click(
      within(c).getByRole("radio", { name: /Yes, my colleagues/ }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await within(c).findByRole("button", { name: "Add 120 people" }),
    );
    await waitFor(() =>
      expect(posts.filter((p) => p.path === R.agentListens)).toHaveLength(3),
    );
    expect(
      posts
        .filter((p) => p.path === R.agentListens)
        .map((p) => (p.body as { memberIds: string[] }).memberIds.length),
    ).toEqual([50, 50, 20]);
  });
});
