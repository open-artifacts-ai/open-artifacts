import { R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Delivery, MentionedText } from "../src/viewer/comments/asks";
import { installHarness, mount, server } from "./harness";

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

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;

const linked = {
  key: "agent:fox",
  name: "OA Product",
  linked: true,
  product: "Claude Code",
  animal: { id: "fox", color: 2 },
  delivery: "delivered" as const,
};
const unlinked = {
  key: "agent:bot",
  name: "Claude Code",
  linked: false,
  delivery: "queued" as const,
};
const legacy = { key: "agent:old", name: "Old Bot", delivery: "seen" as const };
const body = "Looping in @OA Product and @Claude Code and @Old Bot please";

describe("#1890 a mentioned agent shows its face", () => {
  it("a linked mention chip shows the animal tile, an unlinked one the outline, a legacy one nothing", () => {
    const { container } = render(
      <MentionedText body={body} mentions={[linked, unlinked, legacy]} />,
    );
    const chip = (t: string) =>
      [...container.querySelectorAll("[data-mention-chip]")].find((c) =>
        c.textContent?.includes(t),
      ) as HTMLElement;
    const a = chip("OA Product").querySelector<HTMLElement>("[data-avatar]");
    expect(a?.dataset.linked).toBe("true");
    expect(a?.dataset.animal).toBe("fox");
    expect(a?.style.backgroundColor).toBe("var(--oa-presence-2)");
    const b = chip("Claude Code").querySelector<HTMLElement>("[data-avatar]");
    expect(b?.dataset.linked).toBe("false");
    expect(b?.dataset.animal).toBeUndefined();
    expect(chip("Old Bot").querySelector("[data-avatar]")).toBeNull();
    // The text a reader (and a screen reader) gets is unchanged.
    expect(chip("OA Product").textContent).toBe("@OA Product");
  });
  it("a guest gets no tile", () => {
    const { container } = render(
      <MentionedText body={body} mentions={[linked, unlinked]} guest />,
    );
    expect(container.querySelector("[data-avatar]")).toBeNull();
    expect(container.querySelectorAll("[data-mention-chip]")).toHaveLength(2);
  });
  it("the delivery line carries the same face, and legacy and guests none", () => {
    const c = {
      mentions: [linked, unlinked, legacy],
    } as unknown as Parameters<typeof Delivery>[0]["c"];
    const { container, rerender } = render(<Delivery c={c} />);
    const row = (k: string) =>
      container.querySelector(`[data-mention="${k}"]`) as HTMLElement;
    expect(
      row("agent:fox").querySelector('[data-linked="true"]'),
    ).not.toBeNull();
    expect(
      row("agent:bot").querySelector('[data-linked="false"]'),
    ).not.toBeNull();
    expect(row("agent:old").querySelector("[data-avatar]")).toBeNull();
    expect(row("agent:bot").textContent).toBe(
      "Claude Code is offline · it will get this when it's back",
    );
    rerender(<Delivery c={c} guest />);
    expect(container.querySelector("[data-avatar]")).toBeNull();
  });
});

describe("#1890 an ask's addressees", () => {
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
  afterEach(() => vi.restoreAllMocks());
  const serve = (to: object[]) =>
    server.use(
      http.get(`*${R.comments(OWNED)}`, () =>
        HttpResponse.json({
          threads: [
            {
              id: "t",
              anchor: { kind: "note" },
              version: 1,
              status: "open",
              resolvedBy: null,
              resolvedAt: null,
              createdAt: "2026-11-05T10:00:00Z",
              comments: [
                {
                  id: "c",
                  body: "Which layout?",
                  author: { kind: "user", id: "o", name: "Leo", me: false },
                  createdAt: "2026-11-05T10:00:00Z",
                  editedAt: null,
                  typed: false,
                  can: { edit: false, delete: false },
                  ask: {
                    question: "Which layout?",
                    options: [
                      { id: "a", label: "List" },
                      { id: "b", label: "Detail" },
                    ],
                    to,
                    closed: false,
                  },
                },
              ],
            },
          ],
          open: 1,
          truncated: false,
        }),
      ),
    );
  const open = async () => {
    mount(viewerPath(OWNED));
    await act(async () => {
      await waitFor(() => expect(opts.length).toBeGreaterThan(0));
      opts.at(-1)?.onHello();
    });
    fireEventClick(await screen.findByRole("button", { name: /^Comments/ }));
    return screen.findByRole("complementary", { name: "Comments" });
  };
  const fireEventClick = (el: HTMLElement) => act(() => el.click());

  it("lists each addressed agent with its face", async () => {
    serve([
      {
        kind: "agent",
        id: "agent:fox",
        name: "OA Product",
        linked: true,
        animal: { id: "fox", color: 2 },
        me: false,
      },
      {
        kind: "agent",
        id: "agent:bot",
        name: "Claude Code",
        linked: false,
        me: false,
      },
    ]);
    const c = await open();
    const to = await within(c).findByText(/^To/, { selector: "[data-ask-to]" });
    expect(to.querySelector('[data-animal="fox"]')).not.toBeNull();
    expect(to.querySelector('[data-linked="false"]')).not.toBeNull();
    expect(to.textContent).toContain("OA Product");
    expect(to.textContent).toContain("Claude Code");
  });
  it("a legacy addressee adds no line", async () => {
    serve([{ kind: "agent", id: "agent:old", name: "Old Bot", me: false }]);
    const c = await open();
    await within(c).findByText("Which layout?");
    expect(c.querySelector("[data-ask-to]")).toBeNull();
  });
});
