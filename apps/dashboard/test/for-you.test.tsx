// #2512: the bell (Me.inbox) and "For you" (R.meInbox), on the mocks.
import { type Inbox, type InboxItem, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { focusManager } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  calls,
  events,
  findVisibleToast,
  installHarness,
  mount,
  server,
} from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const bell = () =>
  screen.findByRole("button", { name: /^For you/ }, { timeout: FIRST_LOAD_MS });

const forYou = (variant: "mixed" | "calm" | "empty" | "back") =>
  server.use(...createHandlers({ events, forYou: variant }));

const openPanel = async () => {
  fireEvent.click(await bell());
  const panel = await screen.findByRole("dialog", { name: "For you" });
  await within(panel).findByRole("region", { name: "Needs you" });
  return panel;
};

describe("the bell", () => {
  it("is absent when Me has no inbox, and asks for nothing", async () => {
    const gets = calls("GET");
    mount("/");
    await screen.findByRole(
      "button",
      { name: "Account menu" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(screen.queryByRole("button", { name: /^For you/ })).toBeNull();
    expect(gets.some((c) => c.path.startsWith(R.meInbox))).toBe(false);
  });

  it("counts only what needs you, from Me.inbox, before the list loads", async () => {
    const gets = calls("GET");
    forYou("mixed");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you, 2 need you");
    expect(b.querySelector("[data-bell-count]")).toHaveTextContent("2");
    expect(b.querySelector("[data-bell-dot]")).toBeNull();
    expect(gets.some((c) => c.path === R.meInbox)).toBe(false);
  });

  it("shows a dot, not a number, when only updates are new", async () => {
    forYou("calm");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you, new updates");
    expect(b.querySelector("[data-bell-count]")).toBeNull();
    expect(b.querySelector("[data-bell-dot]")).not.toBeNull();
  });

  it("has no number and no dot with nothing at all", async () => {
    forYou("empty");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you");
    expect(b.querySelector("[data-bell-count], [data-bell-dot]")).toBeNull();
  });

  it("is in the viewer's title bar too", async () => {
    forYou("mixed");
    mount("/a/Cd5fGhJkLm6nPqRs");
    expect(await bell()).toHaveAccessibleName("For you, 2 need you");
  });
});

describe("For you", () => {
  it("keeps the server's order and splits Needs you from Updates", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const needs = within(panel).getByRole("region", { name: "Needs you" });
    const rows = within(needs).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-for-you-item"))).toEqual([
      "ask:fyAskComment1",
      "itm:machine1",
    ]);
    expect(rows[0]).toHaveTextContent("waiting 4 min");
    expect(
      within(rows[1] as HTMLElement).getByRole("link", { name: "Review" }),
    ).toHaveAttribute("href", "/agents");
    const ups = within(panel).getByRole("region", { name: "Updates" });
    expect(
      within(ups).getByRole("button", { name: "Mark all read" }),
    ).toBeInTheDocument();
    expect(
      within(ups).getByRole("link", { name: "OA Design replied, unread" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("href", "/settings/notifications");
  });

  it("shows an agent with its tile, as comments do, and a person with initials", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const reply = panel.querySelector('[data-for-you-item="itm:reply1"]');
    expect(
      reply?.querySelector('[data-avatar="agent"][data-linked="true"]'),
    ).toHaveAttribute("data-animal", "fox");
    const decided = panel.querySelector('[data-for-you-item="itm:decided1"]');
    expect(decided?.querySelector('[data-avatar="agent"]')).toBeNull();
    expect(decided).toHaveTextContent(/^SR/);
  });

  it("an opened ask shows the agent's tile before its name, only here", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    const from = await waitFor(() => {
      const el = panel.querySelector("[data-for-you-ask] [data-ask-from]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const tile = from.firstElementChild;
    expect(tile).toHaveAttribute("data-avatar", "agent");
    expect(tile).toHaveAttribute("data-animal", "owl");
    expect(from).toHaveTextContent(/^OA Manager\s*agent\s*asks you$/);
  });

  it("never re-sorts what the server sent", async () => {
    const it = (id: string, waitMin: number): InboxItem => ({
      id: `ask:${id}`,
      level: "needs_you",
      kind: "ask",
      urgency: "waiting",
      waitingSince: new Date(Date.now() - waitMin * 60_000).toISOString(),
      artifact: { id: "Cd5fGhJkLm6nPqRs", title: "Landing page" },
      actor: null,
      text: id,
      href: "/a/Cd5fGhJkLm6nPqRs",
      createdAt: new Date().toISOString(),
      readAt: null,
    });
    const body: Inbox = {
      needsYou: [it("short", 1), it("long", 90)],
      later: [],
      updates: [],
      cursor: null,
      counts: { needsYou: 2, unreadUpdates: 0 },
    };
    forYou("mixed");
    server.use(http.get(`*${R.meInbox}`, () => HttpResponse.json(body)));
    mount("/");
    const panel = await openPanel();
    const ids = within(panel)
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-for-you-item"));
    expect(ids).toEqual(["ask:short", "ask:long"]);
  });

  it("a mute keeps the row and says so quietly", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    const posts = calls("POST");
    const more = within(row).getByRole("button", { name: "More actions" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute OA Design" }),
    );
    await findVisibleToast("Muted OA Design. Asks for you still come through.");
    await waitFor(() =>
      expect(posts.find((c) => c.path === R.meInboxMutes)?.body).toEqual({
        kind: "agent",
        id: "agent:design",
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("dialog", { name: "For you" })
          .querySelector('[data-for-you-item="itm:reply1"]'),
      ).not.toBeNull(),
    );
  });

  it("first time with nothing at all: You're all caught up.", async () => {
    forYou("empty");
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    expect(
      await within(panel).findByText("You're all caught up."),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "When an agent asks you something or someone replies to you, it shows here.",
    );
  });

  it("a returned item is marked, with no Later", async () => {
    forYou("back");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:machine1"]',
    ) as HTMLElement;
    expect(row).toHaveTextContent("Back from later");
    expect(within(row).queryByRole("button", { name: "Later" })).toBeNull();
  });
});

describe("staying fresh", () => {
  it("refreshes the counts every minute while visible and on focus, never while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const gets = calls("GET");
      forYou("mixed");
      mount("/");
      const b = await bell();
      expect(b).toHaveAccessibleName("For you, 2 need you");
      const meGets = () => gets.filter((c) => c.path === R.me).length;
      // The server's counts change: the next refresh shows them.
      let needsYou = 5;
      server.use(
        http.get("*/api/v1/me", () =>
          HttpResponse.json({
            ...fixtures.me,
            inbox: { needsYou, unreadUpdates: 0 },
          }),
        ),
      );
      const n0 = meGets();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      await waitFor(() =>
        expect(b).toHaveAccessibleName("For you, 5 need you"),
      );
      expect(meGets()).toBeGreaterThan(n0);

      // Hidden: no polling at all.
      act(() => focusManager.setFocused(false));
      needsYou = 7;
      const n1 = meGets();
      await act(() => vi.advanceTimersByTimeAsync(180_000));
      expect(meGets()).toBe(n1);
      expect(b).toHaveAccessibleName("For you, 5 need you");

      // Back in focus: it asks at once.
      act(() => focusManager.setFocused(true));
      await waitFor(() =>
        expect(b).toHaveAccessibleName("For you, 7 need you"),
      );
      expect(meGets()).toBe(n1 + 1);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });
});

describe("Show more", () => {
  const upd = (id: string): InboxItem => ({
    id,
    level: "update",
    kind: "reply",
    artifact: { id: "De6gHjKmNp7qRsTu", title: "Meeting notes" },
    actor: { kind: "user", name: "Sam Rivera", me: false },
    text: `Reply ${id}`,
    href: "/a/De6gHjKmNp7qRsTu",
    createdAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
  });
  const page = (updates: InboxItem[], cursor: string | null): Inbox => ({
    needsYou: [],
    later: [],
    updates,
    cursor,
    counts: { needsYou: 0, unreadUpdates: 0 },
  });

  it("loads the next page of Updates while there is a cursor", async () => {
    const gets = calls("GET");
    forYou("empty");
    server.use(
      http.get(`*${R.meInbox}`, ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get("cursor") === "p2"
            ? page([upd("itm:u2")], null)
            : page([upd("itm:u1")], "p2"),
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    const ups = within(panel).getByRole("region", { name: "Updates" });
    expect(
      within(ups)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Reply itm:u1"]);
    fireEvent.click(within(ups).getByRole("button", { name: "Show more" }));
    await within(ups).findByRole("link", { name: "Reply itm:u2" });
    expect(
      gets.some((c) => c.path === R.meInbox && c.search.get("cursor") === "p2"),
    ).toBe(true);
    // The last page has no cursor: no more to show.
    expect(within(ups).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("has no Show more without a cursor", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    expect(
      within(panel).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });
});

const LANDING = "Cd5fGhJkLm6nPqRs";

/** The seeded ask with this question on the Landing page: its thread and comment ids. */
async function seeded(question: string) {
  const res = await fetch(
    new URL(`${R.comments(LANDING)}?status=all`, "http://localhost").href,
    { headers: { cookie: "oa_session=test" } },
  );
  const { threads } = (await res.json()) as {
    threads: {
      id: string;
      comments: { id: string; ask?: { question: string } }[];
    }[];
  };
  for (const t of threads)
    for (const c of t.comments)
      if (c.ask?.question === question) return { thread: t.id, comment: c.id };
  throw new Error(`no seeded ask: ${question}`);
}

/**
 * The inbox holds just this ask until a pick reaches the server (the server
 * drops an answered ask). Opens the panel and the card.
 */
async function openAsk(
  question: string,
  level: InboxItem["level"] = "needs_you",
) {
  server.use(
    ...createHandlers({
      events,
      forYou: "mixed",
      commentAsks: true,
      commentDeciders: true,
      commentPasskey: "ok",
    }),
  );
  const ids = await seeded(question);
  let answered = false;
  const other: InboxItem = {
    id: "itm:read1",
    level: "update",
    kind: "reply",
    artifact: { id: LANDING, title: "Landing page" },
    actor: null,
    text: "Sam replied",
    href: `/a/${LANDING}`,
    createdAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
  };
  const item: InboxItem = {
    id: `ask:${ids.comment}`,
    level,
    kind: "ask",
    urgency: "plain",
    artifact: { id: LANDING, title: "Landing page" },
    actor: null,
    text: question,
    href: `/a/${LANDING}?thread=${ids.thread}`,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  server.use(
    http.post("*/api/v1/artifacts/:id/comments/:t/comments/:c/answer", () => {
      answered = true;
      return undefined;
    }),
    http.get(`*${R.meInbox}`, () =>
      HttpResponse.json({
        needsYou: level === "needs_you" && !answered ? [item] : [],
        later: [],
        // One read update keeps the list from being empty after the answer.
        updates: level === "update" ? [item] : [other],
        cursor: null,
        counts: {
          needsYou: level === "needs_you" && !answered ? 1 : 0,
          unreadUpdates: level === "update" ? 1 : 0,
        },
      } satisfies Inbox),
    ),
  );
  mount("/");
  const panel = await openPanel();
  fireEvent.click(
    within(panel).getByRole("button", {
      name: new RegExp(question.replace(/[?]/g, "\\?")),
    }),
  );
  const card = await waitFor(() => {
    const el = panel.querySelector(
      "[data-for-you-ask] [data-ask], [data-for-you-ask] [data-ask-decided]",
    );
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  return { panel, card, ids };
}

describe("an ask opened in the panel", () => {
  it("answers through the page's own route, then returns focus to the list", async () => {
    const posts = calls("POST");
    const { panel, card, ids } = await openAsk("Which layout do we ship?");
    fireEvent.click(within(card).getByRole("button", { name: /Compact hero/ }));
    await waitFor(() =>
      expect(panel.querySelector("[data-for-you-ask]")).toBeNull(),
    );
    expect(posts.map((c) => c.path)).toContain(
      R.commentAnswer(LANDING, ids.thread, ids.comment),
    );
    // The row is gone: focus goes to the next row, never <body>.
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName("Sam replied"),
    );
  });

  it("back to the list focuses the row it came from", async () => {
    const { panel } = await openAsk("Which layout do we ship?");
    fireEvent.click(within(panel).getByRole("button", { name: /^For you$/ }));
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName(
        "Which layout do we ship?",
      ),
    );
  });

  it("a weigh-in shows who decides, and weighing in leaves the list", async () => {
    const posts = calls("POST");
    const { panel, card, ids } = await openAsk(
      "Which pricing table goes on the landing page?",
    );
    expect(card).toHaveTextContent("Maya Chen decides");
    fireEvent.click(
      within(card).getByRole("button", { name: /B: two columns/ }),
    );
    // Weighed in: it no longer waits for you, so the card closes and the row goes.
    await waitFor(() =>
      expect(panel.querySelector("[data-for-you-ask]")).toBeNull(),
    );
    expect(posts.map((c) => c.path)).toContain(
      R.commentAnswer(LANDING, ids.thread, ids.comment),
    );
    expect(
      panel.querySelector(`[data-for-you-item="ask:${ids.comment}"]`),
    ).toBeNull();
  });

  it("a pick that turns out to need a passkey asks to pick again", async () => {
    const { card } = await openAsk("Ship the changelog?");
    fireEvent.click(within(card).getByRole("button", { name: /Ship it/ }));
    expect(
      await within(card).findByText("This now needs your passkey. Pick again."),
    ).toBeInTheDocument();
  });

  it("a risky ask says it needs a passkey", async () => {
    const { card } = await openAsk("Merge the release PR?");
    expect(card).toHaveTextContent("Approving this needs your passkey.");
    // A risky ask is its asker's own user's call: no who-line, no weigh-ins.
    expect(card.querySelector("[data-ask-decider]")).toBeNull();
    expect(card).not.toHaveTextContent(/decides|weighed in/);
  });

  it("a closed ask shows its decision", async () => {
    const { panel } = await openAsk("Which plan card is shown first?");
    expect(
      panel.querySelector("[data-for-you-ask] [data-ask-decided]"),
    ).not.toBeNull();
  });

  it("an update-level ask opens its card too", async () => {
    const { card } = await openAsk("Which layout do we ship?", "update");
    expect(card).toHaveTextContent("Which layout do we ship?");
  });

  it("says so when the ask can't be loaded", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    server.use(
      http.get(`*${R.comments(LANDING)}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    expect(
      await within(panel).findByText("Couldn't open this ask."),
    ).toBeInTheDocument();
  });

  it("Try again loads the card after a failure", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    let fail = true;
    server.use(
      http.get(`*${R.comments(LANDING)}`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: "not_found", message: "Not found" } },
              { status: 404 },
            )
          : undefined,
      ),
    );
    mount("/");
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    await within(panel).findByText("Couldn't open this ask.");
    fail = false;
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(
      await within(panel).findByRole("button", { name: /Yes, ship it/ }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText("Couldn't open this ask.")).toBeNull();
  });
});

describe("failures and announcements", () => {
  it("a list that fails to load offers Try again", async () => {
    forYou("mixed");
    let fail = true;
    server.use(
      http.get(`*${R.meInbox}`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: "bad_request", message: "No" } },
              { status: 400 },
            )
          : undefined,
      ),
    );
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    expect(
      await within(panel).findByText("Couldn't load For you."),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(
      await within(panel).findByRole("region", { name: "Needs you" }),
    ).toBeInTheDocument();
  });

  it("Undo on the mute toast unmutes", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    const dels = calls("DELETE");
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "More actions" }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute OA Design" }),
    );
    await findVisibleToast("Muted OA Design. Asks for you still come through.");
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(dels.map((c) => c.path)).toContain(
        R.meInboxMute("agent", "agent:design"),
      ),
    );
  });

  it("an Undo that fails says so", async () => {
    forYou("mixed");
    server.use(
      http.delete("*/api/v1/me/inbox/mutes/:kind/:id", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "No" } },
          { status: 500 },
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "More actions" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute OA Design" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await findVisibleToast("Couldn't save that.");
  });

  it("announces a change in the count, politely", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const live = document.querySelector("[data-for-you-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    const row = panel.querySelector(
      '[data-for-you-item="itm:machine1"]',
    ) as HTMLElement;
    fireEvent.pointerDown(within(row).getByRole("button", { name: /Later/ }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Tomorrow morning" }),
    );
    await waitFor(() => expect(live).toHaveTextContent("For you, 1 needs you"));
  });
});
