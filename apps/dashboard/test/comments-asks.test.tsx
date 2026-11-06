import { R, viewerPath } from "@oa/shared";
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

const PUBLIC = (
  fixtures.artifacts.find((a) => a.title === "Q4 report") as { id: string }
).id;

/** A viewport: matchMedia answers the two breakpoints the comments layout uses. */
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
const col = () => screen.findByRole("complementary", { name: "Comments" });
const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;

const askThread = (over: object = {}, askOver: object = {}) => ({
  id: "t-ask",
  anchor: { kind: "note" },
  version: 1,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-11-05T10:00:00Z",
  comments: [
    {
      id: "c-ask",
      body: "Which layout?",
      author: {
        kind: "user",
        id: "owner",
        name: "Leo",
        agent: "OA Product",
        me: false,
      },
      createdAt: "2026-11-05T10:00:00Z",
      editedAt: null,
      can: { edit: false, delete: false },
      ask: {
        question: "Which layout?",
        options: [
          { id: "a", label: "List only", detail: "Detail on its own screen" },
          { id: "b", label: "Side by side" },
        ],
        recommended: { optionId: "b", why: "Both stay in view." },
        to: [{ kind: "user", id: "me", name: "Me", me: true }],
        closed: false,
        ...askOver,
      },
    },
  ],
  ...over,
});

const serveThreads = (get: () => unknown[]) =>
  server.use(
    http.get(`*${R.comments(OWNED)}`, () =>
      HttpResponse.json({
        threads: get(),
        open: get().length,
        truncated: false,
      }),
    ),
  );

beforeEach(() => {
  opts.length = 0;
  viewport(1280);
});
afterEach(() => vi.restoreAllMocks());

describe("asks on the comments column", () => {
  it("shows the question, options, recommendation and why, and answers with the option id", async () => {
    let answered: unknown = null;
    serveThreads(() => [
      askThread(
        {},
        answered
          ? {
              answer: {
                optionId: "a",
                by: { kind: "user", id: "me", name: "Me", me: true },
                at: "2026-11-05T11:00:00Z",
              },
            }
          : {},
      ),
    ]);
    server.use(
      http.post(
        `*${R.commentAnswer(OWNED, "t-ask", "c-ask")}`,
        async ({ request }) => {
          answered = await request.json();
          return HttpResponse.json({});
        },
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    expect(await within(c).findByText("Which layout?")).toBeInTheDocument();
    expect(within(c).getByText("Detail on its own screen")).toBeInTheDocument();
    expect(within(c).getByText("Recommended")).toBeInTheDocument();
    expect(within(c).getByText("Why: Both stay in view.")).toBeInTheDocument();
    expect(within(c).getByText(/1 ask for you/)).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: /List only/ }));
    await waitFor(() => expect(answered).toEqual({ optionId: "a" }));
    expect(
      await within(c).findByText(/You picked List only/),
    ).toBeInTheDocument();
  });

  it("gives someone it isn't addressed to no answer buttons", async () => {
    serveThreads(() => [
      askThread(
        {},
        { to: [{ kind: "user", id: "x", name: "Sam", me: false }] },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Which layout?");
    expect(within(c).getByRole("button", { name: /List only/ })).toBeDisabled();
    expect(
      within(c).getByText("Only the people asked can answer."),
    ).toBeInTheDocument();
  });

  it.each([
    [409, "The agent already closed this ask, so it can't be changed."],
    [403, "Only the people this ask is addressed to can answer."],
    [
      400,
      "That option isn't on this ask any more. Reload to see the current ones.",
    ],
  ])("explains a %i in plain words", async (status, copy) => {
    serveThreads(() => [askThread()]);
    server.use(
      http.post(
        `*${R.commentAnswer(OWNED, "t-ask", "c-ask")}`,
        () => new HttpResponse(null, { status }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Side by side/ }),
    );
    expect(await within(c).findByRole("alert")).toHaveTextContent(copy);
  });

  it("collapses a decided, closed ask to one line that can be opened again", async () => {
    serveThreads(() => [
      askThread(
        { status: "resolved" },
        {
          closed: true,
          answer: {
            optionId: "b",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
          },
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Show resolved/ }),
    );
    expect(
      await within(c).findByText(/Which layout\?: Side by side/),
    ).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: /List only/ })).toBeNull();
    fireEvent.click(within(c).getByRole("button", { name: "Show" }));
    expect(within(c).getByRole("button", { name: /List only/ })).toBeDisabled();
  });
});

describe("@mentions in the composer", () => {
  it("opens a picker on @, sends the picked key, and shows delivery in plain words", async () => {
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () =>
        HttpResponse.json([
          { key: "agent:product", name: "OA Product", online: true },
          { key: "agent:design", name: "OA Design", online: false },
        ]),
      ),
    );
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "@OA D", selectionStart: 5 } });
    const menu = await within(c).findByRole("listbox", {
      name: "Agents on this page",
    });
    const opt = within(menu).getByRole("option", { name: /OA Design/ });
    expect(
      within(menu).queryByRole("option", { name: /OA Product/ }),
    ).toBeNull();
    expect(opt).toHaveTextContent("offline");
    fireEvent.click(opt);
    expect(box).toHaveValue("@OA Design ");
    fireEvent.change(box, { target: { value: "@OA Design why B?" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]?.body).toMatchObject({
      anchor: { kind: "note" },
      body: "@OA Design why B?",
      mentions: [{ key: "agent:design" }],
    });
  });

  it("renders each mention's delivery and the assignment", async () => {
    const t = askThread();
    const root = t.comments[0] as Record<string, unknown>;
    delete root.ask;
    root.mentions = [
      { key: "agent:a", name: "OA Product", delivery: "queued" },
      { key: "agent:b", name: "OA Design", delivery: "seen" },
    ];
    root.assigned = { key: "agent:a", name: "OA Product", state: "done" };
    serveThreads(() => [t]);
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByText(/offline · will get this when it's back/),
    ).toBeInTheDocument();
    expect(within(c).getByText(/Seen/)).toBeInTheDocument();
    expect(within(c).getByText(/Assigned to/)).toHaveTextContent("Done");
  });
});
