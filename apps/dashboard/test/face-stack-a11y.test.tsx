import type { CommentNotified } from "@oa/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryFaces, MentionedText } from "../src/viewer/comments/asks";
import { GIVE_BACK, stageFor } from "../src/viewer/comments/CommentsBody";
import { FaceStack } from "../src/viewer/comments/FaceStack";
import { useRoving } from "../src/viewer/comments/roving";

// #2247: one face stack, the marks' accessible names, one tab stop, hybrid touch.

afterEach(cleanup);

const ag = (
  name: string,
  delivery: CommentNotified["delivery"],
): CommentNotified => ({
  key: `agent:${name}`,
  name,
  linked: true,
  animal: { id: "fox", color: 1 },
  delivery,
});
const desc = (el: Element) =>
  document.getElementById(el.getAttribute("aria-describedby") ?? "")
    ?.textContent;

describe("FaceStack", () => {
  const faces = ["a", "b", "c", "d", "e"].map((k, i) => ({
    key: k,
    round: i === 0,
    el: <b>{k}</b>,
  }));
  it("shows three faces, 3px apart, ringed, the first on top, people round", () => {
    const { container } = render(<FaceStack faces={faces} more />);
    const f = [...container.querySelectorAll<HTMLElement>("[data-face]")];
    expect(f).toHaveLength(3);
    expect(f.map((x) => x.style.marginLeft)).toEqual(["0px", "-3px", "-3px"]);
    expect(f.map((x) => x.style.zIndex)).toEqual(["3", "2", "1"]);
    expect(f[0]?.className).toContain("rounded-full");
    expect(f[1]?.className).toContain("rounded-md");
    expect(f[0]?.className).toContain("ring-[1.5px]");
    expect(container.querySelector("[data-more]")?.textContent).toBe("+2");
  });
});

describe("marks are described, not renamed", () => {
  it("a chip keeps its @Name and gains the state as its description", () => {
    render(
      <MentionedText
        body="hi @OA Comments"
        mentions={[ag("OA Comments", "queued")]}
        marks
      />,
    );
    const chip = screen.getByRole("button", { name: "@OA Comments" });
    expect(desc(chip)).toBe("OA Comments: held until it's back");
  });
  it("the header mark keeps its summary and describes every agent", () => {
    render(<DeliveryFaces told={[ag("A", "delivered"), ag("B", "queued")]} />);
    const b = screen.getByRole("button", { name: "1 of 2 delivered" });
    expect(desc(b)).toBe("B: held until it's back. A: delivered");
  });
});

function Para({ n }: { n: number }) {
  const roving = useRoving<HTMLParagraphElement>();
  return (
    <p {...roving}>
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        <button key={i} type="button" data-mention-chip="">
          c{i}
        </button>
      ))}
    </p>
  );
}

describe("one tab stop per comment's chips", () => {
  it("only one chip is tabbable; arrows, Home and End move between them", () => {
    render(<Para n={3} />);
    const [a, b, c] = screen.getAllByRole("button");
    expect([a, b, c].map((x) => x?.tabIndex)).toEqual([0, -1, -1]);
    a?.focus();
    fireEvent.keyDown(a as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    expect([a, b, c].map((x) => x?.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(b as Element, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a as Element, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c as Element, { key: "Home" });
    expect(document.activeElement).toBe(a);
  });
});

describe("hybrid touch", () => {
  const chip = () => {
    render(
      <MentionedText
        body="hi @Sirius"
        mentions={[ag("Sirius", "delivered")]}
        marks
      />,
    );
    return screen.getByRole("button");
  };
  it("a tap blocks hover and focus; a keydown opens focus again", () => {
    const el = chip();
    fireEvent.pointerDown(el, { pointerType: "touch" });
    fireEvent.mouseEnter(el);
    fireEvent.focus(el);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(el);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
  it("a tap blocks hover; a mouse move opens hover again", () => {
    const el = chip();
    fireEvent.pointerDown(el, { pointerType: "touch" });
    fireEvent.mouseEnter(el);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerMove(el, { pointerType: "mouse" });
    fireEvent.mouseEnter(el);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});

describe("give-way hysteresis", () => {
  it("steps back down only GIVE_BACK wider than where it stepped up", () => {
    const gave = [0, 300, 250];
    expect(stageFor(2, gave, 250 + GIVE_BACK - 1)).toBe(2);
    expect(stageFor(2, gave, 250 + GIVE_BACK)).toBe(1);
    expect(stageFor(2, gave, 300 + GIVE_BACK)).toBe(0);
    expect(stageFor(0, gave, 100)).toBe(0);
  });
});
