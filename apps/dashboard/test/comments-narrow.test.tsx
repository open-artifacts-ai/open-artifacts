// #2486: the comments panel between phones and wide windows (601px to 959px).
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
import { installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

const opts: { onHello: () => void }[] = [];
vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: {
      iframe: HTMLIFrameElement;
      url: string;
      onHello: () => void;
    }) => {
      loadArtifactFrame(o.iframe, o.url);
      opts.push(o);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
        scrollTo: () => {},
        setCommentsMode: () => {},
        setComments: () => {},
        focusComment: () => {},
      };
    },
  };
});

installHarness();

const defaultAsyncTimeout = getConfig().asyncUtilTimeout;
beforeAll(() => configure({ asyncUtilTimeout: FIRST_LOAD_MS }));
afterAll(() => configure({ asyncUtilTimeout: defaultAsyncTimeout }));

/** matchMedia answers the breakpoints the comments layout uses. */
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

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;

const askThread = {
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
      body: "Steps first.",
      author: {
        kind: "agent",
        id: "ag",
        name: "OA Self-Serve",
        me: false,
      },
      createdAt: "2026-11-05T10:00:00Z",
      editedAt: null,
      typed: false,
      can: { edit: false, delete: false },
      ask: {
        question: "Which layout?",
        options: [
          { id: "a", label: "List only" },
          { id: "b", label: "Side by side" },
        ],
        to: [{ kind: "user", id: "me", name: "Me", me: true }],
        closed: false,
      },
    },
    {
      id: "c-reply",
      body: "Looking now.",
      author: { kind: "user", id: "u2", name: "Ada Lovelace", me: false },
      createdAt: "2026-11-05T11:00:00Z",
      editedAt: null,
      typed: true,
      can: { edit: false, delete: false },
    },
  ],
};

beforeEach(() => {
  opts.length = 0;
  server.use(
    http.get(`*${R.comments(OWNED)}`, () =>
      HttpResponse.json({ threads: [askThread], open: 1, truncated: false }),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

const topPill = () =>
  document.querySelector(".oa-vt [data-asks-for-you]") as HTMLElement | null;
const panel = () => screen.findByRole("complementary", { name: "Side panel" });
/** Open the panel's Comments tab with the top-bar button. */
async function openPanel() {
  fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
  const p = await panel();
  await within(p).findByText("Which layout?");
  return p;
}
const commentButton = (p: HTMLElement) =>
  within(p).queryByRole("button", { name: /^Comment$/ });

describe("between phones and wide windows (#2486)", () => {
  beforeEach(() => viewport(800));

  it("the asks pill is in the top bar while the panel is closed, and only in the panel while it is open", async () => {
    mount(viewerPath(OWNED));
    await waitFor(() => expect(topPill()).toBeTruthy());
    expect(topPill()).toHaveTextContent("1 ask for you");
    const p = await openPanel();
    expect(topPill()).toBeNull();
    const pills = document.querySelectorAll("[data-asks-for-you]");
    expect(pills).toHaveLength(1);
    // The panel's pill jumps to the next ask.
    fireEvent.click(pills[0] as HTMLElement);
    await waitFor(() =>
      expect(p.querySelector('[data-thread="t-ask"]')).toHaveAttribute(
        "data-active",
      ),
    );
    // Closed again: back in the top bar.
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(topPill()).toBeTruthy());
  });

  it("names Comments once: the tab carries the count, no band; the button is expanded", async () => {
    mount(viewerPath(OWNED));
    const p = await openPanel();
    const tab = within(p).getByRole("tab", { name: "Comments, 1 open" });
    expect(tab).toHaveTextContent("Comments 1");
    expect(p.querySelector("[data-comments-header]")).toBeNull();
    const b = screen.getByRole("button", { name: "Comments, 1 open" });
    expect(b).toHaveAttribute("aria-expanded", "true");
    // Pressed look while open (601px to 959px).
    expect(b.className).toContain(
      "min-[601px]:max-[959.98px]:aria-expanded:bg-[var(--oa-sunken)]",
    );
  });

  it("the icon-only Comments button (601px to 639px) keeps its name", async () => {
    mount(viewerPath(OWNED));
    const b = await screen.findByRole("button", { name: "Comments, 1 open" });
    const label = within(b).getByText("Comments");
    expect(label.className).toContain("min-[601px]:max-[639.98px]:sr-only");
    // Full screen is its icon, named by its sr-only label.
    const fs = screen.getByRole("link", { name: "Full screen" });
    expect(within(fs).getByText("Full screen").className).toContain(
      "min-[601px]:max-[959.98px]:sr-only",
    );
  });

  it("the new-comment box is one line until focused, and shrinks back when left empty", async () => {
    mount(viewerPath(OWNED));
    const p = await openPanel();
    const field = within(p).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    expect(p.querySelector("[data-collapsed]")).toBeTruthy();
    expect(commentButton(p)).toBeNull();
    expect(field).not.toHaveAttribute("aria-describedby");
    act(() => field.focus());
    expect(p.querySelector("[data-collapsed]")).toBeNull();
    expect(commentButton(p)).toBeInTheDocument();
    // Moving focus to the box's own button keeps it open.
    const send = commentButton(p) as HTMLElement;
    act(() => send.focus());
    expect(commentButton(p)).toBeInTheDocument();
    // Leaving it empty shrinks it.
    act(() =>
      within(p)
        .getByRole("tab", { name: /Comments/ })
        .focus(),
    );
    expect(p.querySelector("[data-collapsed]")).toBeTruthy();
    expect(commentButton(p)).toBeNull();
    // With words, it stays open after focus leaves.
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "Looks good" } });
    act(() =>
      within(p)
        .getByRole("tab", { name: /Comments/ })
        .focus(),
    );
    expect(p.querySelector("[data-collapsed]")).toBeNull();
    expect(commentButton(p)).toBeEnabled();
  });

  it("Esc keeps a typed note and the panel; on an empty box it closes the panel as before", async () => {
    mount(viewerPath(OWNED));
    const p = await openPanel();
    const field = within(p).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "Draft" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("Draft");
    expect(
      screen.getByRole("complementary", { name: "Side panel" }),
    ).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Side panel" }),
      ).toBeNull(),
    );
  });

  it("an ask has one box: the author line once, with the date; replies keep face and indent", async () => {
    mount(viewerPath(OWNED));
    const p = await openPanel();
    const card = p.querySelector('[data-thread="t-ask"]') as HTMLElement;
    const root = card.querySelector('[data-comment="c-ask"]') as HTMLElement;
    const from = root.querySelectorAll("[data-ask-from]");
    expect(from).toHaveLength(1);
    expect(from[0]?.textContent).toMatch(/^OA Self-Serve agent asks you · /);
    expect(root.querySelector("[data-author-name]")).toBeNull();
    expect(root.querySelector("[data-comment-body]")?.className).not.toContain(
      "pl-8",
    );
    expect(root.querySelector("[data-ask]")?.className).not.toContain("ring");
    expect(card.className).toContain(
      "has-[[data-needs-you]]:border-[var(--oa-warning)]",
    );
    const reply = card.querySelector('[data-comment="c-reply"]') as HTMLElement;
    expect(reply.querySelector("[data-author-name]")).toHaveTextContent(
      "Ada Lovelace",
    );
    expect(reply.querySelector("[data-comment-body]")?.className).toContain(
      "pl-8",
    );
    // The thread column stops at 720px.
    expect(p.querySelector("[data-compact]")?.className).toContain(
      "max-w-[720px]",
    );
  });
});

describe("wide windows are unchanged (#2486)", () => {
  beforeEach(() => viewport(1280));

  it("the column keeps its band, full composer, ringed ask and top-bar pill", async () => {
    mount(viewerPath(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: /^Comments/ }));
    const c = await screen.findByRole("complementary", { name: "Comments" });
    await within(c).findByText("Which layout?");
    expect(c.querySelector("[data-compact]")).toBeNull();
    expect(c.querySelector("[data-collapsed]")).toBeNull();
    expect(c.querySelector("[data-comments-header]")).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Comment" })).toBeVisible();
    expect(c.querySelector("[data-ask]")?.className).toContain("ring-1");
    expect(topPill()).toBeTruthy();
  });

  it("the side panel's Comments tab has no count", async () => {
    mount(`${viewerPath(OWNED)}?panel=open&tab=comments`);
    const p = await panel();
    await within(p).findByText("Which layout?");
    expect(
      within(p).getByRole("tab", { name: "Comments" }),
    ).not.toHaveAttribute("aria-label");
    expect(p.querySelector("[data-tab-count]")).toBeNull();
    expect(topPill()).toBeTruthy();
  });
});
