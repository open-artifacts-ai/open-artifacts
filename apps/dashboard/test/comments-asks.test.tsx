import { type ArtifactAgent, R, viewerPath } from "@oa/shared";
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
  mentionedKeys,
  mentionQuery,
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
    expect(await within(c).findByText(/You picked A/)).toBeInTheDocument();
  });

  it("heads the ask 'Ask', amber while it needs you, with a key badge per option and a Recommended tag", async () => {
    serveThreads(() => [askThread()]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Which layout?");
    expect(within(c).getByText("Ask", { selector: "p" })).toBeInTheDocument();
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

  it("drops the amber once you have picked", async () => {
    serveThreads(() => [
      askThread(
        {},
        {
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
    expect(line).toHaveTextContent(/Which layout\? Side by side · you, .+/);
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

  it("marks agents online or offline in text, not colour alone", async () => {
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
      within(menu).getByRole("option", { name: /OA Design.*offline/ }),
    ).toBeTruthy();
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

describe("removeMention", () => {
  it("keeps the line break before a removed mention", () => {
    expect(removeMention("hi\n@Bob there", "Bob")).toBe("hi\n there");
  });
  it("removes every mention of the name", () => {
    expect(removeMention("@Bob hi @bob, ok", "Bob")).toBe("hi, ok");
  });
});
