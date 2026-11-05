import { ANON_ID_HEADER, R, viewerPath } from "@oa/shared";
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
import {
  calls,
  events,
  installHarness,
  lastClient,
  mount,
  server,
  wait,
} from "./harness";

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
    expect(
      within(card).getByText(/Resolved by Sam Rivera/),
    ).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
    const c = await col();
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
    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
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

  it("a fresh guest's Resolve mints too: it goes under the lock and stores the returned token", async () => {
    guestMocks();
    const seen: (string | null)[] = [];
    server.use(
      http.get(`*${R.comments(PUBLIC)}`, () =>
        HttpResponse.json({ threads: [oneThread], open: 1, truncated: false }),
      ),
      http.patch("*/api/v1/artifacts/:id/comments/:tid", ({ request }) => {
        seen.push(request.headers.get(ANON_ID_HEADER));
        return HttpResponse.json(
          { ...oneThread, status: "resolved" },
          { headers: { [ANON_ID_HEADER]: TOKEN } },
        );
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
      expect(request.mock.calls.some((c) => c[0] === "oa.anonId.mint")).toBe(
        true,
      );
      await waitFor(() =>
        expect(localStorage.getItem("oa.anonId")).toBe(TOKEN),
      );
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
});
