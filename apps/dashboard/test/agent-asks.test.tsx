// #2577: asking someone else's agent: the held-request notice, the Settings list and the @ list.
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { allowedText, endDate, leftoverText } from "../src/foryou/held";
import { MentionMenu } from "../src/viewer/comments/asks";
import { calls, events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const asks = () =>
  server.use(...createHandlers({ events, forYou: "held", agentAsks: true }));

const openNotice = async () => {
  asks();
  mount("/");
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: /^For you/ },
      { timeout: FIRST_LOAD_MS },
    ),
  );
  const panel = await screen.findByRole("dialog", { name: "For you" });
  fireEvent.click(
    await within(panel).findByRole("button", {
      name: "Dev Patel wants to ask your agent",
    }),
  );
  await within(panel).findByText(/where does the 42%/);
  return panel;
};

describe("the held-request notice", () => {
  it("shows who asked, the words, and the four choices of a page in a space", async () => {
    const panel = await openNotice();
    expect(panel).toHaveTextContent("Dev Patel wants to ask your agent");
    expect(panel).toHaveTextContent('on "Launch status" · 3 requests');
    expect(panel).toHaveTextContent("and is it this week or last week?");
    expect(panel).toHaveTextContent("the date in row 5 is wrong");
    for (const name of [
      "Allow once",
      "Allow on this page for 30 days",
      'Allow in the "Launch" space…',
      "Allow on all pages…",
      "Not now",
    ])
      expect(within(panel).getByRole("button", { name })).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      `Web hasn't been sent any of this. "Allow once" passes these 3 to Web, marked as from Dev, not from you.`,
    );
  });

  it("Allow once passes exactly the listed words, then the row is gone", async () => {
    const posts = calls("POST");
    const panel = await openNotice();
    fireEvent.click(within(panel).getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/allow"))).toBe(true),
    );
    const body = posts.find((c) => c.path.endsWith("/allow"))?.body as {
      level: string;
      items: { commentId: string; wordsHash: string }[];
    };
    expect(body.level).toBe("once");
    expect(body.items.map((i) => i.commentId)).toEqual([
      "c_held1",
      "c_held2",
      "c_held3",
    ]);
    expect(body.items.every((i) => /^[0-9a-f]{64}$/.test(i.wordsHash))).toBe(
      true,
    );
    await waitFor(() =>
      expect(
        within(panel).queryByRole("button", { name: "Allow once" }),
      ).toBeNull(),
    );
    expect(
      await screen.findByText(
        "Web got Dev's 3 requests. Dev's next one will ask you again.",
      ),
    ).toBeInTheDocument();
  });

  it("this page sends level page; no passkey", async () => {
    const posts = calls("POST");
    const panel = await openNotice();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Allow on this page for 30 days",
      }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/allow"))).toBe(true),
    );
    const call = posts.find((c) => c.path.endsWith("/allow"))?.body as
      | { level: string; assertion?: unknown }
      | undefined;
    expect(call?.level).toBe("page");
    expect(call?.assertion).toBeUndefined();
  });

  it("all pages asks once more for an end date, with no passkey, then allows", async () => {
    const posts = calls("POST");
    const panel = await openNotice();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Allow on all pages\u2026" }),
    );
    expect(
      await within(panel).findByText("Allow Dev on all pages?"),
    ).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/passkey/i);
    expect(posts.some((c) => c.path.endsWith("/allow"))).toBe(false);
    fireEvent.click(within(panel).getByLabelText(/^90 days/));
    fireEvent.click(
      within(panel).getByRole("button", { name: "Allow Dev on all pages" }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/allow"))).toBe(true),
    );
    const b = posts.find((c) => c.path.endsWith("/allow"))?.body as {
      level: string;
      until: number;
      assertion?: unknown;
    };
    expect(b.level).toBe("all");
    expect(b.assertion).toBeUndefined();
    expect(b.until).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(posts.some((c) => c.path.includes("/challenge"))).toBe(false);
  });

  it("space asks for an end date only and sends level space", async () => {
    const posts = calls("POST");
    const panel = await openNotice();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: `Allow in the "Launch" space\u2026`,
      }),
    );
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: `Allow Dev in "Launch"`,
      }),
    );
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/allow"))).toBe(true),
    );
    const b = posts.find((c) => c.path.endsWith("/allow"))?.body as {
      level: string;
      until: number;
    };
    expect(b.level).toBe("space");
    expect(b.until).toBeGreaterThan(Date.now());
  });

  it("on a page open to guests only Allow once and Not now show", async () => {
    server.use(
      http.get(`*${R.agentAskHeld}`, () =>
        HttpResponse.json({
          requests: [
            {
              id: "held_dev1",
              sender: { id: "u_dev", name: "Dev Patel" },
              artifact: { id: "a", title: "Public roadmap" },
              items: [
                {
                  commentId: "c1",
                  threadId: "t1",
                  agentKey: "k",
                  agentName: "Web",
                  way: "mention",
                  body: "which quarter?",
                  wordsHash: "a".repeat(64),
                  createdAt: Date.now(),
                },
              ],
              since: Date.now(),
              lastAt: Date.now(),
              quietUntil: null,
              open: true,
              space: null,
            },
          ],
        }),
      ),
      ...createHandlers({ events, forYou: "held", agentAsks: true }),
    );
    mount("/");
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^For you/ },
        { timeout: FIRST_LOAD_MS },
      ),
    );
    const panel = await screen.findByRole("dialog", { name: "For you" });
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "Dev Patel wants to ask your agent",
      }),
    );
    await within(panel).findByText(/which quarter/);
    expect(
      within(panel)
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter((t) => /^(Allow|Not now)/.test(t ?? "")),
    ).toEqual(["Allow once", "Not now"]);
    expect(panel).toHaveTextContent(
      "Anyone with the link can read Web's reply on this page.",
    );
  });

  it("Not now quiets it and the row leaves", async () => {
    const posts = calls("POST");
    const panel = await openNotice();
    fireEvent.click(within(panel).getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(posts.some((c) => c.path.endsWith("/not-now"))).toBe(true),
    );
    expect(
      await screen.findByText(
        /You won't hear about Dev's requests again today/,
      ),
    ).toBeInTheDocument();
  });

  it("words: dates, results and leftovers", () => {
    const now = new Date("2026-11-15T12:00:00Z").getTime();
    expect(endDate(now + 30 * 86_400_000, now)).toBe("15 December");
    expect(endDate(now + 365 * 86_400_000, now)).toBe("15 November next year");
    expect(leftoverText({ changed: 1, waiting: 2 })).toBe(
      "1 request changed while you looked, so it is held again at the new words. 2 still waiting (hourly limit).",
    );
    expect(
      allowedText({
        level: "page",
        sent: 3,
        asker: "Dev Patel",
        agent: "Web",
        page: "Launch status",
        until: now + 30 * 86_400_000,
        now,
      }),
    ).toBe(
      `Web got Dev's 3 requests. Dev's later ones on "Launch status" go straight to Web until 15 December.`,
    );
  });
});

describe("Settings: who can ask my agents", () => {
  const settings = async () => {
    server.use(...createHandlers({ events, agentAsks: true }));
    mount("/settings/connections");
    return screen.findByRole(
      "heading",
      { name: "My agents listen to" },
      { timeout: FIRST_LOAD_MS },
    );
  };

  it("lists who is listened to, with scope and end", async () => {
    await settings();
    const row = (id: string) =>
      document.querySelector(`[data-listen="${id}"]`) as HTMLElement;
    await waitFor(() => expect(row("l_maya")).toBeTruthy());
    expect(row("l_maya")).toHaveTextContent("Maya Chen");
    expect(row("l_maya")).toHaveTextContent("All pages my agents work on");
    expect(row("l_dev")).toHaveTextContent('"Launch status" only');
    expect(row("l_priya")).toHaveTextContent('Pages in the "Launch" space');
    expect(row("l_dev")).toHaveTextContent(/until \d+ \w+/);
  });

  it("Remove deletes the entry", async () => {
    const dels = calls("DELETE");
    await settings();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Maya Chen" }),
    );
    await waitFor(() =>
      expect(dels.some((c) => c.path === R.agentListen("l_maya"))).toBe(true),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-listen="l_maya"]')).toBeNull(),
    );
  });

  it("the switch saves, and Off says what it means", async () => {
    const puts = calls("PUT");
    await settings();
    const sw = await screen.findByRole("switch", {
      name: "Teammates can ask my agents",
    });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() =>
      expect(puts.find((c) => c.path === R.agentRequests)?.body).toEqual({
        on: false,
      }),
    );
    expect(
      await screen.findByText(
        /Off: your agents only answer you, and teammates are told so\./,
      ),
    ).toBeInTheDocument();
  });

  it("an empty list says what to expect", async () => {
    server.use(
      http.get(`*${R.agentListens}`, () => HttpResponse.json({ entries: [] })),
      ...createHandlers({ events, agentAsks: true }),
    );
    mount("/settings/connections");
    expect(
      await screen.findByText(
        /^Nobody yet\. When a teammate asks one of your agents/,
        undefined,
        { timeout: FIRST_LOAD_MS },
      ),
    ).toBeInTheDocument();
  });
});

describe("the @ list", () => {
  const agent = (
    name: string,
    owner: string | null,
    askState?: "listening" | "held" | "off",
  ) => ({
    key: `k:${name}`,
    name: owner ? `${name} (${owner})` : name,
    online: true,
    state: "online" as const,
    owner,
    askState,
  });
  const menu = (agents: ReturnType<typeof agent>[], onPick = vi.fn()) => {
    render(
      <MentionMenu
        id="m"
        matches={agents}
        all={agents}
        active={0}
        onPick={onPick}
      />,
    );
    return onPick;
  };

  it("says the three states in plain words, with the person's name", () => {
    menu([
      agent("Web", "Sam", "held"),
      agent("Docs", "Maya", "listening"),
      agent("Payroll", "Ana", "off"),
    ]);
    expect(screen.getByRole("option", { name: /Web/ })).toHaveTextContent(
      "Sam's agent · Sam will be asked first",
    );
    expect(screen.getByRole("option", { name: /Docs/ })).toHaveTextContent(
      "Maya's agent · listens to you here",
    );
    expect(screen.getByRole("option", { name: /Payroll/ })).toHaveTextContent(
      "Ana's agent · only answers Ana",
    );
  });

  it("an agent whose person turned asking off can't be picked", () => {
    const onPick = menu([
      agent("Payroll", "Ana", "off"),
      agent("Web", "Sam", "held"),
    ]);
    const off = screen.getByRole("option", { name: /Payroll/ });
    expect(off).toHaveAttribute("aria-disabled", "true");
    fireEvent.mouseDown(off);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("option", { name: /Web/ }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
