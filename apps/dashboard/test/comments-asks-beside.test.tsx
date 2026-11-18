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
import { ASK_BESIDE_HOLD_MS } from "../src/viewer/comments/CommentsBody";
import { installHarness, mount, server, wait } from "./harness";

type Rect = { x: number; y: number; width: number; height: number };
type Opts = {
  iframe: HTMLIFrameElement;
  url: string;
  onHello: () => void;
  onCommentOpen: (id: string, rect?: Rect) => void;
};
const opts: Opts[] = [];
const setComments = vi.fn();
// Like the real bridge, the mock loads the frame (Shell ignores earlier loads).
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
        setComments,
        focusComment: vi.fn(),
      };
    },
  };
});

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;

const viewport = (width: number) => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches:
          q === "(min-width: 960px)"
            ? width >= 960
            : q === "(max-width: 600px)"
              ? width <= 600
              : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};
const hello = () =>
  act(async () => {
    await waitFor(() => expect(opts.length).toBeGreaterThan(0));
    opts.at(-1)?.onHello();
  });

const RECT: Rect = { x: 40, y: 120, width: 60, height: 18 };
const quote = {
  kind: "text",
  version: 1,
  exact: "quick",
  prefix: "",
  suffix: "",
};

const thread = (
  id: string,
  over: object = {},
  askOver: object | null = {},
) => ({
  id,
  anchor: quote,
  version: 1,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-11-05T10:00:00Z",
  comments: [
    {
      id: `c-${id}`,
      body: "Which layout?",
      author: {
        kind: "user",
        id: "owner",
        name: "Leo",
        agent: "OA",
        me: false,
      },
      createdAt: "2026-11-05T10:00:00Z",
      editedAt: null,
      typed: false,
      can: { edit: false, delete: false },
      ...(askOver === null
        ? {}
        : {
            ask: {
              question: "Which layout?",
              options: [
                { id: "a", label: "List only" },
                { id: "b", label: "Side by side" },
              ],
              to: [{ kind: "user", id: "me", name: "Me", me: true }],
              closed: false,
              ...askOver,
            },
          }),
    },
  ],
  ...over,
});

const serve = (threads: unknown[]) =>
  server.use(
    http.get(`*${R.comments(OWNED)}`, () =>
      HttpResponse.json({ threads, open: threads.length, truncated: false }),
    ),
  );
const sent = () =>
  setComments.mock.calls.at(-1)?.[0] as
    | { id: string; ask?: boolean }[]
    | undefined;
const beside = () => document.querySelector("[data-ask-beside]");
const click = (id: string, rect: Rect | null = RECT) =>
  act(async () => opts.at(-1)?.onCommentOpen(id, rect ?? undefined));

beforeEach(() => {
  opts.length = 0;
  setComments.mockClear();
  viewport(1280);
});
afterEach(() => vi.restoreAllMocks());

describe("asks inside the page (#2426)", () => {
  it("marks an unanswered ask for the viewer on a quote, and nothing else", async () => {
    serve([
      thread("t1"),
      thread(
        "t2",
        {},
        {
          answer: {
            optionId: "a",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
      thread("t3", {}, null),
      thread("t4", { anchor: { kind: "note" } }),
      thread("t5", { status: "resolved" }),
      thread(
        "t6",
        {},
        { to: [{ kind: "user", id: "x", name: "X", me: false }] },
      ),
    ]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.length).toBeGreaterThan(0));
    const byId = Object.fromEntries((sent() ?? []).map((t) => [t.id, t]));
    expect(byId.t1?.ask).toBe(true);
    for (const id of ["t2", "t3", "t5", "t6"])
      expect(byId[id]).not.toHaveProperty("ask");
    // A whole-page ask is not drawn in the frame at all.
    expect(byId.t4).toBeUndefined();
  });

  it("a click on an ask mark opens its card beside it, and answering sends the pane's request", async () => {
    let answered: unknown = null;
    serve([thread("t1")]);
    server.use(
      http.post(
        `*${R.commentAnswer(OWNED, "t1", "c-t1")}`,
        async ({ request }) => {
          answered = await request.json();
          return HttpResponse.json({});
        },
      ),
    );
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
    await click("t1");
    const card = await waitFor(() => {
      const el = beside();
      if (!el) throw new Error("no card");
      return el as HTMLElement;
    });
    expect(within(card).getByText("Which layout?")).toBeInTheDocument();
    // The comments pane stays closed.
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).toBeNull();
    await wait(ASK_BESIDE_HOLD_MS + 150);
    fireEvent.click(within(card).getByRole("button", { name: /List only/ }));
    await waitFor(() => expect(answered).toEqual({ optionId: "a" }));
  });

  it("a click on a plain highlight opens the pane, not a card", async () => {
    serve([thread("t1", {}, null)]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.length).toBe(1));
    await click("t1");
    expect(beside()).toBeNull();
  });

  it("a forged rect on a plain thread opens no card", async () => {
    serve([
      thread(
        "t1",
        {},
        {
          answer: {
            optionId: "a",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.length).toBe(1));
    await click("t1");
    expect(beside()).toBeNull();
  });

  it("an ask click with no rect falls back to the pane", async () => {
    serve([thread("t1")]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
    await click("t1", null);
    expect(beside()).toBeNull();
  });

  it("Esc closes the card, and so does a click outside it", async () => {
    serve([thread("t1")]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
    await click("t1");
    await waitFor(() => expect(beside()).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(beside()).toBeNull());
    await click("t1");
    await waitFor(() => expect(beside()).not.toBeNull());
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(beside()).toBeNull());
  });

  it("opens beside the mark on a phone too, not in the sheet", async () => {
    viewport(390);
    serve([thread("t1")]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
    await click("t1");
    await waitFor(() => expect(beside()).not.toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("a page cannot steal a click (#2426 review)", () => {
    const answerSpy = () => {
      const picks: unknown[] = [];
      server.use(
        http.post(
          `*${R.commentAnswer(OWNED, "t1", "c-t1")}`,
          async ({ request }) => {
            picks.push(await request.json());
            return HttpResponse.json({});
          },
        ),
      );
      return picks;
    };
    const cardReady = async () => {
      const card = await waitFor(() => {
        const el = beside();
        if (!el) throw new Error("no card");
        return el as HTMLElement;
      });
      return within(card).getByRole("button", { name: /List only/ });
    };

    it("takes no pick for the first 700 ms, then takes one", async () => {
      const picks = answerSpy();
      serve([thread("t1")]);
      mount(viewerPath(OWNED));
      await hello();
      await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
      await click("t1");
      const opt = await cardReady();
      expect(opt).toBeDisabled();
      fireEvent.click(opt);
      await wait(150);
      expect(picks).toEqual([]);
      await wait(ASK_BESIDE_HOLD_MS);
      expect(opt).not.toBeDisabled();
      fireEvent.click(opt);
      await waitFor(() => expect(picks).toEqual([{ optionId: "a" }]));
    });

    it('"I\'ll decide this" takes nothing for the first 700 ms, then works (#2736)', async () => {
      const bodies: unknown[] = [];
      server.use(
        http.post(
          `*${R.commentAskDecider(OWNED, "t1", "c-t1")}`,
          async ({ request }) => {
            bodies.push(await request.json());
            return HttpResponse.json({});
          },
        ),
      );
      const sam = { kind: "user", id: "sam", name: "Sam", me: false };
      serve([
        thread(
          "t1",
          {},
          {
            to: [sam, { kind: "user", id: "me", name: "Me", me: true }],
            decider: sam,
            chosenBy: { kind: "user", id: "me", name: "Me", me: true },
            role: "weigh",
            canTakeBack: true,
            picks: [],
          },
        ),
      ]);
      mount(viewerPath(OWNED));
      await hello();
      await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
      await click("t1");
      const card = await waitFor(() => {
        const el = beside();
        if (!el) throw new Error("no card");
        return el as HTMLElement;
      });
      const btn = within(card).getByRole("button", {
        name: "I'll decide this",
      });
      expect(btn).toBeDisabled();
      fireEvent.click(btn);
      await wait(150);
      expect(bodies).toEqual([]);
      await wait(ASK_BESIDE_HOLD_MS);
      expect(btn).not.toBeDisabled();
      fireEvent.click(btn);
      await waitFor(() => expect(bodies).toEqual([{ takeBack: true }]));
    });

    it("a second open of the same thread starts the delay over", async () => {
      serve([thread("t1")]);
      mount(viewerPath(OWNED));
      await hello();
      await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
      await click("t1");
      const opt = await cardReady();
      await wait(ASK_BESIDE_HOLD_MS + 100);
      expect(opt).not.toBeDisabled();
      await click("t1", { ...RECT, x: 200 });
      await waitFor(() => expect(opt).toBeDisabled());
      await wait(ASK_BESIDE_HOLD_MS + 100);
      expect(opt).not.toBeDisabled();
    });

    it("an open for another thread closes the card, not moves it", async () => {
      serve([thread("t1"), thread("t2")]);
      mount(viewerPath(OWNED));
      await hello();
      await waitFor(() => expect(sent()?.length).toBe(2));
      await click("t1");
      await waitFor(() => expect(beside()).not.toBeNull());
      await click("t2");
      await waitFor(() => expect(beside()).toBeNull());
    });

    it.each([
      [
        "an option with an action",
        {
          options: [
            { id: "a", label: "List only", action: "merge" },
            { id: "b", label: "Side by side" },
          ],
        },
      ],
      ["a passkey-confirm ask", { confirm: "passkey" }],
    ])("%s never opens beside: the pane takes it", async (_n, over) => {
      serve([thread("t1", {}, over)]);
      mount(viewerPath(OWNED));
      await hello();
      await waitFor(() => expect(sent()?.[0]?.ask).toBe(true));
      await click("t1");
      expect(
        await screen.findByRole("complementary", { name: "Comments" }),
      ).toBeInTheDocument();
      expect(beside()).toBeNull();
    });
  });
});
