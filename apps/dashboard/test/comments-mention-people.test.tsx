// Person @mentions in the comment composer.
import { type ArtifactAgent, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  cleanup,
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
import { calls, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

type Opts = { onHello: () => void; iframe: HTMLIFrameElement; url: string };
const opts: Opts[] = [];
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

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const CAND = `*${R.artifactMentionCandidates(OWNED)}`;

const DANA = {
  kind: "user",
  id: "usr_dana",
  name: "Dana Whitfield",
  me: false,
};
const DANIELLE = {
  kind: "user",
  id: "usr_danielle",
  name: "Danielle Okafor",
  me: false,
};
const AGENTS: ArtifactAgent[] = [
  { key: "agent:design", name: "OA Design", online: true },
];

beforeEach(() => {
  opts.length = 0;
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const hello = () =>
  act(async () => {
    await waitFor(() => expect(opts.length).toBeGreaterThan(0));
    opts.at(-1)?.onHello();
  });
const col = async () => {
  await hello();
  const b = await screen.findByRole("button", { name: /^Comments/ });
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  return screen.findByRole("complementary", { name: "Comments" });
};
const serve = (agents: ArtifactAgent[] = AGENTS) =>
  server.use(
    http.get(`*${R.artifactAgents(OWNED)}`, () => HttpResponse.json(agents)),
  );
const box = async () => {
  const c = await col();
  const b = await within(c).findByRole("textbox", {
    name: "Comment on the whole page",
  });
  fireEvent.focus(b);
  // The agents load on focus; the people come with each query.
  await waitFor(() => {
    fireEvent.change(b, { target: { value: "@", selectionStart: 1 } });
    expect(within(c).queryByRole("listbox")).not.toBeNull();
  });
  fireEvent.change(b, { target: { value: "" } });
  return { c, b };
};
const type = (b: HTMLElement, value: string) =>
  fireEvent.change(b, { target: { value, selectionStart: value.length } });

describe("@ lists people with the agents (#2770)", () => {
  it("searches by what is typed and lists agents and people together", async () => {
    const qs: string[] = [];
    serve();
    server.use(
      http.post(CAND, async ({ request }) => {
        qs.push(((await request.json()) as { q: string }).q);
        return HttpResponse.json({
          // An email is never shown, even if one rode along.
          items: [{ ...DANA, email: "dana@acme.test" }, DANIELLE],
        });
      }),
    );
    mount(viewerPath(OWNED));
    const { c, b } = await box();
    type(b, "@da");
    const list = await within(c).findByRole("listbox", {
      name: "Agents and people",
    });
    const rows = within(list).getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Dana Whitfield"),
      expect.stringContaining("Danielle Okafor"),
    ]);
    expect(qs).toEqual(["da"]);
    expect(document.body.textContent).not.toContain("dana@acme.test");
    // An agent still matches by its name next to people.
    type(b, "@o");
    expect(await within(c).findByText("OA Design")).toBeTruthy();
  });

  it("picks with the keyboard, shows a pill, and sends the id in people", async () => {
    serve();
    server.use(
      http.post(CAND, () => HttpResponse.json({ items: [DANA, DANIELLE] })),
    );
    const all = calls("POST");
    // The candidates search is a POST too: only comments count here.
    const posts = {
      get length() {
        return this.list.length;
      },
      get list() {
        return all.filter((c) => !c.path.endsWith("/mention-candidates"));
      },
      get 0() {
        return this.list[0];
      },
    };
    mount(viewerPath(OWNED));
    const { c, b } = await box();
    type(b, "@da");
    await within(c).findByRole("listbox");
    await waitFor(() =>
      expect(within(c).getAllByRole("option")).toHaveLength(2),
    );
    expect(b.getAttribute("aria-activedescendant")).toMatch(/-0$/);
    fireEvent.keyDown(b, { key: "ArrowDown" });
    fireEvent.keyDown(b, { key: "Enter" });
    expect((b as HTMLTextAreaElement).value).toBe("@Danielle Okafor ");
    expect(
      within(c).getByRole("button", {
        name: "Remove mention of Danielle Okafor",
      }),
    ).toBeTruthy();
    expect(within(c).getByText("Will notify Danielle Okafor")).toBeTruthy();
    expect(within(c).queryByRole("listbox")).toBeNull();
    type(b, "@Danielle Okafor can you check?");
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]?.body).toMatchObject({
      body: "@Danielle Okafor can you check?",
      people: ["usr_danielle"],
    });
    expect(posts[0]?.body).not.toHaveProperty("mentions");
  });

  it("mixes an agent and a person in one comment", async () => {
    serve();
    server.use(http.post(CAND, () => HttpResponse.json({ items: [DANA] })));
    const all = calls("POST");
    // The candidates search is a POST too: only comments count here.
    const posts = {
      get length() {
        return this.list.length;
      },
      get list() {
        return all.filter((c) => !c.path.endsWith("/mention-candidates"));
      },
      get 0() {
        return this.list[0];
      },
    };
    mount(viewerPath(OWNED));
    const { c, b } = await box();
    type(b, "@dana");
    await waitFor(() =>
      expect(within(c).getAllByRole("option")).toHaveLength(1),
    );
    fireEvent.mouseDown(within(c).getByRole("option"));
    type(b, "@Dana Whitfield and @OA Design look");
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]?.body).toMatchObject({
      people: ["usr_dana"],
      mentions: [{ key: "agent:design" }],
    });
  });

  it("ignores an answer for an older query", async () => {
    serve();
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const aborted: string[] = [];
    server.use(
      http.post(CAND, async ({ request }) => {
        const q = ((await request.json()) as { q: string }).q;
        if (q === "s") {
          request.signal.addEventListener("abort", () => aborted.push("s"));
          await slow;
          return HttpResponse.json({ items: [DANA] });
        }
        return HttpResponse.json({ items: [DANIELLE] });
      }),
    );
    mount(viewerPath(OWNED));
    const { c, b } = await box();
    type(b, "@s");
    // Past the debounce, so the slow request is on its way.
    await act(() => new Promise((r) => setTimeout(r, 250)));
    type(b, "@da");
    await waitFor(() =>
      expect(within(c).getAllByRole("option")[0]?.textContent).toContain(
        "Danielle Okafor",
      ),
    );
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    const rows = within(c).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Danielle Okafor");
    expect(within(c).queryByText("Dana Whitfield")).toBeNull();
    expect(aborted).toEqual(["s"]);
  });

  it("holds at ten, in plain words, and still refuses an eleventh on send", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      key: `agent:n${i}`,
      name: `Ag${String.fromCharCode(65 + i)}`,
      online: true,
    }));
    serve(many);
    server.use(http.post(CAND, () => HttpResponse.json({ items: [DANA] })));
    const all = calls("POST");
    // The candidates search is a POST too: only comments count here.
    const posts = {
      get length() {
        return this.list.length;
      },
      get list() {
        return all.filter((c) => !c.path.endsWith("/mention-candidates"));
      },
      get 0() {
        return this.list[0];
      },
    };
    mount(viewerPath(OWNED));
    const { c, b } = await box();
    type(b, `${many.map((a) => `@${a.name}`).join(" ")} @dana`);
    await waitFor(() =>
      expect(within(c).getAllByRole("option")).toHaveLength(1),
    );
    expect(
      within(c).getByText(/mention up to 10 agents or people/),
    ).toBeTruthy();
    // Picking adds nothing at the cap.
    fireEvent.mouseDown(within(c).getByRole("option"));
    expect((b as HTMLTextAreaElement).value.endsWith("@dana")).toBe(true);
    // Ten agents and one typed-in person is the eleventh.
    type(b, `${many.map((a) => `@${a.name}`).join(" ")} @Ag go`);
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    expect(posts).toHaveLength(0);
  });

  it("offers no people from a server without the route", async () => {
    serve();
    mount(viewerPath(OWNED));
    const { c, b } = await box();
    type(b, "@da");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(within(c).queryByText("Dana Whitfield")).toBeNull();
  });
});

describe("a posted comment that mentions people (#2770)", () => {
  it("shows each person as a pill with their initials, and no email", async () => {
    serve();
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({
          threads: [
            {
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
                  body: "@Dana Whitfield can you check the yearly numbers?",
                  author: { kind: "user", id: "owner", name: "Leo", me: false },
                  createdAt: "2026-11-05T10:00:00Z",
                  editedAt: null,
                  typed: true,
                  can: { edit: false, delete: false },
                  people: [{ ...DANA, email: "dana@acme.test" }],
                },
              ],
            },
          ],
          open: 1,
          truncated: false,
        }),
      ),
    );
    mount(viewerPath(OWNED));
    const c = await col();
    const chip = await waitFor(() => {
      const el = c.querySelector("[data-mention-chip]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(chip.textContent).toContain("@Dana Whitfield");
    expect(chip.querySelector("[data-avatar]")?.textContent).toBe("DW");
    expect(document.body.textContent).not.toContain("dana@acme.test");
  });
});
