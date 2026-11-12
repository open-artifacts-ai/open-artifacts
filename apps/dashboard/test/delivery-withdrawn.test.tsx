import type { Comment } from "@oa/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Delivery } from "../src/viewer/comments/asks";

const c = (delivery: "withdrawn" | "delivered") =>
  ({
    mentions: [{ key: "k1", name: "Claude", delivery }],
    notified: [{ key: "k1", name: "Claude", delivery }],
  }) as unknown as Comment;

describe("#2175 withdrawn delivery line", () => {
  it("reads 'Removed before delivery' for a mention and a thread reply", () => {
    const { container } = render(<Delivery c={c("withdrawn")} />);
    const lines = [...container.querySelectorAll("li")].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual([
      "Claude: Removed before delivery",
      "Claude: Removed before delivery",
    ]);
  });
});
