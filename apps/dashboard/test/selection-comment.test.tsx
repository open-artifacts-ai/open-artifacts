// "Comment" over a selection in a doc (#1100). Was e2e/doc-comments.spec.ts:
// the quote of several lines, a reader's chip, and the chip below the
// selection on a touch screen (#2711).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectionComment } from "../src/viewer/doc/SelectionComment";

const rect = (top: number, bottom: number) =>
  ({
    top,
    bottom,
    left: 50,
    right: 150,
    width: 100,
    height: bottom - top,
    x: 50,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

function setup(textOf: (s: Selection) => string | null = () => null) {
  const onComment = vi.fn();
  const page = createRef<HTMLDivElement>();
  const editor = createRef<HTMLDivElement>();
  render(
    <div ref={page}>
      <div ref={editor}>
        <p>We ship the landing page.</p>
        <p>Second line.</p>
      </div>
      <SelectionComment
        page={page}
        root={() => editor.current}
        onComment={onComment}
        textOf={textOf}
      />
    </div>,
  );
  vi.spyOn(
    page.current as HTMLElement,
    "getBoundingClientRect",
  ).mockReturnValue(rect(0, 800));
  // jsdom has no layout: the selection sits at 100..120.
  Range.prototype.getBoundingClientRect = () => rect(100, 120);
  const select = (from = 0, to = 1) => {
    const ps = editor.current?.querySelectorAll("p") as NodeListOf<HTMLElement>;
    const r = document.createRange();
    r.setStart(ps[from]?.firstChild as Node, 0);
    r.setEnd(ps[to]?.firstChild as Node, 5);
    act(() => {
      const s = document.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    });
  };
  return { onComment, select };
}

const matchMedia = window.matchMedia;
afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = matchMedia;
  // biome-ignore lint/performance/noDelete: jsdom has no such method
  delete (Range.prototype as { getBoundingClientRect?: unknown })
    .getBoundingClientRect;
  document.getSelection()?.removeAllRanges();
});

describe("SelectionComment", () => {
  it("shows nothing until something in the doc is selected", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("several lines become one quoted paragraph each; the chip hands them over once", () => {
    const { onComment, select } = setup(() => "Checklist\n\nFinal copy\n");
    select(0, 1);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledExactlyOnceWith(
      "> Checklist\n>\n> Final copy\n\n",
    );
    // The chip goes once it has been used.
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("falls back to the DOM's text when the doc gives none", () => {
    const { onComment, select } = setup();
    select(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith("> We sh\n\n");
  });

  it("sits above the selection with a mouse, below it on a touch screen", () => {
    const { select } = setup();
    select();
    expect(
      (
        screen.getByRole("button", { name: "Comment" })
          .parentElement as HTMLElement
      ).style.top,
    ).toBe("60px");
    document.getSelection()?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    window.matchMedia = ((q: string) =>
      ({
        matches: q === "(pointer: coarse)",
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    select();
    // Below: the selection's bottom (120) plus 8.
    expect(
      (
        screen.getByRole("button", { name: "Comment" })
          .parentElement as HTMLElement
      ).style.top,
    ).toBe("128px");
  });

  it("ignores a selection outside the doc", () => {
    setup();
    const out = document.createElement("p");
    out.textContent = "Elsewhere";
    document.body.append(out);
    const r = document.createRange();
    r.selectNodeContents(out);
    act(() => {
      document.getSelection()?.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    out.remove();
  });
});
