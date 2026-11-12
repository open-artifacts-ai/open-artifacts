import type { Comment, CommentMention } from "@oa/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Delivery,
  DeliveryFaces,
  MentionedText,
  newProblems,
} from "../src/viewer/comments/asks";

const ag = (
  name: string,
  delivery: CommentMention["delivery"],
  key = `agent:${name}`,
): CommentMention => ({
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
    expect(chip.getAttribute("aria-label")).toBe("Sirius: delivered");
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
});
