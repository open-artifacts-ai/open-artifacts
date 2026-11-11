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
  onTestFinished,
  vi,
} from "vitest";
import { LIVE_TINT_MS } from "../src/viewer/comments/liveReplies";
import { events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

const setComments = vi.fn();
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
        setComments,
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

const viewport = (reduced = false) => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches:
          q === "(min-width: 960px)"
            ? true
            : q === "(prefers-reduced-motion: reduce)"
              ? reduced
              : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};
const col = async () => {
  const b = await screen.findByRole("button", { name: /^Comments/ });
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  return screen.findByRole("complementary", { name: "Comments" });
};

const comment = (
  id: string,
  body: string,
  by: "guest" | "agent" | "me" = "guest",
) => ({
  id,
  body,
  author:
    by === "agent"
      ? // An agent acting for the reader: still news.
        { kind: "agent", id: "u1", name: "OA Product", for: "Leo", me: true }
      : by === "me"
        ? { kind: "user", id: "u1", name: "Leo", me: true }
        : { kind: "guest", name: "Guest", me: false },
  createdAt: "2026-11-05T10:00:00Z",
  editedAt: null,
  typed: false,
  can: { edit: false, delete: false },
});
const thread = (id: string, comments: ReturnType<typeof comment>[]) => ({
  id,
  anchor: { kind: "note" },
  version: 1,
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-11-05T10:00:00Z",
  comments,
});
const serve = (get: () => unknown[]) =>
  server.use(
    http.get(`*${R.comments(OWNED)}`, () =>
      HttpResponse.json({
        threads: get(),
        open: get().length,
        truncated: false,
      }),
    ),
  );
// The socket must be open, or the event goes nowhere.
const arrive = async () => {
  await waitFor(() => expect(events.connections(OWNED)).toBeGreaterThan(0));
  await act(async () => {
    expect(events.emitComments(OWNED, 9)).toBeGreaterThan(0);
  });
};

beforeEach(() => viewport());
afterEach(() => vi.restoreAllMocks());

describe("a folded thread (#2179)", () => {
  it("shows the first comment and the latest reply, the rest behind Show N earlier replies", async () => {
    serve(() => [
      thread("t1", [
        comment("c1", "First"),
        comment("c2", "Second"),
        comment("c3", "Third"),
        comment("c4", "Fourth"),
      ]),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("First");
    expect(within(c).getByText("Fourth")).toBeInTheDocument();
    expect(within(c).queryByText("Second")).toBeNull();
    expect(within(c).queryByText("Third")).toBeNull();
    fireEvent.click(
      within(c).getByRole("button", { name: "Show 2 earlier replies" }),
    );
    expect(await within(c).findByText("Second")).toBeInTheDocument();
    expect(within(c).getByText("Third")).toBeInTheDocument();
    expect(within(c).queryByText(/earlier repl/)).toBeNull();
  });

  it("one reply shows at once, with no button", async () => {
    serve(() => [
      thread("t1", [comment("c1", "First"), comment("c2", "Only")]),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    expect(await within(c).findByText("Only")).toBeInTheDocument();
    expect(within(c).queryByText(/earlier repl/)).toBeNull();
  });
});

describe("what was visible on load (#2179)", () => {
  it("the latest reply on load stays visible after two live replies; only replies folded at load stay folded", async () => {
    const t1 = (more: ReturnType<typeof comment>[] = []) =>
      thread("t1", [
        comment("c1", "First"),
        comment("c2", "Folded at load"),
        comment("c3", "Latest on load"),
        ...more,
      ]);
    let list = [t1()];
    serve(() => list);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Latest on load");
    expect(within(c).queryByText("Folded at load")).toBeNull();
    list = [t1([comment("c4", "Live one", "agent")])];
    await arrive();
    await within(c).findByText("Live one");
    list = [
      t1([comment("c4", "Live one", "agent"), comment("c5", "Live two")]),
    ];
    await arrive();
    await within(c).findByText("Live two");
    expect(within(c).getByText("Latest on load")).toBeInTheDocument();
    expect(within(c).getByText("Live one")).toBeInTheDocument();
    expect(within(c).queryByText("Folded at load")).toBeNull();
    expect(
      within(c).getByRole("button", { name: "Show 1 earlier reply" }),
    ).toBeInTheDocument();
  });
});

describe("a live reply (#2179)", () => {
  const base = () => [
    thread("t1", [comment("c1", "First"), comment("c2", "Old")]),
    thread("t2", [comment("c3", "Other"), comment("c4", "Other reply")]),
  ];

  it("shows at once, tinted for a moment, and stays unfolded; an agent counts too", async () => {
    let list = base();
    serve(() => list);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Old");
    // shouldAdvanceTime: findBy* polls on setTimeout too.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      list = [
        thread("t1", [
          comment("c1", "First"),
          comment("c2", "Old"),
          comment("c5", "From an agent", "agent"),
        ]),
        list[1] as ReturnType<typeof thread>,
      ];
      await arrive();
      const row = await within(c).findByText("From an agent");
      const li = row.closest("[data-comment]") as HTMLElement;
      expect(li).toHaveAttribute("data-live");
      // A second live reply: everything already shown stays.
      list = [
        thread("t1", [
          ...(list[0] as ReturnType<typeof thread>).comments,
          comment("c6", "Newest"),
        ]),
        list[1] as ReturnType<typeof thread>,
      ];
      await arrive();
      await within(c).findByText("Newest");
      expect(within(c).getByText("From an agent")).toBeInTheDocument();
      // The latest reply on load never folds away mid-visit.
      expect(within(c).getByText("Old")).toBeInTheDocument();
      expect(within(c).queryByText(/earlier repl/)).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(LIVE_TINT_MS + 10);
      });
      expect(li).not.toHaveAttribute("data-live");
      expect(within(c).getByText("From an agent")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new thread is not a live reply", async () => {
    let list = base();
    serve(() => list);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Old");
    list = [...list, thread("t3", [comment("c7", "Brand new")])];
    await arrive();
    const li = (await within(c).findByText("Brand new")).closest(
      "[data-comment]",
    );
    expect(li).not.toHaveAttribute("data-live");
  });

  it("the reader's own reply is not tinted", async () => {
    let list = base();
    serve(() => list);
    mount(viewerPath(OWNED));
    const c = await col();
    await within(c).findByText("Old");
    list = [
      thread("t1", [
        comment("c1", "First"),
        comment("c2", "Old"),
        comment("c8", "Mine", "me"),
      ]),
      list[1] as ReturnType<typeof thread>,
    ];
    await arrive();
    const li = (await within(c).findByText("Mine")).closest("[data-comment]");
    expect(li).not.toHaveAttribute("data-live");
  });

  describe("in the panel's scroller", () => {
    // jsdom has no layout: rows sit 50px apart in document order, minus scrollTop.
    const layout = (box: HTMLElement) => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
          const rect = (top: number, h: number) =>
            ({
              top,
              bottom: top + h,
              left: 0,
              right: 0,
              width: 0,
              height: h,
            }) as DOMRect;
          if (this === box) return rect(0, 500);
          const rows = [...box.querySelectorAll("[data-comment]")];
          const i = rows.indexOf(this);
          if (i >= 0) return rect(i * 50 - box.scrollTop, 40);
          return rect(-1000, 100);
        },
      );
    };
    const setup = async () => {
      // t1 has no replies yet, so nothing folds when one arrives.
      const t2 = thread("t2", [
        comment("c3", "Other"),
        comment("c4", "Other reply"),
      ]);
      let list = [thread("t1", [comment("c1", "First")]), t2];
      serve(() => list);
      mount(viewerPath(OWNED));
      const c = await col();
      c.style.overflowY = "auto";
      await within(c).findByText("Other reply");
      layout(c);
      // Rows: c1 0, c3 50, c4 100. The reader is on c3 (top -10).
      c.scrollTop = 60;
      fireEvent.scroll(c);
      list = [
        thread("t1", [comment("c1", "First"), comment("c5", "Arrived")]),
        t2,
      ];
      return { c, push: arrive };
    };

    it("keeps the reader's place when a reply lands above, and offers New reply", async () => {
      const { c, push } = await setup();
      const scrollIntoView = vi.fn();
      const was = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoView;
      onTestFinished(() => {
        Element.prototype.scrollIntoView = was;
      });
      const doc = vi.spyOn(window, "scrollTo");
      await push();
      await within(c).findByText("Arrived");
      // Arrived is row 1, above c3: scrollTop moved by one row, c3 stays put.
      expect(c.scrollTop).toBe(110);
      const pill = await within(c).findByRole("button", { name: "New reply" });
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(doc).not.toHaveBeenCalled();
      // jsdom's Element.scrollTo does nothing: record it on the panel.
      c.scrollTo = ((o: ScrollToOptions) => {
        c.scrollTop = o.top ?? c.scrollTop;
      }) as typeof c.scrollTo;
      fireEvent.click(pill);
      // Row 1 sits at 50 - 110 = -60; the panel scrolls it to the top (8px gap).
      await waitFor(() => expect(c.scrollTop).toBe(110 - 60 - 8));
      expect(within(c).queryByRole("button", { name: "New reply" })).toBeNull();
    });

    it("does not show the pill when the reply is in view", async () => {
      const { c, push } = await setup();
      c.scrollTop = 0;
      fireEvent.scroll(c);
      await push();
      await within(c).findByText("Arrived");
      expect(c.scrollTop).toBe(0);
      expect(within(c).queryByRole("button", { name: "New reply" })).toBeNull();
    });
  });

  it("keeps a typed draft", async () => {
    let list = base();
    serve(() => list);
    mount(viewerPath(OWNED));
    const c = await col();
    const other = (await within(c).findByText("Other")).closest(
      "[data-thread]",
    ) as HTMLElement;
    fireEvent.click(within(other).getAllByRole("button")[0] as HTMLElement);
    const box = await within(c).findByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "half a thought" } });
    list = [
      thread("t1", [
        comment("c1", "First"),
        comment("c2", "Old"),
        comment("c5", "Arrived"),
      ]),
      list[1] as ReturnType<typeof thread>,
    ];
    await arrive();
    await within(c).findByText("Arrived");
    expect(within(c).getByRole("textbox", { name: "Reply" })).toHaveValue(
      "half a thought",
    );
  });
});

describe("the panel header (#2179)", () => {
  it("is sticky at the top of the panel's scroller, with a background", async () => {
    serve(() => [
      thread("t1", [comment("c1", "First"), comment("c2", "Second")]),
    ]);
    mount(viewerPath(OWNED));
    const c = await col();
    c.style.overflowY = "auto";
    await within(c).findByText("First");
    const head = c.querySelector("[data-comments-header]") as HTMLElement;
    expect(head).toHaveTextContent("Comments");
    expect(head.className).toMatch(/\bsticky\b/);
    expect(head.className).toMatch(/\btop-0\b/);
    expect(head.className).toMatch(/bg-\[var\(--oa-bg\)\]/);
    // The list below it is never narrower than its content, so the header's
    // sticky range covers the whole scroll.
    expect(head.parentElement?.className).toMatch(/min-h-fit/);
  });
});
