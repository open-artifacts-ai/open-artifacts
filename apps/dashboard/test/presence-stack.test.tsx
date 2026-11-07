// Presence stack UI (#949 Task 9): faces, "+N", cards, shapes, palette.
import { type PresenceEntry, R, viewerPath } from "@oa/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setEmbedForTests } from "../src/embed";
import { fullPath } from "../src/viewer/paths";
import { PresenceStack } from "../src/viewer/presence/PresenceStack";
import { arts, events, installHarness, mount } from "./harness";

installHarness();

const KEYS = "ABCDEFGHIJKLMNOP";
const key = (i: number) => `${"k".repeat(14)}${String(i).padStart(2, "0")}`;
const person = (i: number, name: string, color = i % 9): PresenceEntry => ({
  key: key(i),
  kind: "person",
  name,
  named: true,
  color,
});
const anon = (
  i: number,
  animal = "duck",
  name = "Anonymous Duck",
): PresenceEntry => ({
  key: key(i),
  kind: "anon",
  name,
  named: false,
  color: i % 9,
  animal,
});
const agent = (
  i: number,
  extra: Partial<NonNullable<PresenceEntry["agent"]>> = {},
): PresenceEntry => ({
  key: key(i),
  kind: "agent",
  name: "Claude Code",
  named: true,
  color: 4,
  agent: {
    owner: "Sam Ortiz",
    state: "editing",
    activity: "Rewriting the pricing table",
    ...extra,
  },
});

const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    person(i, `Person ${String.fromCharCode(65 + i)}${KEYS[i]}`),
  );

const narrow = (on: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: on && q.includes("max-width"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));

afterEach(() => {
  setEmbedForTests(false);
  cleanup();
  vi.unstubAllGlobals();
});

const faces = () => screen.getByRole("group").querySelectorAll("[data-shape]");

describe("PresenceStack", () => {
  it("nobody else: renders nothing", () => {
    const { container } = render(<PresenceStack others={[]} total={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("exactly 4: all 4 faces and no +1; 5 others: 3 faces then +2", () => {
    const a = render(<PresenceStack others={many(4)} total={4} />);
    expect(faces()).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /more here/ })).toBeNull();
    a.unmount();
    render(<PresenceStack others={many(5)} total={5} />);
    expect(faces()).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "2 more here" }),
    ).toHaveTextContent("+2");
  });

  it("+N counts the server total past the capped list", () => {
    render(<PresenceStack others={many(6)} total={120} />);
    expect(
      screen.getByRole("button", { name: "117 more here" }),
    ).toHaveTextContent("+117");
  });

  it("phone: one face plus +N", () => {
    narrow(true);
    render(<PresenceStack others={many(6)} total={6} />);
    expect(faces()).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "5 more here" }),
    ).toHaveTextContent("+5");
  });

  it("the stack is a labeled group and every face has a name", () => {
    render(
      <PresenceStack
        others={[person(0, "Maya Chen"), anon(1), agent(2)]}
        total={3}
      />,
    );
    expect(
      screen.getByRole("group", { name: "3 people here now" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maya Chen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anonymous Duck" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude Code" })).toBeTruthy();
  });

  it("faces sit side by side in the given order, 28px, no negative margin", () => {
    render(
      <PresenceStack
        others={[
          person(0, "Ann Lee"),
          person(1, "Bo Chan"),
          person(2, "Cy Dunn"),
        ]}
        total={3}
      />,
    );
    const fs = [...faces()] as HTMLElement[];
    expect(fs.map((f) => f.getAttribute("aria-label"))).toEqual([
      "Ann Lee",
      "Bo Chan",
      "Cy Dunn",
    ]);
    for (const f of fs) {
      expect(f.style.marginLeft).toBe("");
      expect(f.getAttribute("class")).not.toMatch(/-ml-|-space-x/);
      expect(f.style.width).toBe("28px");
    }
    expect(screen.getByRole("group").className).toMatch(/gap-1\b/);
  });

  it("shapes: circles for people and anonymous, a square for an agent with the owner's initials", () => {
    render(
      <PresenceStack
        others={[person(0, "Maya Chen"), anon(1), agent(2)]}
        total={3}
      />,
    );
    expect(screen.getByRole("button", { name: "Maya Chen" })).toHaveAttribute(
      "data-shape",
      "circle",
    );
    expect(screen.getByRole("button", { name: "Maya Chen" })).toHaveTextContent(
      "MC",
    );
    expect(
      screen.getByRole("button", { name: "Anonymous Duck" }),
    ).toHaveAttribute("data-shape", "circle");
    expect(
      screen
        .getByRole("button", { name: "Anonymous Duck" })
        .querySelector("svg"),
    ).toBeTruthy();
    const ag = screen.getByRole("button", { name: "Claude Code" });
    expect(ag).toHaveAttribute("data-shape", "square");
    expect(ag).toHaveTextContent("SO");
  });

  it("color index i maps to --oa-presence-i", () => {
    render(<PresenceStack others={[person(0, "Ann Lee", 7)]} total={1} />);
    expect(
      screen.getByRole("button", { name: "Ann Lee" }).style.background,
    ).toBe("var(--oa-presence-7)");
  });

  it("clicking a person opens a card with the name only, never an @", async () => {
    render(<PresenceStack others={[person(0, "Maya Chen")]} total={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" }));
    const card = await screen.findByRole("dialog");
    expect(card).toHaveTextContent("Maya Chen");
    expect(card.textContent).not.toMatch(/@/);
    expect(card.textContent).toBe("MCMaya Chen");
  });

  it("an anonymous card says the name and shows the icon, nothing else", async () => {
    render(<PresenceStack others={[anon(0)]} total={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Anonymous Duck" }));
    const card = await screen.findByRole("dialog");
    expect(card.textContent).toBe("Anonymous Duck");
    expect(card.querySelector("svg")).toBeTruthy();
  });

  it("an agent card: owner and state, the quoted note, the caption", async () => {
    render(<PresenceStack others={[agent(0)]} total={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    const card = await screen.findByRole("dialog");
    expect(card).toHaveTextContent("Claude Code");
    expect(card).toHaveTextContent("Sam Ortiz's agent · Editing");
    expect(card).toHaveTextContent("“Rewriting the pricing table”");
    expect(card).toHaveTextContent("In the agent's own words");
    expect(card.textContent).not.toMatch(/@/);
  });

  it("an agent with no activity shows no quote or caption; viewing reads Viewing", async () => {
    render(
      <PresenceStack
        others={[agent(0, { state: "viewing", activity: undefined })]}
        total={1}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    const card = await screen.findByRole("dialog");
    expect(card).toHaveTextContent("Sam Ortiz's agent · Viewing");
    expect(card.textContent).not.toMatch(/own words/);
  });

  it("+N opens a list headed 'N more here' with only the rest; agents show owner and state", async () => {
    const others = [
      person(0, "Aa Aa"),
      person(1, "Bb Bb"),
      person(2, "Cc Cc"),
      agent(3),
      anon(4),
      person(5, "Ff Ff"),
    ];
    render(<PresenceStack others={others} total={6} />);
    fireEvent.click(screen.getByRole("button", { name: "3 more here" }));
    const list = await screen.findByRole("dialog", { name: "3 more here" });
    expect(within(list).getByText("3 more here")).toBeTruthy();
    expect(list).toHaveTextContent("Claude Code");
    expect(list).toHaveTextContent("Sam Ortiz's agent · Editing");
    expect(list).toHaveTextContent("Anonymous Duck");
    expect(list).toHaveTextContent("Ff Ff");
    expect(list).not.toHaveTextContent("Aa Aa");
  });

  it("Escape closes a card and the list", async () => {
    render(<PresenceStack others={many(6)} total={6} />);
    fireEvent.click(screen.getByRole("button", { name: "3 more here" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a 500-char or HTML name renders as text, cut to 80", async () => {
    const long = `<img src=x onerror=alert(1)>${"x".repeat(500)}`;
    render(<PresenceStack others={[{ ...person(0, long) }]} total={1} />);
    const f = screen.getByRole("button");
    expect(f.getAttribute("aria-label")?.length).toBeLessThanOrEqual(80);
    fireEvent.click(f);
    const card = await screen.findByRole("dialog");
    expect(card.querySelector("img")).toBeNull();
    expect(
      card.textContent?.replace(/^\S{1,2}/, "").length,
    ).toBeLessThanOrEqual(80);
  });
});

const OWNED = (arts.find((a) => a.title === "Landing page") as { id: string })
  .id;
const frames = () => [...document.querySelectorAll("iframe")];
const POLL = (arts.find((a) => a.title === "Team poll") as { id: string }).id;
const nonceOf = (f: HTMLIFrameElement) => /#oa=([\w-]{22})$/.exec(f.src)?.[1];
/** The artifact loads and says hello, so a new version preloads and swaps. */
const opened = async (path: string, id = OWNED) => {
  mount(path);
  await waitFor(() => expect(frames().some((f) => f.src)).toBe(true), {
    timeout: 3_000,
  });
  const f = frames().find((x) => x.src) as HTMLIFrameElement;
  fireEvent.load(f);
  const w = f.contentWindow as Window;
  vi.spyOn(w, "postMessage").mockImplementation(() => {});
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          oa: 1,
          type: "hello",
          protocol: 1,
          kind: "html",
          nonce: nonceOf(f),
        },
        origin: "null",
        source: w,
      }),
    );
  });
  await waitFor(() => expect(events.connections(id)).toBe(1), {
    timeout: 3_000,
  });
};
const emit = (v: PresenceEntry[]) =>
  act(() => void events.emitPresence(OWNED, v, undefined));

describe("PresenceStack in the viewer", () => {
  it("one stack, first in the right group and before Comments; none when nobody is here", async () => {
    await opened(viewerPath(OWNED));
    expect(screen.queryByRole("group", { name: /here now/ })).toBeNull();
    emit([person(0, "Maya Chen"), anon(1)]);
    const g = await screen.findByRole("group", { name: "2 people here now" });
    expect(screen.getAllByRole("group", { name: /here now/ })).toHaveLength(1);
    const right = g.parentElement as HTMLElement;
    expect(right.firstElementChild).toBe(g);
  });

  it("with a preloaded layer mounted, exactly one stack renders", async () => {
    await opened(viewerPath(OWNED));
    emit([person(0, "Maya Chen")]);
    await screen.findByRole("group", { name: "1 people here now" });
    await act(() =>
      fetch(R.versions(OWNED), {
        method: "POST",
        headers: { "X-OA-Request": "1", "content-type": "application/json" },
        body: JSON.stringify({
          id: OWNED,
          format: "html",
          content: "<p>next</p>",
        }),
      }),
    );
    await waitFor(
      () =>
        expect(
          document.querySelectorAll("[data-preload]").length,
        ).toBeGreaterThan(1),
      { timeout: 3_000 },
    );
    expect(screen.getAllByRole("group", { name: /here now/ })).toHaveLength(1);
  });

  it("/full: the stack is inside the pill, before Exit", async () => {
    await opened(`${viewerPath(OWNED)}/full`);
    emit([person(0, "Maya Chen")]);
    const g = await screen.findByRole("group", { name: "1 people here now" });
    const bar = g.closest(".oa-fsbar") as HTMLElement;
    expect(bar).toBeTruthy();
    const exit = bar.querySelector(".oa-fsx") as HTMLElement;
    expect(
      g.compareDocumentPosition(exit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("group", { name: /here now/ })).toHaveLength(1);
  });

  it("an embed shows nothing", async () => {
    setEmbedForTests(true);
    await opened(fullPath(POLL), POLL);
    act(
      () => void events.emitPresence(POLL, [person(0, "Maya Chen")], undefined),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("group", { name: /here now/ })).toBeNull();
  });

  it("a gone artifact clears the stack", async () => {
    await opened(viewerPath(OWNED));
    emit([person(0, "Maya Chen")]);
    await screen.findByRole("group", { name: /here now/ });
    act(() => void events.emitGone(OWNED));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /here now/ })).toBeNull(),
    );
  });
});
