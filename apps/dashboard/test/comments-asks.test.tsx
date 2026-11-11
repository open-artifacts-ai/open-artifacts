import { type ArtifactAgent, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  getConfig,
  render,
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
  actor,
  MentionMenu,
  matchAgents,
  mentionedKeys,
  mentionQuery,
  nextAskFor,
  removeMention,
} from "../src/viewer/comments/asks";
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
const hello = () =>
  act(async () => {
    await waitFor(() => expect(opts.length).toBeGreaterThan(0));
    opts.at(-1)?.onHello();
  });
/** The column starts closed (#1731): open it with the Comments button. */
const col = async () => {
  const b = await screen.findByRole("button", { name: /^Comments/ });
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  return screen.findByRole("complementary", { name: "Comments" });
};
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
      typed: false,
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
  it("links a URL in the question", async () => {
    serveThreads(() => [
      askThread({}, { question: "Which of https://a.com/x?" }),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    const a = await within(c).findByRole("link", { name: "https://a.com/x" });
    expect(a.getAttribute("href")).toBe("https://a.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
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
                typed: true,
                yes: true,
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
    expect(
      within(c).getByText("Why B: Both stay in view."),
    ).toBeInTheDocument();
    expect(within(c).getByText(/1 ask for you/)).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: /List only/ }));
    await waitFor(() => expect(answered).toEqual({ optionId: "a" }));
    expect(await within(c).findByText(/You picked A/)).toBeInTheDocument();
  });

  it("says who asks, amber while it needs you, with a key badge per option and a Recommended tag", async () => {
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Which layout?");
    expect(c.querySelector("[data-ask-from]")?.textContent).toMatch(
      / asks you$/,
    );
    expect(c.querySelector("[data-ask]")).toHaveAttribute("data-needs-you");
    const keys = [...c.querySelectorAll("[data-option-key]")].map(
      (k) => k.textContent,
    );
    expect(keys).toEqual(["A", "B"]);
    expect(
      within(c).getByRole("button", { name: /Side by side/ }),
    ).toHaveTextContent("Recommended");
    expect(
      within(c).getByRole("button", { name: /Side by side/ }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("shows letters on all options unless every id equals its label", async () => {
    serveThreads(() => [
      askThread(
        {},
        {
          options: [
            { id: "wide", label: "Wide layout" },
            { id: "compact", label: "Compact list" },
          ],
          recommended: undefined,
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Which layout?");
    const keys = [...c.querySelectorAll("[data-option-key]")].map(
      (k) => k.textContent,
    );
    expect(keys).toEqual(["A", "B"]);
  });

  it("shows no letters when every id equals its label", async () => {
    serveThreads(() => [
      askThread(
        {},
        {
          options: [
            { id: "yes", label: " Yes " },
            { id: "no", label: "No" },
          ],
          recommended: undefined,
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Which layout?");
    expect(c.querySelectorAll("[data-option-key]")).toHaveLength(0);
  });

  it("omits the letter from the decided line when it equals the label", async () => {
    serveThreads(() => [
      askThread(
        { status: "resolved" },
        {
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          recommended: undefined,
          closed: true,
          answer: {
            optionId: "yes",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Show resolved/ }),
    );
    const line = await within(c).findByRole("button", { name: /Show$/ });
    expect(line.textContent).toMatch(/^Which layout\? Yes · you, /);
  });

  it("drops the amber once you have picked", async () => {
    serveThreads(() => [
      askThread(
        {},
        {
          answer: {
            optionId: "b",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText(/You picked B/);
    expect(c.querySelector("[data-ask]")).not.toHaveAttribute("data-needs-you");
  });

  it("shows 'You picked B · time · Change' and Change reopens the options", async () => {
    serveThreads(() => [
      askThread(
        {},
        {
          answer: {
            optionId: "b",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    const side = await within(c).findByRole("button", { name: /Side by side/ });
    expect(side).toHaveAttribute("aria-pressed", "true");
    expect(within(c).getByText(/You picked B/)).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: /List only/ })).toBeDisabled();
    fireEvent.click(within(c).getByRole("button", { name: "Change" }));
    expect(within(c).getByRole("button", { name: /List only/ })).toBeEnabled();
  });

  it("Change, then another option, sends the new answer and locks again once it lands", async () => {
    let picked = "b";
    let sent: unknown;
    serveThreads(() => [
      askThread(
        {},
        {
          answer: {
            optionId: picked,
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
    ]);
    server.use(
      http.post(
        `*${R.commentAnswer(OWNED, "t-ask", "c-ask")}`,
        async ({ request }) => {
          sent = await request.json();
          picked = "a";
          return HttpResponse.json({});
        },
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText(/You picked B/);
    fireEvent.click(within(c).getByRole("button", { name: "Change" }));
    fireEvent.click(within(c).getByRole("button", { name: /List only/ }));
    await waitFor(() => expect(sent).toEqual({ optionId: "a" }));
    expect(await within(c).findByText(/You picked A/)).toBeInTheDocument();
    // The new answer ends Change mode: the others lock again.
    expect(
      within(c).getByRole("button", { name: /Side by side/ }),
    ).toBeDisabled();
    expect(
      within(c).getByRole("button", { name: "Change" }),
    ).toBeInTheDocument();
  });

  it("clears an answer error once the ask shows as answered from elsewhere", async () => {
    let answered = false;
    serveThreads(() => [
      askThread(
        {},
        answered
          ? {
              answer: {
                optionId: "a",
                by: { kind: "user", id: "me", name: "Me", me: true },
                at: "2026-11-05T11:00:00Z",
                typed: true,
                yes: true,
              },
            }
          : {},
      ),
    ]);
    server.use(
      http.post(
        `*${R.commentAnswer(OWNED, "t-ask", "c-ask")}`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Side by side/ }),
    );
    expect(await within(c).findByRole("alert")).toBeInTheDocument();
    answered = true;
    server.use(
      http.post(
        `*${R.commentAnswer(OWNED, "t-ask", "c-ask")}`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    // A refetch (here: a second failed tap's settle) now shows the ask answered.
    fireEvent.click(
      await within(c).findByRole("button", { name: /Side by side/ }),
    );
    await waitFor(() =>
      expect(within(c).getByText(/You picked A/)).toBeInTheDocument(),
    );
    await waitFor(() => expect(within(c).queryByRole("alert")).toBeNull());
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

  it("collapses a decided, closed ask to one line that toggles, with a reply link", async () => {
    serveThreads(() => [
      askThread(
        { status: "resolved" },
        {
          closed: true,
          answer: {
            optionId: "b",
            by: { kind: "user", id: "me", name: "Me", me: true },
            at: "2026-11-05T11:00:00Z",
            typed: true,
            yes: true,
          },
        },
      ),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: /Show resolved/ }),
    );
    const line = await within(c).findByRole("button", { name: /Show$/ });
    // The triangle is decoration: the name ends in "Show", not the glyph.
    expect(line).toHaveTextContent(/Which layout\? B, Side by side · you, .+/);
    // versionDate, not a 24-hour HH:MM.
    expect(line.textContent).not.toMatch(/\d\d:\d\d/);
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(within(c).queryByRole("button", { name: /List only/ })).toBeNull();
    fireEvent.click(line);
    expect(within(c).getByRole("button", { name: /List only/ })).toBeDisabled();
    expect(line).toHaveTextContent("Hide ▴");
    fireEvent.click(line);
    expect(within(c).queryByRole("button", { name: /List only/ })).toBeNull();
    fireEvent.click(
      within(c).getByRole("button", { name: "Reply to ask for a change" }),
    );
    expect(
      await within(c).findByRole("textbox", { name: "Reply" }),
    ).toBeInTheDocument();
  });

  it("Next ask goes to the following ask in page order, wrapping around", async () => {
    const mk = (id: string, anchor: object) => {
      const t = askThread({ id, anchor });
      (t.comments[0] as { id: string }).id = `c-${id}`;
      return t;
    };
    const text = (exact: string) => ({
      kind: "text",
      version: 1,
      exact,
      prefix: "",
      suffix: "",
    });
    // Created in the reverse of page order.
    const tText2 = mk("t2", text("two"));
    const tText1 = mk("t1", text("one"));
    const tNote = mk("n", { kind: "note" });
    serveThreads(() => [tText2, tText1, tNote]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findAllByText("Which layout?");
    await hello();
    await act(async () =>
      opts.at(-1)?.onCommentPositions([
        { id: "t1", state: "ok", top: 10 },
        { id: "t2", state: "ok", top: 50 },
      ]),
    );
    const next = async (id: string, to: string) => {
      const card = c.querySelector(`[data-thread="${id}"]`) as HTMLElement;
      fireEvent.click(within(card).getByRole("button", { name: /Next ask/ }));
      await waitFor(() =>
        expect(c.querySelector(`[data-thread="${to}"]`)).toHaveAttribute(
          "data-active",
        ),
      );
    };
    await next("n", "t1");
    await next("t1", "t2");
    await next("t2", "n");
  });

  it("says 'Text changed since this ask' on a partial ask anchor", async () => {
    const t = askThread({
      anchor: { kind: "text", version: 1, exact: "x", prefix: "", suffix: "" },
    });
    serveThreads(() => [t]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findAllByText("Which layout?");
    await hello();
    await act(async () =>
      opts
        .at(-1)
        ?.onCommentPositions([{ id: "t-ask", state: "partial", top: 5 }]),
    );
    expect(
      await within(c).findByText("Text changed since this ask"),
    ).toBeInTheDocument();
  });
});

describe("@mentions in the composer", () => {
  it("puts the caret right after a picked name at once (#1795)", async () => {
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () =>
        HttpResponse.json([
          { key: "agent:design", name: "OA Design", online: true },
        ]),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = (await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    })) as HTMLTextAreaElement;
    fireEvent.focus(box);
    // The reader typed "@OA D" in front of words already in the box.
    fireEvent.change(box, {
      target: { value: "@OA D tail", selectionStart: 5, selectionEnd: 5 },
    });
    const menu = await within(c).findByRole("listbox", {
      name: "Agents on this page",
    });
    fireEvent.mouseDown(
      within(menu).getByRole("option", { name: /OA Design/ }),
    );
    expect(box).toHaveValue("@OA Design  tail");
    // Not a frame later: keys typed right after the pick must land here.
    expect(box.selectionStart).toBe(11);
  });

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
    expect(opt.textContent).toBe("OA Design");
    fireEvent.mouseDown(opt);
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

  it("renders posted @names as chips, as text only", async () => {
    const t = askThread();
    const root = t.comments[0] as Record<string, unknown>;
    delete root.ask;
    root.body = "hi @C++ Bot and @OA Design. @OA Designer <b>x</b> @Bobby";
    root.mentions = [
      { key: "agent:c", name: "C++ Bot", delivery: "seen" },
      { key: "agent:b", name: "OA Design", delivery: "seen" },
    ];
    serveThreads(() => [t]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText(/hi/);
    const chips = [...c.querySelectorAll("[data-mention-chip]")].map(
      (e) => e.textContent,
    );
    expect(chips).toEqual(["@C++ Bot", "@OA Design"]);
    const p = c.querySelector("[data-mention-chip]")?.parentElement;
    expect(p?.textContent).toBe(
      "hi @C++ Bot and @OA Design. @OA Designer <b>x</b> @Bobby",
    );
    expect(p?.querySelector("b")).toBeNull();
  });

  it("renders a body without mentions as plain text", async () => {
    const t = askThread();
    const root = t.comments[0] as Record<string, unknown>;
    delete root.ask;
    root.body = "no @OA Design chip here";
    serveThreads(() => [t]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("no @OA Design chip here");
    expect(c.querySelector("[data-mention-chip]")).toBeNull();
  });

  it("renders each mention's delivery", async () => {
    const t = askThread();
    const root = t.comments[0] as Record<string, unknown>;
    delete root.ask;
    root.mentions = [
      { key: "agent:a", name: "OA Product", delivery: "queued" },
      { key: "agent:b", name: "OA Design", delivery: "seen" },
    ];
    serveThreads(() => [t]);
    mount(viewerPath(OWNED));
    const c = await col();
    expect(
      await within(c).findByText(
        /OA Product is offline · it will get this when it's back/,
      ),
    ).toBeInTheDocument();
    expect(
      within(c).getByText(
        "OA Product is offline · it will get this when it's back",
      ),
    ).toBeInTheDocument();
    expect(within(c).getByText("OA Design: Seen")).toBeInTheDocument();
    expect(within(c).queryByText(/Assigned to/)).toBeNull();
  });
});

const AGENTS = [
  { key: "agent:product", name: "OA Product", online: true },
  { key: "agent:design", name: "OA Design", online: false },
  { key: "agent:bo", name: "Bo", online: true },
  { key: "agent:bob", name: "Bob", online: true },
];
const withAgents = () =>
  server.use(
    http.get(`*${R.artifactAgents(OWNED)}`, () => HttpResponse.json(AGENTS)),
  );
const noteBox = async () => {
  const c = await col();
  const box = await within(c).findByRole("textbox", {
    name: "Comment on the whole page",
  });
  fireEvent.focus(box);
  // Wait for the agents to load: the picker only opens once they have.
  await waitFor(() => {
    fireEvent.change(box, { target: { value: "@" } });
    expect(within(c).queryByRole("listbox")).not.toBeNull();
  });
  fireEvent.change(box, { target: { value: "" } });
  return { c, box };
};

describe("the @ menu rows (per-session state, order, machine, selection)", () => {
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3600_000).toISOString();
  const MENU: ArtifactAgent[] = [
    {
      key: "a:away-b",
      name: "OA Backend",
      online: false,
      state: "away",
      lastActiveAt: hoursAgo(19),
      machine: "workstation",
    },
    {
      key: "a:mgr",
      name: "OA Manager",
      online: false,
      state: "away",
      lastActiveAt: hoursAgo(19),
      machine: "workstation",
    },
    {
      key: "a:mgr2",
      name: "OA Manager-2",
      online: true,
      state: "online",
      lastActiveAt: hoursAgo(0),
      machine: "laptop",
    },
    {
      key: "a:com",
      name: "OA Comments",
      online: true,
      state: "online",
      lastActiveAt: hoursAgo(0),
      machine: "laptop",
    },
  ];

  it("lists online before away, each alphabetical, and filters both", () => {
    expect(matchAgents(MENU, "oa")?.map((a) => a.name)).toEqual([
      "OA Comments",
      "OA Manager-2",
      "OA Backend",
      "OA Manager",
    ]);
    expect(matchAgents(MENU, "manager")?.map((a) => a.name)).toEqual([
      "OA Manager-2",
      "OA Manager",
    ]);
  });

  const open = (agents: ArtifactAgent[], active = 0) =>
    render(
      <MentionMenu
        id="m"
        matches={agents}
        all={agents}
        active={active}
        onPick={() => {}}
      />,
    );

  it("away reads 'away 19h' with a hollow dot, online reads 'online'", () => {
    open(matchAgents(MENU, "oa") ?? []);
    expect(
      screen.getByRole("option", { name: /OA Backend.*away 19h/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /OA Comments.*online(?! ·)/ }),
    ).toBeInTheDocument();
    const dots = screen
      .getAllByRole("option")
      .map((o) => o.querySelector("span[aria-hidden]")?.className ?? "");
    expect(dots[0]).toMatch(/bg-\[var\(--oa-success-fg/);
    expect(dots[2]).toMatch(/border/);
    expect(dots[2]).not.toMatch(/bg-\[var/);
  });

  it("adds the machine only on rows whose name stem repeats", () => {
    open(matchAgents(MENU, "oa") ?? []);
    expect(
      screen.getByRole("option", { name: /OA Manager-2.*online · laptop/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", {
        name: /OA Manager(?!-).*away 19h · workstation/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /OA Backend/ }).textContent,
    ).not.toMatch(/workstation/);
    expect(
      screen.getByRole("option", { name: /OA Comments/ }).textContent,
    ).not.toMatch(/laptop/);
  });

  it("another member's agent leads with its owner, shows state only, and no machine", () => {
    const theirs: ArtifactAgent[] = [
      {
        key: "t:1",
        name: "OA Manager (Sam)",
        online: true,
        state: "online",
        owner: "Sam",
        machine: null,
        lastActiveAt: null,
      },
      {
        key: "t:2",
        name: "OA Manager-2 (Sam)",
        online: false,
        state: "away",
        owner: "Sam",
        machine: null,
        lastActiveAt: null,
      },
      ...MENU,
    ];
    open(matchAgents(theirs, "oa") ?? []);
    const row = screen.getByRole("option", { name: /online · Sam's$/ });
    // The owner shows once, in the status: the row's name is the bare agent name.
    expect(row.querySelector("b")?.textContent).toBe("OA Manager");
    const away = screen.getByRole("option", { name: /away · Sam's$/ });
    expect(away.querySelector("b")?.textContent).toBe("OA Manager-2");
    expect(away.textContent).not.toMatch(/\d+[mhd]|laptop|workstation/);
    // A stem repeating only against someone else's agent adds no machine.
    expect(
      screen.getByRole("option", { name: /OA Comments/ }).textContent,
    ).not.toMatch(/laptop/);
  });

  it("an agent with no state (the bus did not answer) is a plain row: no dot, empty state, not dimmed, sorted last", () => {
    open([
      { key: "u:1", name: "OA Unknown", online: false },
      {
        key: "u:2",
        name: "OA Mine",
        online: false,
        state: "away",
        machine: "laptop",
        lastActiveAt: hoursAgo(3),
      },
      { key: "u:3", name: "OA Theirs (Sam)", online: false, owner: "Sam" },
    ]);
    const unknown = screen.getByRole("option", { name: /OA Unknown/ });
    expect(unknown.textContent).toBe("OA Unknown");
    expect(unknown.querySelector("span[aria-hidden]")).toBeNull();
    expect(unknown.querySelector("b")?.className).not.toMatch(/muted/);
    expect(screen.getByRole("option", { name: /OA Theirs/ }).textContent).toBe(
      "OA TheirsSam's",
    );
    expect(
      matchAgents(
        [
          { key: "u:1", name: "A Unknown", online: false },
          { key: "u:2", name: "B Away", online: false, state: "away" },
          { key: "u:3", name: "C Online", online: true, state: "online" },
        ],
        "",
      )?.map((a) => a.name),
    ).toEqual(["C Online", "B Away", "A Unknown"]);
    expect(
      screen.getByRole("option", { name: /OA Mine/ }).querySelector("b")
        ?.className,
    ).toMatch(/muted/);
    expect(
      screen.getByRole("option", { name: /OA Theirs/ }).textContent,
    ).not.toMatch(/away|online/);
  });

  it("the selected row has the accent bar and soft fill; hover does not", () => {
    open(matchAgents(MENU, "oa") ?? [], 1);
    const rows = screen.getAllByRole("option");
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
    for (const r of rows) {
      expect(r.className).toContain("border-l-[3px]");
      expect(r.className).toContain("border-transparent");
      expect(r.className).toContain("aria-selected:border-[var(--oa-accent)]");
      expect(r.className).toContain("aria-selected:bg-[var(--oa-accent-soft)]");
      expect(r.className).toContain("hover:bg-muted");
      expect(r.className).not.toContain("aria-selected:bg-muted");
    }
  });
});

describe("@ picker details", () => {
  it("closes after a pick and stays closed for the rest of the sentence", async () => {
    withAgents();
    mount(viewerPath(OWNED));
    const { c, box } = await noteBox();
    fireEvent.change(box, { target: { value: "@OA D" } });
    fireEvent.mouseDown(
      within(await within(c).findByRole("listbox")).getByRole("option", {
        name: /OA Design/,
      }),
    );
    expect(within(c).queryByRole("listbox")).toBeNull();
    // Typing on past the finished name does not bring back "No agent works...".
    fireEvent.change(box, { target: { value: "@OA Design please" } });
    expect(within(c).queryByRole("listbox")).toBeNull();
    expect(within(c).queryByText(/No agent works/)).toBeNull();
  });

  it("works from the keyboard: arrows move, Enter picks, Escape closes", async () => {
    withAgents();
    mount(viewerPath(OWNED));
    const { c, box } = await noteBox();
    fireEvent.change(box, { target: { value: "@OA" } });
    const menu = await within(c).findByRole("listbox");
    const opts = () => within(menu).getAllByRole("option");
    expect(opts()[0]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", opts()[0]?.id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(opts()[1]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", opts()[1]?.id);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("@OA Design ");
    expect(within(c).queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "@OA" } });
    await within(c).findByRole("listbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(c).queryByRole("listbox")).toBeNull();
    expect(box).toHaveValue("@OA");
  });

  it("mentions only whole @names after whitespace, longest first", async () => {
    withAgents();
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    const { c, box } = await noteBox();
    fireEvent.change(box, {
      target: { value: "@Bob look, mail me@Bo.com and ask @OA Product." },
    });
    // Close the menu the trailing text may open, then send.
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const sent = posts[0]?.body as { mentions: { key: string }[] };
    const keys = sent.mentions.map((m) => m.key).sort();
    expect(keys).toEqual(["agent:bob", "agent:product"]);
  });

  it("matches @Bob's and @Bob- as Bob, and the picker does not swallow them", async () => {
    const bob = {
      key: "agent:bob",
      name: "Bob",
      online: true,
    } as ArtifactAgent;
    expect(mentionedKeys("hi @Bob's idea", [bob])).toEqual(["agent:bob"]);
    expect(mentionedKeys("hi @Bob- ok", [bob])).toEqual(["agent:bob"]);
    expect(mentionedKeys("hi @Bobby", [bob])).toEqual([]);
    // A hyphen joined to more name is not Bob (review of #1763).
    expect(mentionedKeys("hi @Bob-Smith here", [bob])).toEqual([]);
    expect(mentionedKeys("hi @Bob.", [bob])).toEqual(["agent:bob"]);
    expect(mentionedKeys("mail me@Bob today", [bob])).toEqual([]);
    expect(mentionQuery("hi @Bob-")).toBe("Bob");
    expect(mentionQuery("hi @Bob's")).toBeNull();
    expect(mentionQuery("hi @OA Pro")).toBe("OA Pro");
  });

  it("refuses more mentions than a comment may carry, in plain words", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      key: `agent:n${i}`,
      name: `Ag${String.fromCharCode(65 + i)}`,
      online: true,
    }));
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () => HttpResponse.json(many)),
    );
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    await waitFor(() => {
      fireEvent.change(box, { target: { value: "@" } });
      expect(within(c).queryByRole("listbox")).not.toBeNull();
    });
    fireEvent.change(box, {
      target: { value: `${many.map((a) => `@${a.name}`).join(" ")} go` },
    });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    expect(await within(c).findByRole("alert")).toHaveTextContent(
      "Mention at most 10 agents in one comment.",
    );
    expect(posts).toHaveLength(0);
  });

  it("lists who will be notified and removes chips", async () => {
    withAgents();
    const posts = calls("POST");
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    await waitFor(() => {
      fireEvent.change(box, { target: { value: "@", selectionStart: 1 } });
      expect(within(c).getByRole("listbox")).toBeTruthy();
    });
    expect(within(c).queryByText(/Assign to/)).toBeNull();
    fireEvent.change(box, {
      target: { value: "@OA Design and @OA Product go", selectionStart: 29 },
    });
    expect(
      within(c).getByText("Will notify OA Product, OA Design"),
    ).toBeTruthy();
    fireEvent.click(
      within(c).getByRole("button", { name: "Remove mention of OA Product" }),
    );
    expect(box).toHaveValue("@OA Design and go");
    expect(within(c).getByText("Will notify OA Design")).toBeTruthy();
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const sent = posts[0]?.body as Record<string, unknown>;
    expect(sent.mentions).toEqual([{ key: "agent:design" }]);
    expect(sent).not.toHaveProperty("assign");
  });

  it("removes only the mentions mentionedKeys would count", () => {
    const bob = { key: "agent:bob", name: "Bob", online: true };
    const smith = { key: "agent:bs", name: "Bob Smith", online: true };
    const both = [bob, smith];
    expect(removeMention("hi @Bob and @Bob.", "Bob", both)).toBe("hi and.");
    expect(removeMention("hi @Bob.", "Bob", both)).toBe("hi.");
    expect(removeMention("@Bob @Bob x", "Bob", both)).toBe("x");
    expect(removeMention("a @Bob @Bob b", "Bob", both)).toBe("a b");
    const cpp = { key: "agent:cpp", name: "C++ Bot", online: true };
    expect(removeMention("go @C++ Bot now", "C++ Bot", [cpp])).toBe("go now");
    expect(removeMention("go @C++ Bot's way", "C++ Bot", [cpp])).toBe("go way");
    expect(removeMention("hi @Bob-x ok", "Bob", both)).toBe("hi @Bob-x ok");
    expect(removeMention("hi @Bob-Smith", "Bob", both)).toBe("hi @Bob-Smith");
    expect(removeMention("hi @Bob's idea", "Bob", both)).toBe("hi idea");
    expect(removeMention("hi @Bob Smith go", "Bob", both)).toBe(
      "hi @Bob Smith go",
    );
    expect(removeMention("hi @Bob Smith go", "Bob Smith", both)).toBe("hi go");
  });

  it("marks agents online or away in text; one with no state shows no dot or text", async () => {
    withAgents();
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "@OA", selectionStart: 3 } });
    const menu = await within(c).findByRole("listbox", {
      name: "Agents on this page",
    });
    expect(
      within(menu).getByRole("option", { name: /OA Product.*online/ }),
    ).toBeTruthy();
    expect(
      within(menu).getByRole("option", { name: /OA Design/ }).textContent,
    ).toBe("OA Design");
  });

  it("does not resend the answer already picked", async () => {
    serveThreads(() => [
      askThread(
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
    const c = await col();
    expect(
      await within(c).findByRole("button", { name: /List only/ }),
    ).toBeDisabled();
    expect(
      within(c).getByRole("button", { name: /Side by side/ }),
    ).toBeDisabled();
    fireEvent.click(within(c).getByRole("button", { name: "Change" }));
    expect(
      within(c).getByRole("button", { name: /Side by side/ }),
    ).toBeEnabled();
    expect(within(c).getByRole("button", { name: /List only/ })).toBeDisabled();
  });
});

describe("round 2", () => {
  it("keeps the menu while a longer name still fits ('@OA ' with OA and OA Design)", async () => {
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () =>
        HttpResponse.json([
          { key: "agent:oa", name: "OA", online: true },
          { key: "agent:oad", name: "OA Design", online: true },
        ]),
      ),
    );
    mount(viewerPath(OWNED));
    const { c, box } = await noteBox();
    fireEvent.change(box, { target: { value: "@OA " } });
    const menu = await within(c).findByRole("listbox");
    expect(
      within(menu).getByRole("option", { name: /OA Design/ }),
    ).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "@OA go" } });
    expect(within(c).queryByRole("listbox")).toBeNull();
  });

  it("does not pick on Shift+Enter or during IME composition", async () => {
    withAgents();
    mount(viewerPath(OWNED));
    const { c, box } = await noteBox();
    fireEvent.change(box, { target: { value: "@OA" } });
    await within(c).findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(box).toHaveValue("@OA");
    expect(within(c).getByRole("listbox")).toBeInTheDocument();
  });

  it("Next ask lands on an ask whose text is gone (an orphan)", async () => {
    const textAnchor = {
      kind: "text",
      version: 1,
      exact: "old words",
      prefix: "",
      suffix: "",
    };
    const t1 = askThread({ id: "t1" });
    const t2 = askThread({ id: "t2", anchor: textAnchor });
    (t1.comments[0] as { id: string }).id = "c1";
    (t2.comments[0] as { id: string }).id = "c2";
    serveThreads(() => [t1, t2]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findAllByText("Which layout?");
    await hello();
    await act(async () =>
      opts
        .at(-1)
        ?.onCommentPositions([{ id: "t2", state: "orphan", top: null }]),
    );
    await within(c).findByText("On earlier text");
    const first = c.querySelector('[data-thread="t1"]') as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: /Next ask/ }));
    await waitFor(() =>
      expect(c.querySelector('[data-thread="t2"]')).toHaveAttribute(
        "data-active",
      ),
    );
  });
});

describe("agent list loads on composer focus", () => {
  const agentCalls = () => {
    const n = { count: 0 };
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () => {
        n.count++;
        return HttpResponse.json(AGENTS);
      }),
    );
    return n;
  };
  const wholePage = async (c: HTMLElement) =>
    within(c).findByRole("textbox", { name: "Comment on the whole page" });

  it("makes no /agents call when the column opens", async () => {
    const n = agentCalls();
    mount(viewerPath(OWNED));
    const c = await col();
    await wholePage(c);
    await new Promise((r) => setTimeout(r, 50));
    expect(n.count).toBe(0);
  });

  it("calls once on focus for an owner", async () => {
    const n = agentCalls();
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await wholePage(c);
    fireEvent.focus(box);
    await waitFor(() => expect(n.count).toBe(1));
    fireEvent.blur(box);
    fireEvent.focus(box);
    expect(n.count).toBe(1);
  });

  it("hints at @ in the placeholder for those who can mention", async () => {
    serveThreads(() => [askThread({}, {})]);
    mount(viewerPath(OWNED));
    const c = await col();
    expect(await wholePage(c)).toHaveAttribute(
      "placeholder",
      "Add a comment. Type @ to mention an agent.",
    );
    fireEvent.click(await within(c).findByRole("button", { name: "Reply" }));
    expect(
      await within(c).findByRole("textbox", { name: "Reply" }),
    ).toHaveAttribute("placeholder", "Reply. Type @ to mention an agent.");
  });

  it("keeps the plain placeholder for a viewer", async () => {
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === OWNED),
          access: "viewer",
          can: {
            edit: false,
            share: false,
            setVisibility: false,
            delete: false,
            transfer: false,
            move: false,
            dataWrite: true,
            comment: true,
          },
        }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    expect(await wholePage(c)).toHaveAttribute(
      "placeholder",
      "Comment on the whole page",
    );
  });

  it("makes no call for a viewer who can't mention", async () => {
    const n = agentCalls();
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === OWNED),
          access: "viewer",
          can: {
            edit: false,
            share: false,
            setVisibility: false,
            delete: false,
            transfer: false,
            move: false,
            dataWrite: true,
            comment: true,
          },
        }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await wholePage(c);
    fireEvent.focus(box);
    await new Promise((r) => setTimeout(r, 50));
    expect(n.count).toBe(0);
  });

  it("retries a 5xx on the next focus but never a 404", async () => {
    let hits = 0;
    let status = 500;
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () => {
        hits++;
        return status === 200
          ? HttpResponse.json(AGENTS)
          : HttpResponse.json(
              { error: { code: "internal", message: "boom" } },
              { status },
            );
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await wholePage(c);
    fireEvent.focus(box);
    await waitFor(() => expect(hits).toBe(1));
    status = 200;
    fireEvent.blur(box);
    fireEvent.focus(box);
    await waitFor(() => expect(hits).toBe(2));
  });

  it("retries a 5xx on another composer's first focus", async () => {
    let hits = 0;
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () => {
        hits++;
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        );
      }),
    );
    serveThreads(() => [askThread({}, {})]);
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await wholePage(c);
    fireEvent.focus(box);
    await waitFor(() => expect(hits).toBe(1));
    fireEvent.click(await within(c).findByRole("button", { name: "Reply" }));
    const reply = await within(c).findByRole("textbox", { name: "Reply" });
    fireEvent.focus(reply);
    await waitFor(() => expect(hits).toBe(2));
  });

  it("does not refetch after a 404", async () => {
    let hits = 0;
    server.use(
      http.get(`*${R.artifactAgents(OWNED)}`, () => {
        hits++;
        return HttpResponse.json(
          { error: { code: "not_found", message: "no" } },
          { status: 404 },
        );
      }),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await wholePage(c);
    fireEvent.focus(box);
    await waitFor(() => expect(hits).toBe(1));
    fireEvent.blur(box);
    fireEvent.focus(box);
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(1);
  });
});

describe("round 3 copy", () => {
  it("shows the wake hint to a commenter who can't mention", async () => {
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({
          ...fixtures.artifacts.find((a) => a.id === OWNED),
          access: "viewer",
          can: {
            edit: false,
            share: false,
            setVisibility: false,
            delete: false,
            transfer: false,
            move: false,
            dataWrite: true,
            comment: true,
          },
        }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const box = await within(c).findByRole("textbox", {
      name: "Comment on the whole page",
    });
    fireEvent.focus(box);
    expect(within(c).queryByText(/can wake agents/)).toBeNull();
    fireEvent.change(box, { target: { value: "hi @Codex" } });
    expect(
      within(c).getByText("Only the owner and editors can wake agents."),
    ).toBeInTheDocument();
  });
});

describe("actor (#1789)", () => {
  it("never says you for the owner's agent, and tags agents", () => {
    expect(actor({ kind: "agent", name: "Cursor", me: true }, "You")).toBe(
      "Cursor (agent)",
    );
    expect(actor({ kind: "user", name: "Leo", me: true }, "You")).toBe("You");
    expect(actor({ kind: "user", name: "Ada", me: false }, "You")).toBe("Ada");
  });
});

describe("removeMention", () => {
  it("keeps the line break before a removed mention", () => {
    expect(removeMention("hi\n@Bob there", "Bob")).toBe("hi\n there");
  });
  it("removes every mention of the name", () => {
    expect(removeMention("@Bob hi @bob, ok", "Bob")).toBe("hi, ok");
  });
});

describe("asks for you in the toolbar and header (#1614)", () => {
  const mk = (id: string, answered = false) => {
    const t = askThread(
      { id },
      answered
        ? {
            answer: {
              optionId: "a",
              by: { kind: "user", id: "me", name: "Me", me: true },
              at: "2026-11-05T11:00:00Z",
              typed: true,
              yes: true,
            },
          }
        : {},
    );
    (t.comments[0] as { id: string }).id = `c-${id}`;
    return t;
  };
  const toolbar = () => screen.findByRole("button", { name: /asks? for you$/ });
  const active = () =>
    document
      .querySelector("[data-thread][data-active]")
      ?.getAttribute("data-thread");

  it("counts and pluralises", async () => {
    serveThreads(() => [mk("a")]);
    mount(viewerPath(OWNED));
    expect(await toolbar()).toHaveTextContent("1 ask for you");
  });

  it("is hidden when the page has no asks", async () => {
    serveThreads(() => [
      { ...mk("a"), comments: [{ ...mk("a").comments[0], ask: undefined }] },
    ]);
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: /^Comments/ });
    await wait(50);
    expect(screen.queryByText(/for you/)).not.toBeInTheDocument();
  });

  it("says 'No asks for you' once all are answered", async () => {
    serveThreads(() => [mk("a", true), mk("b", true)]);
    mount(viewerPath(OWNED));
    expect(await screen.findByText("No asks for you")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /asks? for you$/ }),
    ).not.toBeInTheDocument();
  });

  it("opens the comments at the thread a comment email links to (#1467)", async () => {
    const resolved = { ...mk("r"), status: "resolved" as const };
    serveThreads(() => [mk("a"), mk("b"), resolved]);
    const router = mount(`${viewerPath(OWNED)}?thread=b`);
    expect(router.state.location.searchStr).toContain("thread=b");
    await screen.findByRole("complementary", { name: "Comments" });
    await waitFor(() => expect(active()).toBe("b"));
    await waitFor(() =>
      expect(router.state.location.searchStr).not.toContain("thread="),
    );
    cleanup();
    serveThreads(() => [mk("a"), resolved]);
    mount(`${viewerPath(OWNED)}?thread=r`);
    await screen.findByRole("complementary", { name: "Comments" });
    await waitFor(() => expect(active()).toBe("r"));
  });

  it("a thread link opens the side panel on Comments in one navigation", async () => {
    serveThreads(() => [mk("a"), mk("b")]);
    const router = mount(
      `${viewerPath(OWNED)}?panel=open&tab=versions&thread=b`,
    );
    await waitFor(() => expect(active()).toBe("b"));
    await waitFor(() => {
      const q = router.state.location.searchStr;
      expect(q).not.toContain("thread=");
      expect(q).toContain("panel=open");
      expect(q).toContain("tab=comments");
    });
  });

  it("keeps a thread link while the list fails, and opens it once it loads", async () => {
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json(
          { error: { code: "internal", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    const router = mount(`${viewerPath(OWNED)}?thread=b`);
    await toolbar().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(router.state.location.searchStr).toContain("thread=b");
    serveThreads(() => [mk("a"), mk("b")]);
    await act(() => lastClient.invalidateQueries());
    await waitFor(() => expect(active()).toBe("b"));
    await waitFor(() =>
      expect(router.state.location.searchStr).not.toContain("thread="),
    );
  });

  it("drops a thread link to a thread that is gone", async () => {
    serveThreads(() => [mk("a")]);
    const router = mount(`${viewerPath(OWNED)}?thread=gone`);
    await toolbar();
    await waitFor(() =>
      expect(router.state.location.searchStr).not.toContain("thread="),
    );
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).not.toBeInTheDocument();
  });

  it("steps through two asks and wraps, opening the closed column", async () => {
    serveThreads(() => [mk("a"), mk("b")]);
    mount(viewerPath(OWNED));
    const b = await toolbar();
    expect(b).toHaveTextContent("2 asks for you");
    expect(
      screen.queryByRole("complementary", { name: "Comments" }),
    ).not.toBeInTheDocument();
    fireEvent.click(b);
    await screen.findByRole("complementary", { name: "Comments" });
    const first = await waitFor(() => {
      const id = active();
      expect(id).toBeTruthy();
      return id;
    });
    fireEvent.click(b);
    await waitFor(() => expect(active()).not.toBe(first));
    fireEvent.click(b);
    await waitFor(() => expect(active()).toBe(first));
  });

  it("the header count does the same", async () => {
    serveThreads(() => [mk("a"), mk("b")]);
    mount(viewerPath(OWNED));
    const c = await col();
    const h = await within(c).findByRole("button", { name: "2 asks for you" });
    fireEvent.click(h);
    await waitFor(() => expect(active()).toBeTruthy());
    const first = active();
    fireEvent.click(h);
    await waitFor(() => expect(active()).not.toBe(first));
  });
});

describe("asks for you with a single ask (#1614)", () => {
  it("clicking again still selects the ask when it is already active", async () => {
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    const b = await screen.findByRole("button", { name: /1 ask for you$/ });
    fireEvent.click(b);
    await waitFor(() =>
      expect(document.querySelector("[data-thread][data-active]")).toBeTruthy(),
    );
    focus.mockClear();
    fireEvent.click(b);
    await waitFor(() => expect(focus).toHaveBeenCalledWith("t-ask"));
  });
});

describe("asks for you: reveal, surfaces, gone (#1614)", () => {
  const btn = () => screen.findByRole("button", { name: /1 ask for you$/ });

  it("an already-active ask in an open column scrolls and takes focus on click", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    const c = await col();
    const b = (
      await screen.findAllByRole("button", { name: /1 ask for you$/ })
    )[0] as HTMLElement;
    fireEvent.click(b);
    const row = c.querySelector('[data-thread="t-ask"]') as HTMLElement;
    await waitFor(() => expect(row).toHaveAttribute("data-active"));
    await waitFor(() => expect(document.activeElement).toBe(row));
    (document.activeElement as HTMLElement).blur();
    scroll.mockClear();
    fireEvent.click(b);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("focus is one-shot: reopening the column does not focus the row again", async () => {
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: /1 ask for you$/ })
      )[0] as HTMLElement,
    );
    const row = c.querySelector('[data-thread="t-ask"]') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(row));
    const toggle = screen.getByRole("button", { name: /^Comments/ });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Comments" }),
      ).toBeNull(),
    );
    fireEvent.click(toggle);
    const c2 = await screen.findByRole("complementary", { name: "Comments" });
    const row2 = (await waitFor(() => {
      const r = c2.querySelector('[data-thread="t-ask"]');
      expect(r).toBeTruthy();
      return r;
    })) as HTMLElement;
    await wait(50);
    expect(document.activeElement).not.toBe(row2);
  });

  it("opens the side panel on a mid-width screen", async () => {
    viewport(800);
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    fireEvent.click(await btn());
    const tab = await screen.findByRole("tab", { name: /Comments/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Which layout?")).toBeInTheDocument();
  });

  it("opens the sheet on a phone, named for the ask count", async () => {
    viewport(400);
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    fireEvent.click(await btn());
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(await within(sheet).findByText("Which layout?")).toBeInTheDocument();
  });

  it("is disabled once the artifact is gone", async () => {
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    const b = await btn();
    expect(b).toBeEnabled();
    await act(() =>
      fetch(R.artifact(OWNED), {
        method: "DELETE",
        headers: { "X-OA-Request": "1" },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /1 ask for you$/ }),
      ).toBeDisabled(),
    );
  });
});

describe("nextAskFor", () => {
  const th = (id: string, mine = true) =>
    askThread(
      { id },
      mine ? {} : { to: [{ kind: "user", id: "x", name: "X", me: false }] },
    ) as never;
  const mkApi = (ordered: unknown[], orphans: unknown[] = []) =>
    ({ ordered, orphans }) as never;

  it("includeSelf with a null fromId returns the first pending ask", () => {
    expect(
      nextAskFor(mkApi([th("a"), th("b")]), null, { includeSelf: true }),
    ).toBe("a");
  });
  it("a fromId not in the list starts from the top", () => {
    expect(nextAskFor(mkApi([th("a"), th("b")]), "zzz")).toBe("a");
  });
  it("includeSelf returns fromId only when it is the sole pending ask", () => {
    const api = mkApi([th("a"), th("b", false)]);
    expect(nextAskFor(api, "a")).toBeUndefined();
    expect(nextAskFor(api, "a", { includeSelf: true })).toBe("a");
    expect(nextAskFor(api, "b", { includeSelf: true })).toBe("a");
  });
  it("finds asks in orphans, after the ordered ones", () => {
    const api = mkApi([th("a", false)], [th("o")]);
    expect(nextAskFor(api, "a")).toBe("o");
    expect(nextAskFor(api, null)).toBe("o");
  });
});

describe("Ask a question (#1794)", () => {
  const agentAsk = (askOver: object = {}) => {
    const t = askThread({}, askOver);
    (t.comments[0] as { author: unknown }).author = {
      kind: "agent",
      id: "agent:p",
      name: "OA Product",
      for: "Leo",
      me: false,
    };
    return t;
  };

  it("sends a reply to the agent that asked, with toAsker", async () => {
    const t = agentAsk();
    serveThreads(() => [t]);
    let sent: unknown = null;
    server.use(
      http.post(
        "*/api/v1/artifacts/:id/comments/:tid/replies",
        async ({ request }) => {
          sent = await request.json();
          return HttpResponse.json({
            id: "c-q",
            body: "What breaks with A?",
            author: { kind: "user", id: "me", name: "Me", me: true },
            createdAt: "2026-11-05T11:00:00Z",
            editedAt: null,
            typed: true,
            can: { edit: true, delete: true },
            mentions: [
              { key: "agent:p", name: "OA Product", delivery: "delivered" },
            ],
          });
        },
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: "Ask a question" }),
    );
    expect(
      await within(c).findByText("To OA Product, the agent that asked"),
    ).toBeInTheDocument();
    const box = within(c).getByRole("textbox", { name: "Question" });
    await waitFor(() => expect(box).toHaveFocus());
    fireEvent.change(box, { target: { value: "What breaks with A?" } });
    fireEvent.click(within(c).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sent).toEqual({ body: "What breaks with A?", toAsker: true }),
    );
    await waitFor(() =>
      expect(
        within(c).queryByRole("textbox", { name: "Question" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(c).getByRole("textbox", { name: "Reply" }),
    ).toBeInTheDocument();
  });

  it("Cancel goes back to the plain reply box", async () => {
    serveThreads(() => [agentAsk()]);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: "Ask a question" }),
    );
    fireEvent.click(await within(c).findByRole("button", { name: "Cancel" }));
    expect(
      await within(c).findByRole("textbox", { name: "Reply" }),
    ).toBeInTheDocument();
    expect(
      within(c).queryByText("To OA Product, the agent that asked"),
    ).not.toBeInTheDocument();
  });

  it("keeps the draft when the ask is answered meanwhile, and says why it can't send", async () => {
    let t = agentAsk();
    serveThreads(() => [t]);
    server.use(
      http.post("*/api/v1/artifacts/:id/comments/:tid/replies", () =>
        HttpResponse.json(
          { error: { code: "not_an_ask", message: "x" } },
          { status: 400 },
        ),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: "Ask a question" }),
    );
    const box = await within(c).findByRole("textbox", { name: "Question" });
    fireEvent.change(box, { target: { value: "Why B?" } });
    t = agentAsk({ closed: true });
    await act(async () => {
      events.emitComments(OWNED, 2);
    });
    await waitFor(() =>
      expect(
        within(c).queryByRole("button", { name: "Ask a question" }),
      ).not.toBeInTheDocument(),
    );
    expect(within(c).getByRole("textbox", { name: "Question" })).toHaveValue(
      "Why B?",
    );
    fireEvent.click(within(c).getByRole("button", { name: "Send" }));
    expect(
      await within(c).findByText(
        "That ask is no longer open to questions. Reply instead.",
      ),
    ).toBeInTheDocument();
  });

  it("leaving the thread drops the question box", async () => {
    const other = askThread({ id: "t-2" }, {});
    (other.comments[0] as { id: string }).id = "c-2";
    delete (other.comments[0] as { ask?: unknown }).ask;
    (other.comments[0] as { body: string }).body = "Other thread";
    serveThreads(() => [agentAsk(), other]);
    mount(viewerPath(OWNED));
    const c = await col();
    fireEvent.click(
      await within(c).findByRole("button", { name: "Ask a question" }),
    );
    await within(c).findByRole("textbox", { name: "Question" });
    const second = document.querySelector("[data-thread='t-2']") as HTMLElement;
    fireEvent.click(within(second).getAllByRole("button")[0]!);
    await waitFor(() =>
      expect(
        document.querySelector("[data-thread='t-2'][data-active]"),
      ).toBeTruthy(),
    );
    const first = document.querySelector(
      "[data-thread='t-ask']",
    ) as HTMLElement;
    fireEvent.click(within(first).getAllByRole("button")[0]!);
    await waitFor(() =>
      expect(
        document.querySelector("[data-thread='t-ask'][data-active]"),
      ).toBeTruthy(),
    );
    expect(
      within(c).queryByRole("textbox", { name: "Question" }),
    ).not.toBeInTheDocument();
    expect(
      within(first).getByRole("textbox", { name: "Reply" }),
    ).toBeInTheDocument();
  });

  it("is not offered once picked, when closed, or when a person asked", async () => {
    const picked = agentAsk({
      answer: {
        optionId: "a",
        by: { kind: "user", id: "me", name: "Me", me: true },
        at: "2026-11-05T11:00:00Z",
        typed: true,
        yes: true,
      },
    });
    picked.id = "t-1";
    const closed = agentAsk({ closed: true });
    closed.id = "t-2";
    (closed.comments[0] as { id: string }).id = "c-2";
    const person = askThread({ id: "t-3" });
    (person.comments[0] as { id: string }).id = "c-3";
    serveThreads(() => [picked, closed, person]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findAllByText("Which layout?");
    await wait(50);
    expect(
      within(c).queryByRole("button", { name: "Ask a question" }),
    ).not.toBeInTheDocument();
  });
});
