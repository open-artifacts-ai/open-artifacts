import { ANON_ID_HEADER, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  configure,
  fireEvent,
  getConfig,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ACTIONS, ACTIONS_PLAIN } from "../src/viewer/comments/CommentsBody";
import { fullPath } from "../src/viewer/paths";
import {
  calls,
  events,
  installHarness,
  lastClient,
  mount,
  server,
  wait,
} from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

type Opts = {
  iframe: HTMLIFrameElement;
  url: string;
  onHello: () => void;
  onInteracted: () => void;
  onCommentSelect: (a: unknown) => void;
  onCommentPositions: (p: unknown[]) => void;
  onCommentOpen: (id: string) => void;
};
const opts: Opts[] = [];
const setMode = vi.fn();
const setComments = vi.fn();
const focus = vi.fn();
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
        setCommentsMode: setMode,
        setComments,
        focusComment: focus,
      };
    },
  };
});

installHarness();

// Most waits here follow a write: the PATCH or POST, then the list refetch it
// invalidates (a second round trip through MSW), then the render. Each hop is
// CPU-bound and slows about 30x on a loaded runner (#1004), which can pass
// setup.ts's 5 s asyncUtilTimeout. Stay under the test timeout so a wait that
// never resolves still reports its own failure.
const defaultAsyncTimeout = getConfig().asyncUtilTimeout;
beforeAll(() => configure({ asyncUtilTimeout: FIRST_LOAD_MS }));
afterAll(() => configure({ asyncUtilTimeout: defaultAsyncTimeout }));

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const PUBLIC = (
  fixtures.artifacts.find((a) => a.title === "Q4 report") as { id: string }
).id;

const oneThread = {
  id: "t1",
  anchor: { kind: "note" },
  version: 1,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-11-05T10:00:00Z",
  comments: [
    {
      id: "c1",
      body: "From someone",
      author: { kind: "guest", name: "Guest", me: false },
      createdAt: "2026-11-05T10:00:00Z",
      editedAt: null,
      can: { edit: false, delete: false },
    },
  ],
};

/** A viewport: matchMedia answers the two breakpoints the comments layout uses. */
const viewport = (width: number) => {
  const eval_ = (q: string) =>
    q === "(min-width: 960px)"
      ? width >= 960
      : q === "(max-width: 600px)"
        ? width <= 600
        : false;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: eval_(q),
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
const col = () => screen.findByRole("complementary", { name: "Comments" });
const threadIds = () =>
  [...document.querySelectorAll("[data-thread]")].map((e) =>
    e.getAttribute("data-thread"),
  );

beforeEach(() => {
  opts.length = 0;
  setMode.mockClear();
  setComments.mockClear();
  focus.mockClear();
  viewport(1280);
});
afterEach(() => vi.restoreAllMocks());

describe("comments: layouts", () => {
  it("is a column beside the page at 960px and up, with the open count on the button", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByText("Can we tighten this headline?"),
    ).toBeInTheDocument();
    expect(within(c).getByText("1 open")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Comments, 1 open" }),
    ).toBeInTheDocument();
    // Resolved ones are hidden until asked for.
    expect(within(c).queryByText("Looks good overall.")).toBeNull();
    fireEvent.click(
      within(c).getByRole("button", { name: "Show resolved (1)" }),
    );
    expect(within(c).getByText("Looks good overall.")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Hide resolved" }));
    expect(within(c).queryByText("Looks good overall.")).toBeNull();
  });

  it("folds into a Comments tab of the side panel below 960px", async () => {
    viewport(800);
    mount(viewerPath(OWNED));
    const btn = await screen.findByRole("button", { name: "Comments, 1 open" });
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).toBeNull();
    fireEvent.click(btn);
    const tab = await screen.findByRole("tab", { name: "Comments" });
    expect(tab).toHaveAttribute("data-state", "active");
    expect(
      await screen.findByText("Can we tighten this headline?"),
    ).toBeInTheDocument();
  });

  it("an empty list in the side panel still shows its empty state and grows (#1711)", async () => {
    // CommentsBody is `flex-none` only in the phone sheet's short height; the
    // panel keeps the growing list (its scroll area is a block, so the class is
    // inert there either way) and its empty state.
    viewport(800);
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({ threads: [], open: 0, truncated: false }),
      ),
    );
    mount(viewerPath(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    const tab = await screen.findByRole("tab", { name: "Comments" });
    expect(tab).toHaveAttribute("data-state", "active");
    const empty = await screen.findByText(/No comments yet/);
    const body = empty.closest("div.flex") as HTMLElement;
    expect(body.className).toContain("flex-1");
    expect(body.className).not.toContain("flex-none");
  });

  it("is a bottom sheet on phones", async () => {
    viewport(400);
    mount(viewerPath(OWNED));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comments, 1 open" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(
      await within(sheet).findByText("Can we tighten this headline?"),
    ).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("focusing a composer in the half-height phone sheet expands it", async () => {
    viewport(400);
    mount(viewerPath(OWNED));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comments, 1 open" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(sheet).toHaveAttribute("data-sheet-height", "half");
    const box = await within(sheet).findAllByRole("textbox");
    fireEvent.focus(box[0] as HTMLElement);
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
  });

  it("a phone sheet shrinks further while a pin card is open, so its pin stays in view (#1657)", async () => {
    viewport(400);
    const pin = (id: string, y: number) => ({
      ...oneThread,
      id,
      anchor: { kind: "pin", version: 1, x: 0.5, y, contentHash: null },
    });
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({
          threads: [pin("p1", 0.4), pin("p2", 0.7)],
          open: 2,
          truncated: false,
        }),
      ),
    );
    mount(viewerPath(OWNED));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comments, 2 open" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(sheet).toHaveAttribute("data-sheet-height", "half");
    // The frame opens the pin's card: the sheet gives the image back.
    await act(async () => opts.at(-1)?.onCommentOpen("p1"));
    expect(sheet).toHaveAttribute("data-sheet-height", "pin");
    // The handle still wins: a reader who wants the list gets the full sheet.
    fireEvent.click(screen.getByRole("button", { name: "Expand comments" }));
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
    // Opening a card from full shrinks it again, and moving pin to pin too
    // (the effect keys on the pin, not on "a pin is open").
    await act(async () => opts.at(-1)?.onCommentOpen("p2"));
    expect(sheet).toHaveAttribute("data-sheet-height", "pin");
    fireEvent.click(screen.getByRole("button", { name: "Expand comments" }));
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
    await act(async () => opts.at(-1)?.onCommentOpen("p1"));
    expect(sheet).toHaveAttribute("data-sheet-height", "pin");
  });

  it("the short pin sheet floats the open card's action row in the sheet, clear of the home indicator (#1711)", async () => {
    viewport(400);
    const posts = calls("POST");
    const pin = (id: string, y: number) => ({
      ...oneThread,
      id,
      anchor: { kind: "pin", version: 1, x: 0.5, y, contentHash: null },
    });
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({
          threads: [pin("p1", 0.4), pin("p2", 0.7)],
          open: 2,
          truncated: false,
        }),
      ),
    );
    mount(viewerPath(OWNED));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comments, 2 open" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    // No card is open yet, so nothing floats and the sheet has no outlet.
    expect(sheet.querySelector("[data-oa-action-outlet]")).toBeNull();
    await act(async () => opts.at(-1)?.onCommentOpen("p1"));
    // The outlet is a direct child of the sheet's scroller, stuck to its
    // bottom edge: the row stays in view for a long thread scrolled to its top.
    const outlet = await waitFor(() => {
      const el = sheet.querySelector("[data-oa-action-outlet]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(outlet.parentElement?.className).toContain("overflow-y-auto");
    expect(outlet.className).toContain("sticky");
    expect(outlet.className).toContain("bottom-0");
    // The list keeps its content height (`flex-none`: no shrink, and no zero
    // basis either): when a card is scrolled into view, a compressed body would
    // carry the row up to the sheet's top instead.
    const body = outlet.previousElementSibling as HTMLElement;
    expect(body.className).toContain("flex-none");
    expect(body.className).not.toContain("flex-1");
    // A short list still leaves the row at the sheet's bottom edge.
    expect(outlet.className).toContain("mt-auto");
    // And it clears a phone's home indicator.
    expect(outlet.className).toContain("safe-area-inset-bottom");
    // The row moved out of the card, and still acts for it.
    const row = await within(outlet).findByRole("button", { name: "Reply" });
    expect(row.closest("[data-oa-actions]")).not.toBeNull();
    const card = sheet.querySelector('[data-thread="p1"]') as HTMLElement;
    expect(card.contains(row)).toBe(false);
    // Scrolled: the card is scrolled into view (its own autoscroll), and the
    // row is still the outlet's, not carried back into the card.
    const scroller = outlet.parentElement as HTMLElement;
    Object.defineProperty(scroller, "scrollTop", {
      value: 240,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(scroller);
    await wait(30);
    expect(card.contains(row)).toBe(false);
    expect(outlet.contains(row)).toBe(true);
    fireEvent.change(within(card).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Floats" },
    });
    fireEvent.click(within(outlet).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ body: "Floats" });
    // A sheet the reader expands keeps the row in the card, where the reader
    // can see the box it belongs to.
    fireEvent.click(screen.getByRole("button", { name: "Expand comments" }));
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
    expect(sheet.querySelector("[data-oa-action-outlet]")).toBeNull();
    expect(
      within(card as HTMLElement).getByRole("button", { name: "Reply" }),
    ).toBeInTheDocument();
  });

  it("typing in the pin sheet's reply box expands the sheet and puts the row back in the card (#1711)", async () => {
    // #1657's expand gives the phone keyboard its room; the card's own composer
    // then holds the row, right under the box the reader is typing in.
    viewport(400);
    const pin = {
      ...oneThread,
      id: "p1",
      anchor: { kind: "pin", version: 1, x: 0.5, y: 0.4, contentHash: null },
    };
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({ threads: [pin], open: 1, truncated: false }),
      ),
    );
    mount(viewerPath(OWNED));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comments, 1 open" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    await act(async () => opts.at(-1)?.onCommentOpen("p1"));
    expect(sheet).toHaveAttribute("data-sheet-height", "pin");
    const outlet = await waitFor(() => {
      const el = sheet.querySelector("[data-oa-action-outlet]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const card = sheet.querySelector('[data-thread="p1"]') as HTMLElement;
    fireEvent.focus(within(card).getByRole("textbox", { name: "Reply" }));
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
    // No outlet in a sheet the reader can see the whole card in.
    expect(sheet.querySelector("[data-oa-action-outlet]")).toBeNull();
    expect(outlet.isConnected).toBe(false);
    const row = within(card).getByRole("button", { name: "Reply" });
    expect(row.closest("[data-oa-actions]")).not.toBeNull();
    fireEvent.change(within(card).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Typed" },
    });
  });

  it("the wide overlay never floats the row, even with a pin card open (#1711)", async () => {
    viewport(1280);
    const pin = {
      ...oneThread,
      id: "p1",
      anchor: { kind: "pin", version: 1, x: 0.5, y: 0.4, contentHash: null },
    };
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({ threads: [pin], open: 1, truncated: false }),
      ),
    );
    mount(fullPath(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    const overlay = await screen.findByRole("dialog", { name: "Comments" });
    await act(async () => opts.at(-1)?.onCommentOpen("p1"));
    expect(overlay.querySelector("[data-oa-action-outlet]")).toBeNull();
    const card = overlay.querySelector('[data-thread="p1"]') as HTMLElement;
    const row = await within(card).findByRole("button", { name: "Reply" });
    expect(row.closest("[data-oa-actions]")).not.toBeNull();
  });

  it("the phone sheet has a handle that toggles two heights and a backdrop that closes it", async () => {
    viewport(400);
    mount(viewerPath(OWNED));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comments, 1 open" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(sheet).toHaveAttribute("data-sheet-height", "half");
    fireEvent.click(screen.getByRole("button", { name: "Expand comments" }));
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
    fireEvent.click(screen.getByRole("button", { name: "Shrink comments" }));
    expect(sheet).toHaveAttribute("data-sheet-height", "half");
    // Dragging the handle up goes to full height; the click that follows does not undo it.
    const handle = screen.getByRole("button", { name: "Expand comments" });
    fireEvent.pointerDown(handle, { clientY: 300 });
    fireEvent.pointerUp(handle, { clientY: 200 });
    fireEvent.click(handle);
    expect(sheet).toHaveAttribute("data-sheet-height", "full");
    // A tap after a finished drag still toggles (the flag is reset on pointerdown).
    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent.pointerUp(handle, { clientY: 100 });
    fireEvent.click(handle);
    expect(sheet).toHaveAttribute("data-sheet-height", "half");
    // A cancelled pointer clears the drag: the up that follows is ignored.
    fireEvent.pointerDown(handle, { clientY: 300 });
    fireEvent.pointerCancel(handle);
    fireEvent.pointerUp(handle, { clientY: 100 });
    expect(sheet).toHaveAttribute("data-sheet-height", "half");
    const backdrop = document.querySelector("[data-sheet-backdrop]");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows no Comments button, column or frame highlights when the setting is off", async () => {
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === OWNED),
          comments: false,
        }),
      ),
    );
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: "More actions" });
    await hello();
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).toBeNull();
    expect(setComments).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenLastCalledWith("off");
  });
});

describe("comments: the frame", () => {
  it("sends the frame anchors and ids only: no text, no names", async () => {
    mount(viewerPath(OWNED));
    await col();
    await hello();
    await waitFor(() => expect(setComments).toHaveBeenCalled());
    expect(setMode).toHaveBeenLastCalledWith("select");
    const sent = JSON.stringify(setComments.mock.calls.at(-1));
    expect(sent).toContain('"exact":"Landing page"');
    expect(sent).not.toContain("tighten");
    expect(sent).not.toContain("Sam Rivera");
  });

  it("selecting a card focuses its highlight in the frame", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Show in page/ }),
    );
    const id = threadIds()[0];
    expect(focus).toHaveBeenCalledWith(id);
    await waitFor(() =>
      expect(
        document.querySelector("[data-thread][data-active]"),
      ).not.toBeNull(),
    );
  });

  it("acts on comment.open only for ids in its own list", async () => {
    mount(viewerPath(OWNED));
    await col();
    await screen.findByText("Can we tighten this headline?");
    const id = threadIds()[0] as string;
    await act(async () => opts.at(-1)?.onCommentOpen("forged-id"));
    expect(document.querySelector("[data-thread][data-active]")).toBeNull();
    await act(async () => opts.at(-1)?.onCommentOpen(id));
    expect(
      document
        .querySelector("[data-thread][data-active]")
        ?.getAttribute("data-thread"),
    ).toBe(id);
  });

  it("rate-limits comment.select: the sixth in a second is dropped", async () => {
    mount(viewerPath(OWNED));
    await col();
    for (let i = 1; i <= 6; i++)
      await act(async () =>
        opts.at(-1)?.onCommentSelect({
          kind: "text",
          exact: `quote-${i}`,
          prefix: "",
          suffix: "",
        }),
      );
    expect(await screen.findByText("quote-5")).toBeInTheDocument();
    expect(screen.queryByText("quote-6")).toBeNull();
  });

  it("ignores positions for unknown ids and orders cards by the rest", async () => {
    mount(viewerPath(OWNED));
    await col();
    await screen.findByText("Can we tighten this headline?");
    const ids = threadIds();
    await act(async () =>
      opts.at(-1)?.onCommentPositions([
        { id: "forged", state: "exact", top: 1 },
        { id: ids[0] as string, state: "partial", top: 20 },
      ]),
    );
    expect(
      await screen.findByText("Text changed since this comment"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Original text: .Landing page./),
    ).toBeInTheDocument();
  });

  it("a selection from the frame only pre-fills a draft: nothing posts until the reader submits", async () => {
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    await col();
    await act(async () =>
      opts.at(-1)?.onCommentSelect({
        kind: "text",
        exact: "<img src=x onerror=alert(1)>",
        prefix: "a ",
        suffix: " b",
      }),
    );
    const box = await screen.findByRole("textbox", { name: "Add a comment" });
    // Shown as text, never parsed.
    expect(
      screen.getByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    await wait(30);
    expect(posts).toHaveLength(0);
    fireEvent.change(box, { target: { value: "  Nice  " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toMatchObject({
      anchor: {
        kind: "text",
        version: 2,
        exact: "<img src=x onerror=alert(1)>",
        prefix: "a ",
        suffix: " b",
      },
      body: "Nice",
    });
    await screen.findByText("Nice");
  });
});

describe("comments: actions", () => {
  it("adds a note on the whole page", async () => {
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.focus(
      within(c).getByRole("textbox", { name: "Comment on the whole page" }),
    );
    fireEvent.change(
      within(c).getByRole("textbox", { name: "Comment on the whole page" }),
      {
        target: { value: "Overall: great" },
      },
    );
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({
      anchor: { kind: "note" },
      body: "Overall: great",
    });
    expect(await within(c).findByText("Overall: great")).toBeInTheDocument();
    expect(within(c).getAllByText("Whole page").length).toBeGreaterThan(0);
  });

  it("replies, and resolves from the reply box", async () => {
    const posts = calls("POST");
    const patches = calls("PATCH");
    mount(viewerPath(OWNED));
    const c = await col();
    // Two comments: collapsed to a count until the card is selected.
    fireEvent.click(await within(c).findByRole("button", { name: "1 reply" }));
    // #1657: in the phone sheet's short height the action row stays on screen.
    const actions = within(c)
      .getByRole("button", { name: "Reply" })
      .closest("[data-oa-actions]") as HTMLElement;
    expect(actions).not.toBeNull();
    expect(actions.className).toContain(
      "group-data-[sheet-height=pin]/sheet:sticky",
    );
    // Floating over scrolling text needs an opaque surface, never an inherited
    // one: a card's own, and the sheet's in the note composer (#1696).
    expect(actions.className).toContain(
      "group-data-[sheet-height=pin]/sheet:bg-background",
    );
    expect(ACTIONS).not.toContain("bg-inherit");
    expect(ACTIONS_PLAIN).toContain(
      "group-data-[sheet-height=pin]/sheet:bg-card",
    );
    expect(
      await within(c).findByText("Agreed, shorter is better."),
    ).toBeInTheDocument();
    fireEvent.change(within(c).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Done" },
    });
    fireEvent.click(within(c).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.path).toMatch(/\/comments\/[^/]+\/replies$/);
    expect(posts[0]?.body).toEqual({ body: "Done" });
    await within(c).findByText("Done");
    fireEvent.click(within(c).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toEqual({ status: "resolved" });
    expect(await within(c).findByText("0 open")).toBeInTheDocument();
  });

  it("reopens a resolved thread from its card", async () => {
    const patches = calls("PATCH");
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: "Show resolved (1)" }),
    );
    const card = (await within(c).findByText("Looks good overall.")).closest(
      "[data-thread]",
    ) as HTMLElement;
    const line = within(card).getByText(/Resolved by Sam Rivera/);
    expect(line).toBeInTheDocument();
    expect(line.className).toMatch(/text-green-/);
    expect(line.querySelector("svg")).not.toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(patches[0]?.body).toEqual({ status: "open" }));
    expect(await within(c).findByText("2 open")).toBeInTheDocument();
  });

  it("edits your own comment and shows it as edited", async () => {
    const patches = calls("PATCH");
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(await within(c).findByRole("button", { name: "1 reply" }));
    const mine = (
      await within(c).findByText("Agreed, shorter is better.")
    ).closest("li") as HTMLElement;
    fireEvent.click(
      within(mine).getByRole("button", { name: "Comment actions" }),
    );
    fireEvent.click(within(mine).getByRole("button", { name: "Edit" }));
    fireEvent.change(
      within(mine).getByRole("textbox", { name: "Edit comment" }),
      {
        target: { value: "Agreed, much shorter." },
      },
    );
    fireEvent.click(within(mine).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patches[0]?.body).toEqual({ body: "Agreed, much shorter." }),
    );
    expect(
      await within(c).findByText("Agreed, much shorter."),
    ).toBeInTheDocument();
    expect(within(c).getByText(/edited/)).toBeInTheDocument();
  });

  it("deletes a reply after Delete this reply?, and a root after Delete this thread?", async () => {
    const dels = calls("DELETE");
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(await within(c).findByRole("button", { name: "1 reply" }));
    const reply = (
      await within(c).findByText("Agreed, shorter is better.")
    ).closest("li") as HTMLElement;
    fireEvent.click(
      within(reply).getByRole("button", { name: "Comment actions" }),
    );
    fireEvent.click(within(reply).getByRole("button", { name: "Delete" }));
    expect(within(reply).getByText("Delete this reply?")).toBeInTheDocument();
    fireEvent.click(within(reply).getByRole("button", { name: "Keep" }));
    expect(dels).toHaveLength(0);
    fireEvent.click(
      within(reply).getByRole("button", { name: "Comment actions" }),
    );
    fireEvent.click(within(reply).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(reply).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(dels).toHaveLength(1));
    await waitFor(() =>
      expect(within(c).queryByText("Agreed, shorter is better.")).toBeNull(),
    );
    const root = within(c)
      .getByText("Can we tighten this headline?")
      .closest("li") as HTMLElement;
    fireEvent.click(
      within(root).getByRole("button", { name: "Comment actions" }),
    );
    fireEvent.click(within(root).getByRole("button", { name: "Delete" }));
    expect(
      within(root).getByText("Delete this thread? Its replies go too."),
    ).toBeInTheDocument();
  });

  it("P2: opening the column fetches no agents; focusing a composer fetches once", async () => {
    const agentCalls: string[] = [];
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, ({ request }) => {
        agentCalls.push(request.url);
        return HttpResponse.json(
          { error: { code: "not_found", message: "no" } },
          { status: 404 },
        );
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    });
    await wait(50);
    expect(agentCalls).toHaveLength(0);
    fireEvent.focus(box);
    await waitFor(() => expect(agentCalls).toHaveLength(1));
    // A 404 is final: more typing or focus asks again for nothing, and no picker shows.
    fireEvent.blur(box);
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "hello @" } });
    fireEvent.change(box, { target: { value: "hello @O" } });
    await wait(50);
    expect(agentCalls).toHaveLength(1);
    expect(within(c).queryByRole("listbox")).toBeNull();
  });

  it("P2: the column opens on its own with no threads, and an explicit close sticks", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json({ threads: [], open: 0, truncated: false }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByRole("textbox", {
        name: "Comment on the whole page",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Comments" }),
      ).toBeNull(),
    );
  });

  it("P2: narrower than 960px the column stays closed until there is something to show", async () => {
    viewport(800);
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json({ threads: [], open: 0, truncated: false }),
      ),
    );
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: "Comments" });
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).toBeNull();
  });

  it("P2: below 960px Comments is the first tab of the side panel", async () => {
    viewport(800);
    mount(`${viewerPath(OWNED)}?panel=open&tab=comments`);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Comments",
      "Versions",
      "Share",
      "Details",
    ]);
  });

  it("P2: the new-comment row has Cancel, then the accent Comment, at the right", async () => {
    mount(viewerPath(OWNED));
    await col();
    await act(async () =>
      opts.at(-1)?.onCommentSelect({
        kind: "text",
        exact: "hello",
        prefix: "",
        suffix: "",
      }),
    );
    const box = await screen.findByRole("textbox", { name: "Add a comment" });
    const row = screen.getByRole("button", { name: "Comment" })
      .parentElement as HTMLElement;
    const names = [...row.querySelectorAll("button")].map((b) => b.textContent);
    expect(names).toEqual(["Cancel", "Comment"]);
    expect(row.className).toContain("ml-auto");
    expect(screen.getByRole("button", { name: "Comment" }).className).toContain(
      "--oa-accent",
    );
    expect(box).toBeInTheDocument();
  });

  it("the Comments setting in Share turns comments off", async () => {
    const patches = calls("PATCH");
    mount(`${viewerPath(OWNED)}?panel=open&tab=share`);
    const box = await screen.findByRole("checkbox", { name: "Comments" });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() =>
      expect(
        patches.some(
          (p) => (p.body as { comments?: boolean })?.comments === false,
        ),
      ).toBe(true),
    );
  });
});

describe("comments: errors", () => {
  const fillNote = async (text: string) => {
    const c = await col();
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    return c;
  };
  const fail = (status: number, code: string) =>
    server.use(
      http.post("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json({ error: { code, message: "x" } }, { status }),
      ),
    );

  it("rate limited", async () => {
    mount(viewerPath(OWNED));
    fail(429, "rate_limited");
    const c = await fillNote("hi");
    expect(
      await within(c).findByText("Too many comments. Try again in a minute."),
    ).toBeInTheDocument();
  });

  it("a failed post keeps the text and says so", async () => {
    mount(viewerPath(OWNED));
    fail(500, "internal");
    const c = await fillNote("keep me");
    expect(
      await within(c).findByText("Couldn't post your comment. Try again."),
    ).toBeInTheDocument();
    expect(
      within(c).getByRole("textbox", { name: "Comment on the whole page" }),
    ).toHaveValue("keep me");
  });

  it("anchor_not_in_version offers a page note with the same words", async () => {
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    await col();
    await act(async () =>
      opts.at(-1)?.onCommentSelect({
        kind: "text",
        exact: "gone",
        prefix: "",
        suffix: "",
      }),
    );
    fail(422, "anchor_not_in_version");
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Add a comment" }),
      {
        target: { value: "about this" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const offer = await screen.findByRole("button", {
      name: "Add as a page note",
    });
    server.resetHandlers();
    // Back to the working mock for the note.
    const { createHandlers } = await import("@oa/shared/mocks");
    server.use(...createHandlers({ events }), ...events.handlers);
    fireEvent.click(offer);
    await waitFor(() =>
      expect(posts.at(-1)?.body).toEqual({
        anchor: { kind: "note" },
        body: "about this",
      }),
    );
  });

  it("a list that fails to load offers Retry", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByText("Couldn't load comments."),
    ).toBeInTheDocument();
    expect(
      within(c).getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
  });
});

describe("comments: live and signed out", () => {
  it("refetches the list when the events socket says comments changed", async () => {
    const gets = calls("GET");
    mount(viewerPath(OWNED));
    await col();
    await waitFor(() => expect(events.connections(OWNED)).toBe(1));
    const n = () => gets.filter((g) => g.path.endsWith("/comments")).length;
    const before = n();
    await act(async () => {
      events.emitComments(OWNED, 3);
    });
    await waitFor(() => expect(n()).toBeGreaterThan(before));
  });

  it("a signed-out visitor who can't comment sees the list and Sign in to comment.", async () => {
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "no" } },
          { status: 401 },
        ),
      ),
      http.get(`*${R.artifact(PUBLIC)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === PUBLIC),
          // The server says this visitor can't comment (can.comment false).
          can: {
            edit: false,
            share: false,
            setVisibility: false,
            delete: false,
            transfer: false,
            move: false,
            dataWrite: false,
            comment: false,
          },
          visibility: "public",
          dataWriters: "editors",
          allowAnonymousWrites: false,
        }),
      ),
      http.get(`*${R.comments(PUBLIC)}`, () =>
        HttpResponse.json({ threads: [oneThread], open: 1, truncated: false }),
      ),
    );
    mount(viewerPath(PUBLIC));
    const c = await col();
    expect(
      await within(c).findByText("Sign in to comment."),
    ).toBeInTheDocument();
    expect(within(c).getByText("From someone")).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(within(c).queryByRole("textbox")).toBeNull();
  });

  it("a guest on a public artifact that allows anonymous writes gets a name field", async () => {
    const posts = calls("POST");
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "no" } },
          { status: 401 },
        ),
      ),
      http.get(`*${R.artifact(PUBLIC)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === PUBLIC),
          can: undefined,
          visibility: "public",
          dataWriters: "viewers",
          allowAnonymousWrites: true,
        }),
      ),
      http.get(`*${R.comments(PUBLIC)}`, () =>
        HttpResponse.json({ threads: [], open: 0, truncated: false }),
      ),
      http.post(`*${R.comments(PUBLIC)}`, () =>
        HttpResponse.json(
          { error: { code: "internal", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    mount(viewerPath(PUBLIC));
    // The column is open by default where it has room.
    const c = await col();
    // The whole-page box: Sign in at the left of the row, back to this page.
    fireEvent.focus(
      within(c).getByRole("textbox", { name: "Comment on the whole page" }),
    );
    // (jsdom's window.location is "/", not the memory router's path.)
    expect(
      within(c).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toMatch(/^\/sign-in\?next=%2F/);
    fireEvent.change(within(c).getByRole("textbox", { name: "Your name" }), {
      target: { value: "Pat" },
    });
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({
      anchor: { kind: "note" },
      body: "hello",
      guestName: "Pat",
    });
  });
});

describe("comments: contract edges", () => {
  const send = (method: string, path: string, body?: unknown) =>
    fetch(path, {
      method,
      headers: { "X-OA-Request": "1", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("the mock answers a malformed thread or comment id with 400 bad_request", async () => {
    for (const [m, p, b] of [
      [
        "POST",
        `/api/v1/artifacts/${OWNED}/comments/bad%20id/replies`,
        { body: "x" },
      ],
      [
        "PATCH",
        `/api/v1/artifacts/${OWNED}/comments/bad%20id`,
        { status: "open" },
      ],
      [
        "PATCH",
        `/api/v1/artifacts/${OWNED}/comments/t/comments/bad%20id`,
        { body: "x" },
      ],
      [
        "DELETE",
        `/api/v1/artifacts/${OWNED}/comments/t/comments/bad%20id`,
        undefined,
      ],
    ] as const) {
      const r = await send(m, p, b);
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("bad_request");
    }
  });

  it("the mock answers a thread's 201st reply with 409 conflict, and the card says so", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Can we tighten this headline?");
    const tid = threadIds()[0] as string;
    const url = `/api/v1/artifacts/${OWNED}/comments/${tid}/replies`;
    // The seeded thread has 1 reply: add 199 more, the 201st is refused.
    for (let i = 0; i < 199; i++)
      expect((await send("POST", url, { body: `r${i}` })).status).toBe(201);
    const r = await send("POST", url, { body: "one too many" });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("conflict");
  });

  it("shows the conflict copy when a reply is refused", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(await within(c).findByRole("button", { name: "1 reply" }));
    server.use(
      http.post("*/api/v1/artifacts/:id/comments/:tid/replies", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "x" } },
          { status: 409 },
        ),
      ),
    );
    fireEvent.change(within(c).getByRole("textbox", { name: "Reply" }), {
      target: { value: "more" },
    });
    fireEvent.click(within(c).getByRole("button", { name: "Reply" }));
    expect(
      await within(c).findByText(
        "This thread has too many replies. Start a new comment instead.",
      ),
    ).toBeInTheDocument();
  });

  it("a comments event never touches version state: no content or artifact refetch, no Versions dot", async () => {
    const gets = calls("GET");
    mount(viewerPath(OWNED));
    await col();
    await waitFor(() => expect(events.connections(OWNED)).toBe(1));
    await wait(50);
    const other = () =>
      gets.filter((g) => !g.path.endsWith("/comments")).length;
    const before = other();
    await act(async () => {
      events.emitComments(OWNED, 7);
    });
    await wait(100);
    expect(other()).toBe(before);
    expect(screen.queryByTestId("versions-dot")).toBeNull();
    // Control: the same setup does show the dot for a real new version, so the
    // assertion above can fail. A touched frame holds the swap and dots Versions.
    await act(async () => opts.at(-1)?.onInteracted());
    await act(async () => {
      events.emitVersion(OWNED, { version: 99 });
    });
    expect(
      (await screen.findAllByTestId("versions-dot")).length,
    ).toBeGreaterThan(0);
  });
});

describe("comments: guests and Retry-After", () => {
  beforeEach(async () => {
    (await import("../src/viewer/anonId")).resetAnonMemory();
  });
  const TOKEN = `${"A".repeat(22)}.k1.${"B".repeat(43)}`;
  const guestMocks = () => {
    const seenTokens: (string | null)[] = [];
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "no" } },
          { status: 401 },
        ),
      ),
      http.get(`*${R.artifact(PUBLIC)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === PUBLIC),
          can: undefined,
          visibility: "public",
          dataWriters: "viewers",
          allowAnonymousWrites: true,
        }),
      ),
      // A GET never mints: it reads the token if one is sent, else as a guest.
      http.get(`*${R.comments(PUBLIC)}`, ({ request }) => {
        seenTokens.push(request.headers.get(ANON_ID_HEADER));
        return HttpResponse.json({ threads: [], open: 0, truncated: false });
      }),
    );
    return seenTokens;
  };

  it("a guest reads without a token, and the POST that mints returns it: stored, then sent on later requests", async () => {
    const seenTokens = guestMocks();
    const writes: (string | null)[] = [];
    server.use(
      http.post(`*${R.comments(PUBLIC)}`, ({ request }) => {
        writes.push(request.headers.get(ANON_ID_HEADER));
        return HttpResponse.json(oneThread, {
          status: 201,
          headers: { [ANON_ID_HEADER]: TOKEN },
        });
      }),
    );
    mount(viewerPath(PUBLIC));
    // The column is open by default where it has room.
    const c = await col();
    await waitFor(() => expect(seenTokens.length).toBeGreaterThan(0));
    // The read sent no token and minted none.
    expect(seenTokens).toEqual([null]);
    expect(localStorage.getItem("oa.anonId")).toBeNull();
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(writes).toEqual([null]));
    await waitFor(() => expect(localStorage.getItem("oa.anonId")).toBe(TOKEN));
    // The refetch after the post carries the stored token.
    await waitFor(() => expect(seenTokens.at(-1)).toBe(TOKEN));
  });

  it("a fresh guest can Resolve with no token and no lock: the status change never mints", async () => {
    guestMocks();
    const seen: (string | null)[] = [];
    let thread: object = oneThread;
    server.use(
      http.get(`*${R.comments(PUBLIC)}`, () =>
        HttpResponse.json({ threads: [thread], open: 1, truncated: false }),
      ),
      http.patch("*/api/v1/artifacts/:id/comments/:tid", ({ request }) => {
        seen.push(request.headers.get(ANON_ID_HEADER));
        thread = {
          ...oneThread,
          status: "resolved",
          resolvedBy: { kind: "guest", name: "Guest", me: true },
          resolvedAt: "2026-11-05T11:00:00Z",
        };
        return HttpResponse.json(thread);
      }),
    );
    const request = vi.fn(
      (_n: string, _o: unknown, cb: () => Promise<unknown>) => cb(),
    );
    Object.defineProperty(navigator, "locks", {
      value: { request },
      configurable: true,
    });
    try {
      mount(viewerPath(PUBLIC));
      const c = await col();
      fireEvent.click(
        await within(c).findByRole("button", { name: "Resolve" }),
      );
      await waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(localStorage.getItem("oa.anonId")).toBeNull();
      // Resolved, shown as Guest, and Reopen is offered.
      fireEvent.click(
        await within(c).findByRole("button", { name: "Show resolved (1)" }),
      );
      expect(
        await within(c).findByText(/Resolved by Guest/),
      ).toBeInTheDocument();
      expect(
        within(c).getByRole("button", { name: "Reopen" }),
      ).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("a signed-in viewer never sends the anon token", async () => {
    localStorage.setItem("oa.anonId", TOKEN);
    const got: (string | null)[] = [];
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", ({ request }) => {
        got.push(request.headers.get(ANON_ID_HEADER));
        return HttpResponse.json({ threads: [], open: 0, truncated: false });
      }),
    );
    mount(viewerPath(OWNED));
    await waitFor(() => expect(got.length).toBeGreaterThan(0));
    expect(got.every((t) => t === null)).toBe(true);
  });

  const limited = (retry?: string) =>
    server.use(
      http.post("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "x" } },
          { status: 429, headers: retry ? { "Retry-After": retry } : {} },
        ),
      ),
    );
  const post = async () => {
    const c = await col();
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    return c;
  };

  it.each([
    ["7", "Too many comments. Try again in 7 seconds."],
    ["1", "Too many comments. Try again in 1 second."],
    ["130", "Too many comments. Try again in 3 minutes."],
    [undefined, "Too many comments. Try again in a minute."],
    ["soon", "Too many comments. Try again in a minute."],
  ])("429 with Retry-After %s", async (retry, copy) => {
    mount(viewerPath(OWNED));
    limited(retry);
    const c = await post();
    expect(await within(c).findByText(copy)).toBeInTheDocument();
  });
});

/** A new version is published: the artifact now reports it as current, then the event arrives. */
const bump = async (id: string, version: number) => {
  const a = fixtures.artifacts.find((x) => x.id === id);
  // Refetches report the new version too, as the server would.
  server.use(
    http.get(`*${R.artifact(id)}`, () =>
      HttpResponse.json({ ...a, currentVersion: version }),
    ),
  );
  await act(async () => {
    lastClient.setQueryData(["artifact", id], {
      ...a,
      currentVersion: version,
    });
    events.emitVersion(id, { version });
  });
};

describe("comments: review round 1", () => {
  const sel = (exact: string) => ({
    kind: "text",
    exact,
    prefix: "",
    suffix: "",
  });
  const view = () => screen.queryByRole("button", { name: /View version/ });

  it("B1: a live swap never drops a comment being written: the chip shows instead", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    await hello();
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "half written" } });
    await bump(OWNED, 99);
    expect(
      await screen.findByRole("button", { name: "View version 99" }),
    ).toBeInTheDocument();
    // Re-queried: the same box, not a detached one.
    expect(
      within(await col()).getByRole("textbox", {
        name: "Comment on the whole page",
      }),
    ).toHaveValue("half written");
    expect(
      screen.getAllByRole("textbox", { name: "Comment on the whole page" }),
    ).toHaveLength(1);
  });

  it("B1 control: with nothing being written the same version swaps in quietly", async () => {
    mount(viewerPath(OWNED));
    await col();
    await hello();
    await bump(OWNED, 99);
    await waitFor(() =>
      expect(document.querySelectorAll("iframe").length).toBeGreaterThan(1),
    );
    expect(view()).toBeNull();
  });

  it("P2: an explicit column close survives a live version swap", async () => {
    mount(viewerPath(OWNED));
    await col();
    await hello();
    fireEvent.click(screen.getByRole("button", { name: /^Comments/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Comments" }),
      ).toBeNull(),
    );
    await bump(OWNED, 97);
    await waitFor(() =>
      expect(document.querySelectorAll("iframe").length).toBeGreaterThan(1),
    );
    // Hidden layers included: the preloaded one must not open its own column.
    expect(
      screen.queryAllByRole("complementary", {
        name: "Comments",
        hidden: true,
      }),
    ).toHaveLength(0);
  });

  it("B1: a typed reply and an open delete confirm hold a swap too", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    await hello();
    fireEvent.click(await within(c).findByRole("button", { name: "1 reply" }));
    fireEvent.change(within(c).getByRole("textbox", { name: "Reply" }), {
      target: { value: "typing a reply" },
    });
    await bump(OWNED, 98);
    expect(
      await screen.findByRole("button", { name: "View version 98" }),
    ).toBeInTheDocument();
    // Re-queried from the DOM: the list still shows the thread and the text.
    expect(
      await screen.findByText("Agreed, shorter is better."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
      "typing a reply",
    );
    // Clear the reply, open a delete confirm instead.
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "" },
    });
    const row = screen
      .getByText("Agreed, shorter is better.")
      .closest("li") as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: "Comment actions" }),
    );
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this reply?")).toBeInTheDocument();
    await bump(OWNED, 99);
    expect(
      await screen.findByRole("button", { name: "View version 99" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Delete this reply?")).toBeInTheDocument();
  });

  it("B1: an edit in progress and a pending draft count as writing too", async () => {
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(await within(c).findByRole("button", { name: "1 reply" }));
    const mine = (
      await within(c).findByText("Agreed, shorter is better.")
    ).closest("li") as HTMLElement;
    expect(document.querySelector("[data-oa-composing]")).toBeNull();
    fireEvent.click(
      within(mine).getByRole("button", { name: "Comment actions" }),
    );
    fireEvent.click(within(mine).getByRole("button", { name: "Edit" }));
    expect(document.querySelector("[data-oa-composing]")).not.toBeNull();
    fireEvent.click(within(mine).getByRole("button", { name: "Cancel" }));
    expect(document.querySelector("[data-oa-composing]")).toBeNull();
    await act(async () => opts.at(-1)?.onCommentSelect(sel("q")));
    expect(document.querySelector("[data-oa-composing]")).not.toBeNull();
  });

  it("M1: a second comment.select does not replace the quote under typed words", async () => {
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    await col();
    await act(async () => opts.at(-1)?.onCommentSelect(sel("first-quote")));
    await act(async () => opts.at(-1)?.onCommentSelect(sel("second-quote")));
    // Nothing typed yet: replacing is fine.
    expect(await screen.findByText("second-quote")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Add a comment" }), {
      target: { value: "my words" },
    });
    await act(async () => opts.at(-1)?.onCommentSelect(sel("forged-quote")));
    expect(screen.queryByText("forged-quote")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Add a comment" })).toHaveValue(
      "my words",
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const sent = posts[0]?.body as { anchor: { exact: string } } | undefined;
    expect(sent?.anchor.exact).toBe("second-quote");
  });

  it("M1: a replaced anchor never keeps the old text (keyed on the anchor)", async () => {
    mount(viewerPath(OWNED));
    await col();
    await act(async () => opts.at(-1)?.onCommentSelect(sel("a-quote")));
    // Cleared box, new anchor.
    await act(async () => opts.at(-1)?.onCommentSelect(sel("b-quote")));
    expect(screen.getByRole("textbox", { name: "Add a comment" })).toHaveValue(
      "",
    );
    expect(screen.queryByText("a-quote")).toBeNull();
  });

  const threadAt = (
    id: string,
    kind: "note" | "text",
    v: number,
    body: string,
  ) => ({
    id,
    anchor:
      kind === "note"
        ? { kind: "note" }
        : {
            kind: "text",
            version: v,
            exact: `q-${id}`,
            prefix: "",
            suffix: "",
          },
    version: v,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-11-05T10:00:00Z",
    comments: [
      {
        id: `c-${id}`,
        body,
        author: { kind: "user", name: "Sam", me: false },
        createdAt: "2026-11-05T10:00:00Z",
        editedAt: null,
        can: { edit: false, delete: false },
      },
    ],
  });

  it("M2: on an older version, whole-page notes still show, text threads are that version's, and the note composer doesn't claim a version", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json({
          threads: [
            threadAt("n2", "note", 2, "note made on current"),
            threadAt("t2", "text", 2, "text made on current"),
            threadAt("t1", "text", 1, "text made on one"),
          ],
          open: 3,
          truncated: false,
        }),
      ),
    );
    mount(viewerPath(OWNED, 1));
    const c = await col();
    expect(
      await within(c).findByText("note made on current"),
    ).toBeInTheDocument();
    expect(within(c).getByText("text made on one")).toBeInTheDocument();
    expect(within(c).queryByText("text made on current")).toBeNull();
    expect(within(c).queryByText(/You're commenting on version/)).toBeNull();
    // A text draft is version-bound and says so.
    await act(async () => opts.at(-1)?.onCommentSelect(sel("zz")));
    expect(
      await within(c).findByText("You're commenting on version 1."),
    ).toBeInTheDocument();
  });

  it("#1529: relative times carry the full date, the agent reads 'via', and the column count follows the version", async () => {
    const t = (id: string, v: number, agent?: string) => ({
      ...threadAt(id, "text", v, `body ${id}`),
      comments: [
        {
          ...threadAt(id, "text", v, `body ${id}`).comments[0],
          author: {
            kind: "user",
            name: "Sam",
            me: false,
            ...(agent ? { agent } : {}),
          },
        },
      ],
    });
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json({
          threads: [
            t("a", 1, "Claude Code"),
            t("b", 1, "via Cursor"),
            t("c", 2),
          ],
          open: 3,
          truncated: false,
        }),
      ),
    );
    mount(viewerPath(OWNED, 1));
    const c = await col();
    await within(c).findByText("body a");
    expect(within(c).getByText("via Claude Code")).toBeInTheDocument();
    expect(within(c).getByText("via Cursor")).toBeInTheDocument();
    expect(within(c).queryByText("via via Cursor")).toBeNull();
    // Two threads were made on version 1; the artifact has three. The toolbar badge follows the column.
    expect(within(c).getByText("2 open")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Comments, 2 open/ }),
    ).toBeInTheDocument();
    const row = within(c)
      .getByText("body a")
      .closest("[data-thread]") as HTMLElement;
    const when = row.querySelector("span[title]") as HTMLElement;
    expect(when.getAttribute("title")).toMatch(/^November 5(, 2026)? at \d/);
    expect(when.textContent).not.toBe(when.getAttribute("title"));
    // The author line never wraps: the name and "via" truncate, the time stays put (jsdom has no layout).
    const line = when.parentElement as HTMLElement;
    expect(line.className).not.toMatch(/flex-wrap/);
    expect(when.className).toMatch(/whitespace-nowrap/);
    expect(when.className).toMatch(/shrink-0/);
    expect(line.querySelector("b")?.className).toMatch(/truncate/);
    // "via <agent>" sits on the name's line, small and muted.
    const via = within(c).getByText("via Claude Code");
    expect(line.contains(via)).toBe(true);
    expect(via.className).toMatch(/text-muted-foreground/);
    expect(via.className).toMatch(/truncate/);
    // An initials avatar leads the name.
    expect(row.querySelector("[data-avatar]")).not.toBeNull();
  });

  const art = (over: object) =>
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === OWNED),
          ...over,
        }),
      ),
    );
  it.each([
    [
      { visibility: "public", dataWriters: "viewers" },
      /Anyone with the link can comment/,
    ],
    [
      // Public is enough: signed-out visitors can comment on public artifacts.
      { visibility: "public", dataWriters: "editors" },
      /Anyone with the link can comment/,
    ],
    [
      { visibility: "team", dataWriters: "viewers" },
      /People who can open this can comment on it\./,
    ],
  ])("M3: the Share hint for %j", async (over, hint) => {
    art(over);
    mount(`${viewerPath(OWNED)}?panel=open&tab=share`);
    await screen.findByRole("checkbox", { name: "Comments" });
    expect(await screen.findByText(hint)).toBeInTheDocument();
  });

  it("M5: only a minting write takes the mint lock; reads and other writes never do", async () => {
    // Fresh modules: an earlier test's in-memory token would skip the lock.
    vi.resetModules();
    const { withAnon } = await import("../src/api/comments");
    const { MINT_LOCK, loadAnonToken } = await import("../src/viewer/anonId");
    localStorage.clear();
    const request = vi.fn(
      (_n: string, _o: unknown, cb: () => Promise<unknown>) => cb(),
    );
    Object.defineProperty(navigator, "locks", {
      value: { request },
      configurable: true,
    });
    try {
      expect(loadAnonToken()).toBeNull();
      await withAnon(true, false, async () => "read");
      expect(request).not.toHaveBeenCalled();
      await withAnon(true, true, async () => "post");
      expect(request.mock.calls[0]?.[0]).toBe(MINT_LOCK);
      // Signed in: never.
      request.mockClear();
      await withAnon(false, true, async () => "post");
      expect(request).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  const cannot = () =>
    art({
      can: {
        edit: true,
        share: true,
        setVisibility: true,
        delete: true,
        transfer: false,
        move: false,
        dataWrite: true,
        comment: false,
      },
    });
  it("M6: a signed-in viewer who can't comment sees no sign-in line, no composer, and no draft from the frame", async () => {
    cannot();
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Can we tighten this headline?");
    expect(within(c).queryByText("Sign in to comment.")).toBeNull();
    expect(within(c).queryByRole("textbox")).toBeNull();
    expect(within(c).queryByRole("button", { name: "Resolve" })).toBeNull();
    await act(async () => opts.at(-1)?.onCommentSelect(sel("nope")));
    expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  });

  it("#1491: a viewer who can't comment puts the frame in view mode, and gets the plain empty state", async () => {
    cannot();
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json({ threads: [], open: 0, truncated: false }),
      ),
    );
    mount(viewerPath(OWNED));
    await hello();
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith("view"));
    expect(setMode).not.toHaveBeenCalledWith("select");
    // The column is open by default where it has room.
    const c = await col();
    expect(await within(c).findByText("No comments yet.")).toBeInTheDocument();
    expect(within(c).queryByText(/Select text to add one/)).toBeNull();
  });
});

describe("comments: capped members", () => {
  const capped = (cap: string | null) =>
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json({
          ...fixtures.me,
          auth: {
            method: "dev",
            readOnly: cap !== null,
            cap,
            expiresAt: null,
          },
        }),
      ),
    );
  const refused = () =>
    server.use(
      http.post("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
  const write = async () => {
    const c = await col();
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    return c;
  };

  it("a capped member sees the threads but gets no composer, no Resolve, no draft and no sign-in line", async () => {
    capped("guest");
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByText("Can we tighten this headline?"),
    ).toBeInTheDocument();
    expect(within(c).queryByRole("textbox")).toBeNull();
    expect(within(c).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(within(c).queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(within(c).queryByText("Sign in to comment.")).toBeNull();
    await act(async () =>
      opts.at(-1)?.onCommentSelect({
        kind: "text",
        exact: "nope",
        prefix: "",
        suffix: "",
      }),
    );
    expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  });

  it("an uncapped member in the same setup does get the composer", async () => {
    capped(null);
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByRole("textbox", {
        name: "Comment on the whole page",
      }),
    ).toBeInTheDocument();
  });

  it("a refused write from a capped member still reads as read-only (fallback copy)", async () => {
    const { ApiClientError } = await import("../src/api/client");
    const { commentError } = await import("../src/api/comments");
    const e = new ApiClientError("not_found", "Not found", 404);
    expect(commentError(e, true)).toBe(
      "Your account can only view, so you can't comment.",
    );
    expect(commentError(e, false)).toBe("That comment is gone.");
  });

  it("an uncapped 404 still says the comment is gone", async () => {
    capped(null);
    refused();
    mount(viewerPath(OWNED));
    const c = await write();
    expect(
      await within(c).findByText("That comment is gone."),
    ).toBeInTheDocument();
  });
});

describe("comments: a server without comments", () => {
  const commentsCalls = () => {
    const all = calls("GET");
    return () => all.filter((c) => c.path.endsWith("/comments"));
  };

  it("an artifact with no `comments` field (a server older than the routes): no request, no button, no column, no Share toggle", async () => {
    const reqs = commentsCalls();
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () => {
        const { comments: _omit, ...rest } = fixtures.artifacts.find(
          (a) => a.id === OWNED,
        ) as Record<string, unknown>;
        return HttpResponse.json(rest);
      }),
    );
    mount(`${viewerPath(OWNED)}?panel=open&tab=share`);
    await screen.findByRole("tab", { name: "Share" });
    await wait(100);
    expect(reqs()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Comments" })).toBeNull();
    expect(setMode).not.toHaveBeenCalledWith("select");
  });

  it("a 404 on the list means unavailable: asked once, then no button, column, badge or error", async () => {
    const reqs = commentsCalls();
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: "More actions" });
    await waitFor(() => expect(reqs().length).toBeGreaterThan(0));
    await wait(150);
    expect(reqs()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Couldn't load comments.")).toBeNull();
  });
});

describe("comments: unavailable is not forever", () => {
  const list = (threads: object[]) =>
    HttpResponse.json({ threads, open: threads.length, truncated: false });

  it("comments_off, then the owner turns comments on, then the list loads: the button and column come back without a remount", async () => {
    let off = true;
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () =>
        off
          ? HttpResponse.json(
              { error: { code: "comments_off", message: "off" } },
              { status: 403 },
            )
          : list([oneThread]),
      ),
    );
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: "More actions" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull(),
    );
    // Owner turns comments on: the list answers, and a comments event arrives.
    off = false;
    await waitFor(() => expect(events.connections(OWNED)).toBe(1));
    await act(async () => {
      events.emitComments(OWNED, 1);
    });
    const btn = await screen.findByRole("button", { name: "Comments, 1 open" });
    // L-r6-3: the visible label keeps its space, inside the name.
    expect(btn.textContent).toBe("Comments 1");
    expect(await col()).toBeInTheDocument();
  });

  it("the summary refetching with comments: true (after false) re-enables the list", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/comments", () => list([oneThread])),
    );
    const a = fixtures.artifacts.find((x) => x.id === OWNED);
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({ ...a, comments: false }),
      ),
    );
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: "More actions" });
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({ ...a, comments: true }),
      ),
    );
    await act(async () => {
      await lastClient.invalidateQueries({ queryKey: ["artifact", OWNED] });
    });
    expect(
      await screen.findByRole("button", { name: "Comments, 1 open" }),
    ).toBeInTheDocument();
  });

  const noComments = () =>
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () => {
        const { comments: _omit, ...rest } = fixtures.artifacts.find(
          (a) => a.id === OWNED,
        ) as Record<string, unknown>;
        return HttpResponse.json(rest);
      }),
    );

  it("L-r6-2: with no comments on a server, ?tab=comments falls back to Versions, and a guest's ?panel=open shows no empty panel", async () => {
    noComments();
    mount(`${viewerPath(OWNED)}?panel=open&tab=comments`);
    const tab = await screen.findByRole("tab", { name: "Versions" });
    expect(tab).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("tab", { name: "Comments" })).toBeNull();
  });

  it("L-r6-2: a signed-out visitor with ?panel=open and no comments gets no side panel", async () => {
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "no" } },
          { status: 401 },
        ),
      ),
      http.get(`*${R.artifact(PUBLIC)}`, () => {
        const { comments: _omit, ...rest } = fixtures.artifacts.find(
          (a) => a.id === PUBLIC,
        ) as Record<string, unknown>;
        return HttpResponse.json({ ...rest, visibility: "public" });
      }),
    );
    mount(`${viewerPath(PUBLIC)}?panel=open`);
    await waitFor(() =>
      expect(document.querySelector("iframe")).not.toBeNull(),
    );
    await wait(150);
    expect(
      screen.queryByRole("complementary", { name: "Side panel" }),
    ).toBeNull();
    expect(document.querySelector("aside[aria-label='Side panel']")).toBeNull();
  });
});

describe("initials", () => {
  it("keeps emoji and CJK characters whole", async () => {
    const { initials } = await import("../src/viewer/comments/CommentsBody");
    expect(initials("😀 Robot")).toBe("😀R");
    expect(initials("😀")).toBe("😀");
    expect(initials("山田 太郎")).toBe("山太");
    expect(initials("Sam Rivera")).toBe("SR");
    expect(initials("cursor")).toBe("CU");
  });
});
