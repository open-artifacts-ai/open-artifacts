// #2610 part 2: the box for a new thread shows the page's agent it will
// notify (PROVISIONAL api/pageAgent.ts), and ✕ sends notifyPageAgent: false.
import { type Me, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calls, installHarness, mount, mountHosted, server } from "./harness";

type Opts = {
  iframe: HTMLIFrameElement;
  url: string;
  onHello: () => void;
  onCommentSelect: (a: unknown) => void;
};
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
        commentOnSelection: () => {},
        clearSelection: () => {},
      };
    },
  };
});

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const AGENT = {
  key: "agent:0123456789abcdef0123456789abcdef",
  name: "OA Design",
  linked: true,
  animal: { id: "duck", color: 6 },
};
/** GET R.artifact with (or without) the page's agent. */
const withPageAgent = (pageAgent: object | null) =>
  http.get(`*${R.artifact(OWNED)}`, () => {
    const a = fixtures.artifacts.find((x) => x.id === OWNED);
    return HttpResponse.json({ ...a, ...(pageAgent ? { pageAgent } : {}) });
  });

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

const col = async () => {
  const b = await screen.findByRole("button", { name: /^Comments/ });
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  return screen.findByRole("complementary", { name: "Comments" });
};
const chip = () => document.querySelector("[data-notify-chip]");
/** POSTs of new threads, read live (calls() fills as requests go). */
const posts = () => {
  const all = calls("POST");
  return {
    get list() {
      return all.filter((c) => c.path === R.comments(OWNED));
    },
  };
};
const noteBox = (c: HTMLElement) =>
  within(c).getByRole("textbox", { name: "Comment on the whole page" });

describe("the chip on a new thread (#2610)", () => {
  it("a plain note: Notifying {agent}, sent by default", async () => {
    server.use(withPageAgent({ ...AGENT, for: null }));
    const p = posts();
    mount(viewerPath(OWNED));
    const c = await col();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()?.textContent).toContain("Notifying");
    expect(chip()?.textContent).toContain("OA Design");
    expect(
      within(chip() as HTMLElement).getByRole("button", {
        name: "Stop notifying OA Design",
      }),
    ).toBeTruthy();
    fireEvent.change(noteBox(c), { target: { value: "Hello" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(p.list[0]?.body).toMatchObject({ body: "Hello" }),
    );
    expect(p.list[0]?.body).not.toHaveProperty("notifyPageAgent");
  });

  it("✕ removes it and the thread opts out", async () => {
    server.use(withPageAgent({ ...AGENT, for: null }));
    const p = posts();
    mount(viewerPath(OWNED));
    const c = await col();
    await waitFor(() => expect(chip()).not.toBeNull());
    fireEvent.click(
      within(chip() as HTMLElement).getByRole("button", {
        name: "Stop notifying OA Design",
      }),
    );
    expect(chip()).toBeNull();
    fireEvent.change(noteBox(c), { target: { value: "Quietly" } });
    fireEvent.click(within(c).getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(p.list[0]?.body).toMatchObject({ notifyPageAgent: false }),
    );
    // The next note starts with the chip again.
    await waitFor(() => expect(chip()).not.toBeNull());
  });

  it("a teammate's agent says whose it is", async () => {
    server.use(withPageAgent({ ...AGENT, for: "Leo Urbina" }));
    mount(viewerPath(OWNED));
    await col();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()?.textContent).toContain("OA Design · Leo's agent");
  });

  it("a comment on selected text: the chip, and the opt-out with it", async () => {
    server.use(withPageAgent({ ...AGENT, for: null }));
    const p = posts();
    mount(viewerPath(OWNED));
    await col();
    await act(async () => {
      await waitFor(() => expect(opts.length).toBeGreaterThan(0));
      opts.at(-1)?.onHello();
    });
    await act(async () =>
      opts.at(-1)?.onCommentSelect({
        kind: "text",
        exact: "Landing",
        prefix: "",
        suffix: "",
      }),
    );
    const box = await screen.findByRole("textbox", { name: "Add a comment" });
    const card = box.closest("[data-oa-composing]") as HTMLElement;
    const sel = await waitFor(() => {
      const el = card.querySelector("[data-notify-chip]");
      if (!el) throw new Error("no chip");
      return el as HTMLElement;
    });
    fireEvent.click(
      within(sel).getByRole("button", { name: "Stop notifying OA Design" }),
    );
    fireEvent.change(box, { target: { value: "On this word" } });
    fireEvent.click(within(card).getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(p.list[0]?.body).toMatchObject({
        anchor: { kind: "text" },
        notifyPageAgent: false,
      }),
    );
  });

  it("no chip without a page agent (a person published it)", async () => {
    server.use(withPageAgent(null));
    mount(viewerPath(OWNED));
    const c = await col();
    noteBox(c);
    await new Promise((r) => setTimeout(r, 200));
    expect(chip()).toBeNull();
  });

  it("no chip for a guest, even if the field came", async () => {
    mountHosted(
      viewerPath(OWNED),
      true,
      (m: Me): Me => ({ ...m, user: { ...m.user, role: "guest" } }),
      [withPageAgent({ ...AGENT, for: "Leo Urbina" })],
    );
    await col();
    await new Promise((r) => setTimeout(r, 300));
    expect(chip()).toBeNull();
  });

  it("no chip on a reply", async () => {
    server.use(withPageAgent({ ...AGENT, for: null }));
    mount(viewerPath(OWNED));
    const c = await col();
    await waitFor(() => expect(chip()).not.toBeNull());
    // The one chip is the note box's; a thread's reply box has none.
    const t = (await within(c).findAllByRole("button", { name: /^Reply/ }))[0];
    if (t) fireEvent.click(t);
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelectorAll("[data-notify-chip]")).toHaveLength(1);
  });
});
