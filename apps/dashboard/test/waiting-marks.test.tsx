import type { ArtifactSummary, Comment } from "@oa/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LibraryWaiting } from "../src/foryou/waiting";
import { AskFrom } from "../src/viewer/comments/asks";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

// Cards carry the two optional #2778 fields.
const card = (waiting?: object) =>
  ({
    id: "a1",
    asksForYou: 3,
    ...(waiting ? { waiting } : {}),
  }) as ArtifactSummary;
const ask = (waitingSince?: string) =>
  ({
    id: "c1",
    createdAt: "2026-11-18T11:00:00Z",
    editedAt: null,
    author: { kind: "agent", id: "g", name: "OA Manager", me: false },
    ask: {
      question: "Ship it?",
      options: [],
      to: [{ kind: "user", id: "me", name: "Me", me: true }],
      closed: false,
      ...(waitingSince ? { waitingSince } : {}),
    },
  }) as unknown as Comment;

describe("waiting mark on the Library card (#1910)", () => {
  it("shows the count and the oldest wait", () => {
    render(
      <LibraryWaiting
        a={card({ count: 1, oldestSince: ago(4 * MIN) })}
        now={NOW}
      />,
    );
    expect(screen.getByText(/1 waiting 4 min/)).toBeInTheDocument();
  });
  it("reads a day the way For you does", () => {
    render(
      <LibraryWaiting
        a={card({ count: 2, oldestSince: ago(25 * 60 * MIN) })}
        now={NOW}
      />,
    );
    expect(screen.getByText(/2 waiting 1 day/)).toBeInTheDocument();
  });
  it("shows nothing when the field is absent, empty or unreadable", () => {
    const { container, rerender } = render(
      <LibraryWaiting a={card()} now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <LibraryWaiting
        a={card({ count: 0, oldestSince: ago(MIN) })}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <LibraryWaiting a={card({ count: 1, oldestSince: "nope" })} now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("waiting mark on the page's ask card (#1910)", () => {
  it("shows waiting with the age when waitingSince is present", () => {
    render(<AskFrom c={ask(new Date(Date.now() - 4 * MIN).toISOString())} />);
    expect(screen.getByText(/waiting 4 min/)).toBeInTheDocument();
  });
  it("shows no mark when waitingSince is absent", () => {
    render(<AskFrom c={ask()} />);
    expect(screen.queryByText(/waiting/)).toBeNull();
    expect(screen.getByText(/OA Manager/)).toBeInTheDocument();
  });
});
