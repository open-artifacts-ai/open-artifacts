import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AskFrom } from "../src/viewer/comments/asks";

const ask = (over: Record<string, unknown>) =>
  ({
    author: { name: "OA Manager", kind: "agent" },
    createdAt: "2026-11-18T10:00:00.000Z",
    editedAt: null,
    ask: {
      to: [{ me: true, kind: "user", name: "Leo" }],
      options: [],
      ...over,
    },
    // biome-ignore lint/suspicious/noExplicitAny: a minimal comment for the header
  }) as any;

describe("approval mark on an ask", () => {
  afterEach(cleanup);
  it("shows the Approval mark on a passkey ask", () => {
    render(<AskFrom c={ask({ confirm: "passkey", closed: false })} />);
    expect(
      screen.getByText("Approval").closest("[data-ask-approval]"),
    ).not.toBeNull();
  });
  it("shows nothing on a plain ask", () => {
    render(<AskFrom c={ask({ closed: false })} />);
    expect(document.querySelector("[data-ask-approval]")).toBeNull();
  });
  it("drops the mark once the ask is closed", () => {
    render(<AskFrom c={ask({ confirm: "passkey", closed: true })} />);
    expect(document.querySelector("[data-ask-approval]")).toBeNull();
  });
});
