// #2234: the composer is an outlined field that grows with its text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELD_MAX, growField } from "../src/viewer/comments/CommentsBody";

function box(scrollHeight: number) {
  const el = document.createElement("textarea");
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
  return el;
}

describe("composer growth (#2234)", () => {
  // The script fallback runs where `field-sizing: content` is missing.
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("height follows the text", () => {
    const a = box(42);
    const b = box(120);
    growField(a);
    growField(b);
    expect(Number.parseInt(a.style.height)).toBe(42);
    expect(Number.parseInt(b.style.height)).toBe(120);
  });
  it("caps at the max, then scrolls inside", () => {
    const el = box(900);
    growField(el);
    expect(el.style.height).toBe(`${FIELD_MAX}px`);
  });
});

it("#2234: phones get a 16px field so iOS does not zoom on focus", async () => {
  const { FIELD } = await import("../src/viewer/comments/CommentsBody");
  expect(FIELD).toContain("max-[599px]:text-[16px]");
  expect(FIELD).toContain("[@media(pointer:coarse)]:text-[16px]");
});
