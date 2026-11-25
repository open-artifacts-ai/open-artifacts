import { R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

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

  it("a click on an ask mark opens the comments at that thread, with no floating card", async () => {
    serve([thread("t1"), thread("t2", {}, null)]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.length).toBeGreaterThan(1));
    await click("t1");
    // #3048: the pane, with the thread open for a reply, and nothing beside the mark.
    const pane = await screen.findByRole("complementary", {
      name: "Comments",
    });
    expect(beside()).toBeNull();
    expect(
      await within(pane).findByRole("textbox", { name: "Reply" }),
    ).toBeInTheDocument();
    // The ask's card is there, whole, with the rest of its thread.
    expect(within(pane).getAllByText("Which layout?").length).toBeGreaterThan(
      1,
    );
  });

  it("a click on a plain highlight opens the comments at that thread too", async () => {
    serve([thread("t1", {}, null)]);
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(sent()?.length).toBe(1));
    await click("t1");
    expect(beside()).toBeNull();
    expect(
      await screen.findByRole("complementary", { name: "Comments" }),
    ).toBeInTheDocument();
  });

  it("a mark click on a decided ask opens the pane, never a card", async () => {
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
    expect(
      await screen.findByRole("complementary", { name: "Comments" }),
    ).toBeInTheDocument();
  });
});
