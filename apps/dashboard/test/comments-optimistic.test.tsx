// A post shows at once and rolls back on error; removing an agent too.
import type { Comment, CommentList, CommentThread } from "@oa/shared";
import { R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  configure,
  fireEvent,
  getConfig,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
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
import { commentsKey, overlayPending, useAnswerAsk } from "../src/api/comments";
import { events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: { iframe: HTMLIFrameElement; url: string }) => {
      loadArtifactFrame(o.iframe, o.url);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
        scrollTo: () => {},
        setCommentsMode: vi.fn(),
        setComments: vi.fn(),
        focusComment: vi.fn(),
        commentOnSelection: vi.fn(),
      };
    },
  };
});

installHarness();
const defaultAsyncTimeout = getConfig().asyncUtilTimeout;
beforeAll(() => configure({ asyncUtilTimeout: FIRST_LOAD_MS }));
afterAll(() => configure({ asyncUtilTimeout: defaultAsyncTimeout }));

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;

beforeEach(() => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === "(min-width: 960px)",
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => vi.restoreAllMocks());

const col = async () => {
  const b = await screen.findByRole("button", { name: /^Comments/ });
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  return screen.findByRole("complementary", { name: "Comments" });
};

const mine = (id: string, body: string): Comment => ({
  id,
  body,
  author: { kind: "user", id: "u1", name: "Leo", me: true },
  createdAt: "2026-11-12T10:00:00Z",
  editedAt: null,
  typed: true,
  can: { edit: true, delete: true },
});
const note = (id: string, comments: Comment[]): CommentThread => ({
  id,
  anchor: { kind: "note" },
  version: 1,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-11-12T10:00:00Z",
  comments,
});
const list = (threads: CommentThread[]): CommentList => ({
  threads,
  open: threads.length,
  truncated: false,
});

const send = async (c: HTMLElement, text: string) => {
  const box = within(c).getByRole("textbox", {
    name: "Comment on the whole page",
  });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  return box;
};

describe("posting shows at once (user request)", () => {
  it("shows the comment and clears the box before the server answers, then swaps in the server comment once", async () => {
    let threads: CommentThread[] = [];
    server.use(
      http.get(`*${R.comments(OWNED)}`, () => HttpResponse.json(list(threads))),
      http.post(`*${R.comments(OWNED)}`, async () => {
        await delay(400);
        const t = note("srv1", [mine("srv1c", "Hello there")]);
        threads = [t];
        return HttpResponse.json(t, { status: 201 });
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await send(c, "Hello there");
    // At once: shown, marked sending, and the box is empty.
    const row = await within(c).findByText("Hello there");
    expect(row.closest("[data-comment]")).toHaveAttribute("data-sending");
    expect(box).toHaveValue("");
    // Then the server's comment, still exactly one.
    await waitFor(() =>
      expect(c.querySelector("[data-comment='srv1c']")).not.toBeNull(),
    );
    expect(within(c).getAllByText("Hello there")).toHaveLength(1);
    expect(c.querySelector("[data-sending]")).toBeNull();
  });

  it("does not show it twice when a refetch carries the comment before the post answers", async () => {
    const t = note("srv1", [mine("srv1c", "Once only")]);
    let landed = false;
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json(list(landed ? [t] : [])),
      ),
      http.post(`*${R.comments(OWNED)}`, async () => {
        landed = true;
        await delay(500);
        return HttpResponse.json(t, { status: 201 });
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    await send(c, "Once only");
    await within(c).findByText("Once only");
    // A live event's refetch lands while the post is in flight.
    await waitFor(() => expect(events.connections(OWNED)).toBeGreaterThan(0));
    await act(async () => {
      events.emitComments(OWNED, 9);
    });
    // The refetch carried it: still one row while the post is out.
    await waitFor(() =>
      expect(c.querySelector("[data-comment='srv1c']")).not.toBeNull(),
    );
    expect(within(c).getAllByText("Once only")).toHaveLength(1);
    expect(c.querySelector("[data-sending]")).toBeNull();
    // Let the post answer too: still one row, and nothing left pending.
    await new Promise((r) => setTimeout(r, 650));
    expect(within(c).getAllByText("Once only")).toHaveLength(1);
    await waitFor(() =>
      expect(c.querySelector("[data-comment='srv1c']")).not.toBeNull(),
    );
    expect(within(c).getAllByText("Once only")).toHaveLength(1);
  });

  it("rolls back on an error and puts the text back with the error line", async () => {
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json(
          list([
            note("t0", [
              {
                ...mine("c0", "Earlier"),
                author: { kind: "guest", name: "Pat", me: false },
              },
            ]),
          ]),
        ),
      ),
      http.post(`*${R.comments(OWNED)}`, async () => {
        await delay(150);
        return HttpResponse.json(
          { error: { code: "rate_limited", message: "x" } },
          { status: 429 },
        );
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await send(c, "keep me");
    await within(c).findByText("Too many comments. Try again in a minute.");
    expect(box).toHaveValue("keep me");
    expect(c.querySelectorAll("[data-comment]")).toHaveLength(1);
  });

  it("comments_off rolls back too", async () => {
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json(
          list([
            note("t0", [
              {
                ...mine("c0", "Earlier"),
                author: { kind: "guest", name: "Pat", me: false },
              },
            ]),
          ]),
        ),
      ),
      http.post(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json(
          { error: { code: "comments_off", message: "x" } },
          { status: 403 },
        ),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await send(c, "nope");
    await within(c).findByText("Comments are off for this page.");
    expect(box).toHaveValue("nope");
  });
});

describe("overlayPending", () => {
  const pend = (thread: string | null, body: string, known: string[]) => ({
    tmp: `tmp-${body}`,
    thread,
    comment: {
      ...mine(`tmp-${body}`, body),
      can: { edit: false, delete: false },
    },
    tmpThread: thread === null ? note(`tmp-t-${body}`, []) : undefined,
    known: new Set(known),
  });
  it("adds a pending reply after the thread's comments", () => {
    const data = list([note("t1", [mine("c1", "root")])]);
    const out = overlayPending(data, [pend("t1", "hi", ["t1", "c1"])]);
    expect(out.threads[0]?.comments.map((c) => c.body)).toEqual(["root", "hi"]);
  });
  it("drops a pending reply once the list carries it, never both", () => {
    const data = list([note("t1", [mine("c1", "root"), mine("c2", "hi")])]);
    const out = overlayPending(data, [pend("t1", "hi", ["t1", "c1"])]);
    expect(out).toBe(data);
  });
  it("two posts with the same words stay two until each is carried", () => {
    const data = list([note("t1", [mine("c1", "root"), mine("c2", "same")])]);
    const out = overlayPending(data, [
      pend("t1", "same", ["t1", "c1"]),
      { ...pend("t1", "same", ["t1", "c1"]), tmp: "tmp-b" },
    ]);
    expect(out.threads[0]?.comments).toHaveLength(3);
  });
  it("a new thread is laid over the list and counted open", () => {
    const out = overlayPending(list([]), [pend(null, "new", [])]);
    expect(out.threads).toHaveLength(1);
    expect(out.open).toBe(1);
  });
});

describe("picking an option on an ask shows at once", () => {
  const answerPath = `*${R.commentAnswer(OWNED, "t-ask", "c-ask")}`;
  const pick = (optionId: string, by = "me", yes = true) => ({
    optionId,
    by: {
      kind: "user" as const,
      id: by,
      name: by === "me" ? "Me" : "Sam",
      me: by === "me",
    },
    at: "2026-11-12T11:00:00Z",
    typed: true,
    yes,
  });
  const ask = (
    answer?: ReturnType<typeof pick>,
    extra = {},
  ): CommentThread => ({
    ...note("t-ask", [
      {
        ...mine("c-ask", "Which layout?"),
        author: { kind: "agent", id: "u1", name: "OA Product", me: false },
        can: { edit: false, delete: false },
        ask: {
          question: "Which layout?",
          options: [
            { id: "a", label: "List only" },
            { id: "b", label: "Side by side" },
          ],
          to: [{ kind: "user", id: "me", name: "Me", me: true }],
          closed: false,
          ...(answer ? { answer } : {}),
          ...extra,
        },
      },
    ]),
  });
  const serve = (get: () => CommentThread) =>
    server.use(
      http.get(`*${R.comments(OWNED)}`, () => HttpResponse.json(list([get()]))),
    );
  const opt = (c: HTMLElement, id: string) =>
    c.querySelector<HTMLButtonElement>(
      `[data-option="${id}"]`,
    ) as HTMLButtonElement;

  it("shows the pick before the server answers, then settles to its record", async () => {
    let answer: ReturnType<typeof pick> | undefined;
    serve(() => ask(answer));
    server.use(
      http.post(answerPath, async () => {
        await delay(400);
        answer = pick("a");
        return HttpResponse.json({});
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /List only/ }),
    );
    // Sending: the option is marked, but it does not read as answered yet.
    await waitFor(() =>
      expect(opt(c, "a")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(within(c).queryByText(/You picked/)).toBeNull();
    expect(
      c.querySelector("[data-ask] [data-sending]") ??
        c.querySelector("ul[data-sending]"),
    ).not.toBeNull();
    await waitFor(() => expect(c.querySelector("ul[data-sending]")).toBeNull());
    expect(await within(c).findAllByText(/You picked A/)).toHaveLength(1);
  });

  it("rolls back to unanswered on an error, shows the error and focuses the option", async () => {
    serve(() => ask());
    server.use(
      http.post(answerPath, async () => {
        await delay(150);
        return new HttpResponse(null, { status: 500 });
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Side by side/ }),
    );
    expect(await within(c).findByRole("alert")).toHaveTextContent(
      "Couldn't send your answer. Try again.",
    );
    expect(within(c).queryByText(/You picked/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opt(c, "b")));
  });

  it("a 409 shows the answer the server has, not ours", async () => {
    let answer: ReturnType<typeof pick> | undefined;
    serve(() => ask(answer));
    server.use(
      http.post(answerPath, async () => {
        await delay(100);
        answer = pick("a", "sam", false);
        return new HttpResponse(null, { status: 409 });
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Side by side/ }),
    );
    await within(c).findByText(/Sam picked A/);
    expect(within(c).queryByText(/picked B/)).toBeNull();
  });

  it("an ask with confirm is never optimistic (the cache stays as the server has it)", async () => {
    // The schema does not carry `confirm` yet (#2263), so seed the cache directly.
    const qc = new QueryClient();
    qc.setQueryData(
      commentsKey(OWNED),
      list([ask(undefined, { confirm: "passkey" })]),
    );
    server.use(
      http.post(answerPath, async () => {
        await delay(300);
        return HttpResponse.json({});
      }),
    );
    const { result } = renderHook(() => useAnswerAsk(OWNED), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    act(() => {
      result.current.mutate({
        thread: "t-ask",
        comment: "c-ask",
        optionId: "a",
      });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    const cached = qc.getQueryData<CommentList>(commentsKey(OWNED));
    expect(cached?.threads[0]?.comments[0]?.ask?.answer).toBeUndefined();
  });
});
