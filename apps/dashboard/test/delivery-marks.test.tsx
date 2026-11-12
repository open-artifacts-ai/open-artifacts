import type { Comment, CommentNotified } from "@oa/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Delivery,
  DeliveryFaces,
  HELD_AFTER_MS,
  MentionedText,
  newProblems,
} from "../src/viewer/comments/asks";

const ag = (
  name: string,
  delivery: CommentNotified["delivery"],
  key = `agent:${name}`,
): CommentNotified => ({
  key,
  name,
  linked: true,
  animal: { id: "fox", color: 1 },
  delivery,
});
const comment = (id: string, over: Partial<Comment> = {}) =>
  ({ id, body: "x", ...over }) as unknown as Comment;

describe("#2229 the mark inside the chip", () => {
  const states = [
    ["delivered", "ok"],
    ["seen", "ok"],
    ["queued", "wait"],
    ["gone", "wait"],
  ] as const;
  for (const [d, mark] of states) {
    it(`${d} shows ${mark === "ok" ? "two ticks" : "a clock"}`, () => {
      const { container } = render(
        <MentionedText body="hi @Sirius" mentions={[ag("Sirius", d)]} marks />,
      );
      const chip = container.querySelector("[data-mention-chip]");
      expect(chip?.querySelector(`[data-mark="${mark}"]`)).not.toBeNull();
      expect(chip?.textContent).toBe("@Sirius");
    });
  }
  it("no marks without the prop, and none for a guest", () => {
    const m = [ag("Sirius", "delivered")];
    const a = render(<MentionedText body="hi @Sirius" mentions={m} />);
    expect(a.container.querySelector("[data-mark]")).toBeNull();
    const b = render(
      <MentionedText body="hi @Sirius" mentions={m} guest marks />,
    );
    expect(b.container.querySelector("[data-mark]")).toBeNull();
    expect(b.container.querySelector("[data-avatar]")).toBeNull();
  });
  it("details open on hover, focus and tap, and close on Escape", () => {
    const { container } = render(
      <MentionedText
        body="hi @Sirius"
        mentions={[ag("Sirius", "delivered")]}
        marks
      />,
    );
    const chip = container.querySelector("[data-mention-chip]") as HTMLElement;
    expect(screen.queryByRole("tooltip")).toBeNull();
    // #2247: the name is the visible text; the state is the description.
    expect(chip.hasAttribute("aria-label")).toBe(false);
    expect(
      document.getElementById(chip.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Sirius: delivered");
    fireEvent.mouseEnter(chip);
    expect(screen.getByRole("tooltip").textContent).toBe("Sirius: delivered");
    fireEvent.mouseLeave(chip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(chip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });
  it("a held mention's details say so", () => {
    const { container } = render(
      <MentionedText
        body="hi @Sirius"
        mentions={[ag("Sirius", "queued")]}
        marks
      />,
    );
    fireEvent.mouseEnter(
      container.querySelector("[data-mention-chip]") as Element,
    );
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Sirius: held until it's back",
    );
  });
});

describe("#2229 faces in the header", () => {
  const six = [
    ag("A", "delivered"),
    ag("B", "delivered"),
    ag("C", "delivered"),
    ag("D", "delivered"),
    ag("E", "queued"),
    ag("F", "delivered"),
  ];
  it("shows three faces, +3, and one summary mark with 4 of 6 less the held", () => {
    const { container } = render(<DeliveryFaces told={six} />);
    expect(container.querySelectorAll("[data-avatar]")).toHaveLength(3);
    expect(container.querySelector("[data-more]")?.textContent).toBe("+3");
    expect(container.querySelector("[data-summary]")?.textContent).toBe(
      "5 of 6",
    );
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(1);
    expect(
      container.querySelector("[data-mark]")?.getAttribute("data-mark"),
    ).toBe("wait");
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "5 of 6 delivered",
    );
  });
  it("two agents all delivered: two faces, two ticks, no count", () => {
    const { container } = render(<DeliveryFaces told={six.slice(0, 2)} />);
    expect(container.querySelectorAll("[data-avatar]")).toHaveLength(2);
    expect(container.querySelector("[data-more]")).toBeNull();
    expect(container.querySelector("[data-summary]")).toBeNull();
    expect(container.querySelector('[data-mark="ok"]')).not.toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "2 of 2 delivered",
    );
  });
  it("lists every agent on hover, problems first", () => {
    const { container } = render(<DeliveryFaces told={six} />);
    fireEvent.mouseEnter(container.querySelector("button") as Element);
    const rows = [...container.querySelectorAll("[data-told]")];
    expect(rows).toHaveLength(6);
    expect(rows[0]?.textContent).toBe("E: held until it's back");
    expect(rows[1]?.textContent).toBe("A: delivered");
  });
  it("opens on focus", () => {
    const { container } = render(<DeliveryFaces told={six} />);
    fireEvent.focus(container.querySelector("button") as Element);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});

describe("#2229 a problem gets its sentence once", () => {
  const held = (id: string) =>
    comment(id, { notified: [ag("Sirius", "queued")] });
  it("only the first comment it happens in carries it", () => {
    const cs = [held("c1"), held("c2"), comment("c3")];
    const m = newProblems(cs);
    expect([...m.keys()]).toEqual(["c1"]);
    const { container } = render(<Delivery c={cs[0] as Comment} />);
    expect(container.textContent).toBe(
      "Sirius is offline. Held until it's back.",
    );
    const again = render(
      <Delivery c={cs[1] as Comment} problems={m.get("c2") ?? []} />,
    );
    expect(again.container.textContent).toBe("");
  });
  it("a new agent, or a new state, gets its own", () => {
    const cs = [
      held("c1"),
      comment("c2", { notified: [ag("Sirius", "queued"), ag("Vega", "gone")] }),
      comment("c3", { notified: [ag("Sirius", "gone")] }),
    ];
    const m = newProblems(cs);
    expect(m.get("c2")?.map((p) => p.m.name)).toEqual(["Vega"]);
    expect(m.get("c3")?.map((p) => p.m.name)).toEqual(["Sirius"]);
  });
  it("delivered agents have no line at all", () => {
    const c = comment("c1", {
      mentions: [ag("Sirius", "delivered")],
      notified: [ag("Vega", "seen")],
    });
    expect(render(<Delivery c={c} />).container.textContent).toBe("");
  });
});

describe("#2229 copy and face stack", () => {
  it("expired: the sentence once, and the one-shape hover", () => {
    const c = comment("c1", { notified: [ag("Vega", "gone")] });
    expect(render(<Delivery c={c} />).container.textContent).toBe(
      "Vega didn't get this: it was offline too long. @-mention it to try again.",
    );
    const { container } = render(<DeliveryFaces told={[ag("Vega", "gone")]} />);
    fireEvent.mouseEnter(container.querySelector("button") as Element);
    expect(container.querySelector("[data-told]")?.textContent).toBe(
      "Vega: expired, offline too long",
    );
  });
  it("faces overlap by 3px in a card-coloured ring, the first on top", () => {
    const { container } = render(
      <DeliveryFaces told={[ag("A", "delivered"), ag("B", "delivered")]} />,
    );
    const f = [...container.querySelectorAll<HTMLElement>("[data-face]")];
    expect(f.map((x) => x.style.marginLeft)).toEqual(["0px", "-3px"]);
    expect(Number(f[0]?.style.zIndex)).toBeGreaterThan(
      Number(f[1]?.style.zIndex),
    );
    expect(f[0]?.className).toContain("ring-[1.5px]");
    expect(f[0]?.className).toContain("ring-card");
  });
  it("compact: the summary mark and its count, no faces", () => {
    const { container } = render(
      <DeliveryFaces
        compact
        told={[ag("A", "delivered"), ag("B", "queued")]}
      />,
    );
    expect(container.querySelector("[data-face]")).toBeNull();
    expect(container.querySelector("[data-summary]")?.textContent).toBe(
      "1 of 2",
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "1 of 2 delivered",
    );
  });

  it("a gone mention: Product's sentence and hover", () => {
    const c = comment("c1", { mentions: [ag("Vega", "gone")] });
    expect(render(<Delivery c={c} />).container.textContent).toBe(
      "Vega isn't on the bus anymore. Mention another agent.",
    );
    const { container } = render(
      <MentionedText body="hi @Vega" mentions={[ag("Vega", "gone")]} marks />,
    );
    fireEvent.mouseEnter(
      container.querySelector("[data-mention-chip]") as Element,
    );
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Vega: not on the bus",
    );
  });

  it("Escape on an open mark closes it and goes no further", () => {
    const outer = vi.fn();
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands for the panel's key handler
      <div onKeyDown={outer}>
        <MentionedText
          body="hi @Vega"
          mentions={[ag("Vega", "delivered")]}
          marks
        />
      </div>,
    );
    const chip = container.querySelector("[data-mention-chip]") as HTMLElement;
    // Closed: Escape is not ours, it goes on to the panel.
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    outer.mockClear();
    fireEvent.mouseEnter(chip);
    const keep = fireEvent.keyDown(chip, { key: "Escape" });
    expect(keep).toBe(false);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("a second tap closes it, whatever hover or focus the browser fakes", () => {
    const { container } = render(
      <MentionedText
        body="hi @Vega"
        mentions={[ag("Vega", "delivered")]}
        marks
      />,
    );
    const chip = container.querySelector("[data-mention-chip]") as HTMLElement;
    const tap = () => {
      fireEvent.pointerDown(chip, { pointerType: "touch" });
      fireEvent.mouseEnter(chip);
      fireEvent.focus(chip);
      fireEvent.click(chip);
    };
    tap();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    tap();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("details stay inside the comment's column", () => {
    const rect = (l: number, r: number) =>
      ({
        left: l,
        right: r,
        top: 0,
        bottom: 0,
        width: r - l,
        height: 0,
      }) as DOMRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-comment")) return rect(0, 300);
        if (this.hasAttribute("data-delivery-detail")) {
          const t = this.style.transform.match(/-?\d+/);
          return rect(260 + Number(t?.[0] ?? 0), 360 + Number(t?.[0] ?? 0));
        }
        return rect(0, 0);
      });
    try {
      const { container } = render(
        <li data-comment="c">
          <MentionedText
            body="hi @Vega"
            mentions={[ag("Vega", "delivered")]}
            marks
          />
        </li>,
      );
      fireEvent.mouseEnter(
        container.querySelector("[data-mention-chip]") as Element,
      );
      expect(
        (container.querySelector("[data-delivery-detail]") as HTMLElement).style
          .transform,
      ).toBe("translateX(-60px)");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the header lists every agent the comment notified", () => {
  const rows = (c: HTMLElement) =>
    [...c.querySelectorAll("[data-told]")].map((r) => r.textContent);
  const hover = (c: HTMLElement) =>
    fireEvent.mouseEnter(c.querySelector("button") as Element);
  it("mentions only", () => {
    const { container } = render(
      <DeliveryFaces mentions={[ag("Sirius", "delivered")]} />,
    );
    hover(container);
    expect(rows(container)).toEqual(["Sirius: delivered"]);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "1 of 1 delivered",
    );
  });
  it("notified only", () => {
    const { container } = render(
      <DeliveryFaces told={[ag("Vega", "delivered")]} />,
    );
    hover(container);
    expect(rows(container)).toEqual(["Vega: delivered"]);
  });
  it("both, mentions first, a duplicate key once", () => {
    const { container } = render(
      <DeliveryFaces
        mentions={[ag("Sirius", "delivered"), ag("Vega", "delivered")]}
        told={[ag("Rigel", "delivered"), ag("Vega", "delivered")]}
      />,
    );
    hover(container);
    expect(rows(container)).toEqual([
      "Sirius: delivered",
      "Vega: delivered",
      "Rigel: delivered",
    ]);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "3 of 3 delivered",
    );
  });
});

describe("a queued notice is sending until the comment is 30s old", () => {
  afterEach(() => vi.useRealTimers());
  const T0 = Date.parse("2026-11-12T10:00:00Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  it("header: sending, then held once the timer passes 30s", () => {
    vi.useFakeTimers({ now: T0 + 5_000 });
    const { container } = render(
      <DeliveryFaces told={[ag("Vega", "queued")]} createdAt={at(0)} />,
    );
    expect(container.querySelector('[data-mark="sending"]')).not.toBeNull();
    expect(container.querySelector('[data-mark="wait"]')).toBeNull();
    fireEvent.mouseEnter(container.querySelector("button") as Element);
    expect(container.querySelector("[data-told]")?.textContent).toBe(
      "Vega: sending",
    );
    act(() => {
      vi.advanceTimersByTime(HELD_AFTER_MS);
    });
    expect(container.querySelector('[data-mark="wait"]')).not.toBeNull();
    expect(container.querySelector("[data-told]")?.textContent).toBe(
      "Vega: held until it's back",
    );
  });
  it("header: already over 30s old is held at once, no timer left", () => {
    vi.useFakeTimers({ now: T0 + HELD_AFTER_MS + 1 });
    const { container } = render(
      <DeliveryFaces told={[ag("Vega", "queued")]} createdAt={at(0)} />,
    );
    expect(container.querySelector('[data-mark="wait"]')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("chip: sending, then held", () => {
    vi.useFakeTimers({ now: T0 + 1_000 });
    const { container } = render(
      <MentionedText
        body="hi @Vega"
        mentions={[ag("Vega", "queued")]}
        marks
        createdAt={at(0)}
      />,
    );
    const chip = container.querySelector("[data-mention-chip]") as Element;
    expect(chip.querySelector('[data-mark="sending"]')).not.toBeNull();
    fireEvent.mouseEnter(chip);
    expect(screen.getByRole("tooltip").textContent).toBe("Vega: sending");
    act(() => {
      vi.advanceTimersByTime(HELD_AFTER_MS);
    });
    expect(chip.querySelector('[data-mark="wait"]')).not.toBeNull();
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Vega: held until it's back",
    );
  });
  it("delivered never shows sending, and sets no timer", () => {
    vi.useFakeTimers({ now: T0 + 1_000 });
    const { container } = render(
      <DeliveryFaces told={[ag("Vega", "delivered")]} createdAt={at(0)} />,
    );
    expect(container.querySelector('[data-mark="sending"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
