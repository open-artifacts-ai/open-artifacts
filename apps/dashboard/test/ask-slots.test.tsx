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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

type Rect = { x: number; y: number; width: number; height: number };
type Opts = {
  iframe: HTMLIFrameElement;
  url: string;
  onHello: () => void;
  onAskSlots?: (s: { key: string; rect: Rect }[]) => void;
};
const opts: Opts[] = [];
const setAskSlotSize = vi.fn();
vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: Opts) => {
      loadArtifactFrame(o.iframe, o.url);
      opts.push(o);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
        scrollTo: () => {},
        setCommentsMode: vi.fn(),
        setComments: vi.fn(),
        focusComment: vi.fn(),
        setAskSlotSize,
      };
    },
  };
});

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const HOME = "HomeArtifact0001";

const ask = (over: object = {}) => ({
  question: "Ship it Friday?",
  options: [
    { id: "yes", label: "Yes, Friday" },
    { id: "no", label: "Not yet" },
  ],
  to: [{ kind: "user", id: "me", name: "Me", me: true }],
  closed: false,
  ...over,
});
const slot = (key: string, over: object = {}) => ({
  key,
  home: { artifactId: OWNED, title: "Landing page" },
  threadId: `t-${key}`,
  commentId: `c-${key}`,
  ask: ask(),
  author: { kind: "agent", name: "Atlas", me: false },
  ...over,
});
const serve = (slots: unknown[] | 404) =>
  server.use(
    http.get(`*/api/v1/artifacts/${OWNED}/ask-slots`, () =>
      slots === 404
        ? HttpResponse.json(
            { error: { code: "not_found", message: "no" } },
            { status: 404 },
          )
        : HttpResponse.json(slots),
    ),
  );
const R1: Rect = { x: 20, y: 100, width: 400, height: 10 };
const report = (keys: string[]) =>
  act(async () => {
    await waitFor(() => expect(opts.length).toBeGreaterThan(0));
    opts.at(-1)?.onHello();
    opts
      .at(-1)
      ?.onAskSlots?.(
        keys.map((key, i) => ({ key, rect: { ...R1, y: 100 + i * 200 } })),
      );
  });
const card = (key: string) =>
  document.querySelector<HTMLElement>(`[data-ask-slot="${key}"]`);
const sizes = () => setAskSlotSize.mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => {
  opts.length = 0;
  setAskSlotSize.mockClear();
  // jsdom lays nothing out.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
});
afterEach(() => vi.restoreAllMocks());

describe("ask cards in page slots (#2426 B)", () => {
  it("draws a card only for a key the server returned, and closes the rest", async () => {
    serve([slot("launch-day")]);
    mount(viewerPath(OWNED));
    await report(["launch-day", "invented"]);
    await waitFor(() => expect(card("launch-day")).not.toBeNull());
    expect(card("invented")).toBeNull();
    await waitFor(() => expect(sizes()).toContainEqual(["invented", 0]));
    // The card's own height goes back for the page to make room.
    expect(sizes()).toContainEqual(["launch-day", 120]);
    expect(sizes()).not.toContainEqual(["launch-day", 0]);
  });

  it("closes every key when the server has no route (404)", async () => {
    serve(404);
    mount(viewerPath(OWNED));
    await report(["a", "b"]);
    await waitFor(() =>
      expect(sizes()).toEqual([
        ["a", 0],
        ["b", 0],
      ]),
    );
    expect(document.querySelector("[data-ask-slot]")).toBeNull();
  });

  it("a withdrawn ask shows nothing and its slot closes", async () => {
    serve([
      slot("old", { ask: ask({ withdrawn: { at: "2026-11-05T10:00:00Z" } }) }),
    ]);
    mount(viewerPath(OWNED));
    await report(["old"]);
    await waitFor(() => expect(sizes()).toContainEqual(["old", 0]));
    expect(card("old")).toBeNull();
  });

  it("a card on this page is a summary: clicking it opens the thread, no answering in place", async () => {
    let answered: unknown = null;
    serve([slot("launch-day")]);
    // The ask's thread is one of this page's comment threads.
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({
          threads: [
            {
              id: "t-launch-day",
              anchor: { kind: "note" },
              version: 1,
              status: "open",
              resolvedBy: null,
              resolvedAt: null,
              createdAt: "2026-11-05T10:00:00Z",
              comments: [
                {
                  id: "c-launch-day",
                  body: "Ship it Friday?",
                  author: { kind: "agent", name: "Atlas", me: false },
                  createdAt: "2026-11-05T10:00:00Z",
                  editedAt: null,
                  typed: false,
                  can: { edit: false, delete: false },
                  ask: ask(),
                },
              ],
            },
          ],
          open: 1,
          truncated: false,
        }),
      ),
      http.post(
        `*${R.commentAnswer(OWNED, "t-launch-day", "c-launch-day")}`,
        async ({ request }) => {
          answered = await request.json();
          return HttpResponse.json({});
        },
      ),
    );
    mount(viewerPath(OWNED));
    await report(["launch-day"]);
    const el = await waitFor(() => {
      const c = card("launch-day");
      if (!c) throw new Error("no card");
      return c;
    });
    // The summary says who asks and what: no option buttons, no pick route.
    expect(el.textContent).toContain("Atlas asks you");
    expect(el.textContent).toContain("Ship it Friday?");
    expect(
      within(el).queryByRole("button", { name: /Yes, Friday/ }),
    ).toBeNull();
    expect(within(el).queryByRole("button", { name: /Not yet/ })).toBeNull();
    // The page's own list knows that thread (the click is checked against it).
    await screen.findByRole("button", { name: "Comments, 1 open" });
    // Clicking it opens the thread in the comments, where the answer goes.
    fireEvent.click(within(el).getByRole("button", { name: /Atlas asks you/ }));
    // jsdom has no 960px media query: this is the side panel's Comments tab.
    const panel = await screen.findByRole("complementary", {
      name: "Side panel",
    });
    await waitFor(() =>
      expect(
        within(panel).getByRole("button", { name: "Reply" }),
      ).toBeInTheDocument(),
    );
    // The thread that opened is the ask's own.
    expect(
      document.querySelector('[data-thread="t-launch-day"][data-active]'),
    ).not.toBeNull();
    expect(answered).toBeNull();
  });

  it("hides a card whose slot is out of the visible frame", async () => {
    serve([slot("launch-day")]);
    mount(viewerPath(OWNED));
    await report(["launch-day"]);
    await waitFor(() => expect(card("launch-day")).not.toBeNull());
    expect(card("launch-day")?.style.visibility).toBe("visible");
    await act(async () =>
      opts
        .at(-1)
        ?.onAskSlots?.([{ key: "launch-day", rect: { ...R1, y: 5000 } }]),
    );
    expect(card("launch-day")?.style.visibility).toBe("hidden");
  });

  it("an ask from another page: header, context link, note, and no answering here", async () => {
    let answered: unknown = null;
    serve([
      slot("runbook", {
        home: { artifactId: HOME, title: "Opening runbook" },
        note: "Sign off by noon",
        placer: { name: "Sam" },
      }),
    ]);
    server.use(
      http.post(
        `*${R.commentAnswer(HOME, "t-runbook", "c-runbook")}`,
        async ({ request }) => {
          answered = await request.json();
          return HttpResponse.json({});
        },
      ),
    );
    mount(viewerPath(OWNED));
    await report(["runbook"]);
    const el = await waitFor(() => {
      const c = card("runbook");
      if (!c) throw new Error("no card");
      return c;
    });
    expect(el.textContent).toContain("Atlas asks you");
    expect(el.textContent).toContain("from Opening runbook");
    const link = within(el).getByRole("link", { name: /Opening runbook/ });
    expect(link).toHaveAttribute("href", viewerPath(HOME));
    expect(link).toHaveAttribute("target", "_blank");
    expect(
      within(el).getByRole("link", { name: /See it in context/ }),
    ).toHaveAttribute("href", `${viewerPath(HOME)}?thread=t-runbook`);
    expect(el.querySelector("[data-ask-slot-note]")?.textContent).toBe(
      "Note from Sam, who put this here: Sign off by noon",
    );
    // No options in the page: the home page's thread is where it is answered.
    expect(within(el).queryByRole("button", { name: /Not yet/ })).toBeNull();
    expect(answered).toBeNull();
  });

  it("a decided ask reads '✓ Decided: option'", async () => {
    serve([
      slot("done", {
        ask: ask({
          closed: true,
          answer: {
            optionId: "yes",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        }),
      }),
    ]);
    mount(viewerPath(OWNED));
    await report(["done"]);
    await waitFor(() => expect(card("done")).not.toBeNull());
    expect(card("done")?.textContent).toContain("✓ Decided: Yes, Friday");
  });
});
