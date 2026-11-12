import type { Comment } from "@oa/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Delivery,
  DeliveryFaces,
  MentionedText,
} from "../src/viewer/comments/asks";

const m = (key: string, delivery: "withdrawn" | "delivered") => ({
  key,
  name: "Claude",
  linked: true,
  animal: { id: "fox", color: 1 },
  delivery,
});
const c = (delivery: "withdrawn" | "delivered") =>
  ({
    id: "c",
    mentions: [m("k1", delivery)],
    notified: [m("k1", delivery)],
  }) as unknown as Comment;

describe("#2175 / #2229 withdrawn delivery", () => {
  it("is no sentence under the comment: it is not a problem", () => {
    const { container } = render(<Delivery c={c("withdrawn")} />);
    expect(container.textContent).toBe("");
  });
  it("shows a dash in the chip, with the details on hover", () => {
    const { container } = render(
      <MentionedText
        body="hi @Claude"
        mentions={[m("k1", "withdrawn")]}
        marks
      />,
    );
    const chip = container.querySelector("[data-mention-chip]") as HTMLElement;
    expect(chip.querySelector('[data-mark="removed"]')).not.toBeNull();
    fireEvent.mouseEnter(chip);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Claude: removed before delivery",
    );
  });
  it("is listed in the faces' details but not counted", () => {
    const { container } = render(
      <DeliveryFaces told={[m("a", "delivered"), m("b", "withdrawn")]} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "1 of 1 delivered",
    );
    expect(container.querySelectorAll("[data-avatar]")).toHaveLength(1);
    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(container.querySelectorAll("[data-told]")).toHaveLength(2);
  });
  it("only withdrawn: a dash and no count", () => {
    const { container } = render(
      <DeliveryFaces told={[m("b", "withdrawn")]} />,
    );
    expect(container.querySelector('[data-mark="removed"]')).not.toBeNull();
    expect(container.querySelector("[data-summary]")).toBeNull();
  });
});
