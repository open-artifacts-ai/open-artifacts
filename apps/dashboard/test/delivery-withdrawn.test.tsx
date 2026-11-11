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
  it("reads 'Not sent: removed from this thread' for a mention and a thread reply", () => {
    const { container } = render(<Delivery c={c("withdrawn")} />);
    const lines = [...container.querySelectorAll("li")].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual([
      "Claude: Not sent: removed from this thread",
      "Claude: Not sent: removed from this thread",
    ]);
  });
});
