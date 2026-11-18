import { describe, expect, it } from "vitest";
import {
  besideWidth,
  placeBeside,
  placeBesideRect,
} from "../src/viewer/comments/pinPlacement";

const frame = { w: 940, h: 700 };
const box = { w: 320, h: 180 };
const inside = (p: { left: number; top: number }) =>
  p.left >= 8 &&
  p.top >= 8 &&
  p.left + box.w <= frame.w - 8 &&
  p.top + box.h <= frame.h - 8;

describe("the box beside a new flag (#2019)", () => {
  it("opens to the right of the flag, level with it", () => {
    const p = placeBeside({ x: 200, y: 300 }, frame, box);
    expect(p.left).toBe(240);
    expect(p.top).toBe(266);
  });

  it("flips left near the right edge and up near the bottom, staying in view", () => {
    const p = placeBeside({ x: 930, y: 690 }, frame, box);
    expect(inside(p)).toBe(true);
    // Clear of the flag, which sits at x..x+30 (or left of x at the edge).
    expect(p.left + box.w).toBeLessThanOrEqual(930 - 30);
    expect(p.top + box.h).toBeLessThanOrEqual(frame.h - 8);
  });

  it("stays in view in every corner and on a narrow frame", () => {
    for (const x of [0, 470, 940])
      for (const y of [0, 350, 700])
        expect(inside(placeBeside({ x, y }, frame, box))).toBe(true);
    const narrow = { w: 300, h: 500 };
    const w = besideWidth(narrow.w);
    const p = placeBeside({ x: 250, y: 480 }, narrow, { w, h: 180 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + w).toBeLessThanOrEqual(narrow.w - 8);
  });
});

describe("the card beside an ask's mark (#2426)", () => {
  const r = { x: 100, y: 200, width: 60, height: 18 };
  const onScreen = (
    p: { left: number; top: number },
    f: typeof frame,
    b: typeof box,
  ) =>
    p.left >= 8 &&
    p.top >= 8 &&
    p.left + b.w <= f.w - 8 &&
    p.top + b.h <= f.h - 8;
  it("sits below the mark, so the quote stays readable", () => {
    const p = placeBesideRect(r, frame, box);
    expect(p.top).toBeGreaterThanOrEqual(r.y + r.height);
    expect(onScreen(p, frame, box)).toBe(true);
  });
  it("goes above a mark near the bottom", () => {
    const p = placeBesideRect({ ...r, y: 600 }, frame, box);
    expect(p.top + box.h).toBeLessThanOrEqual(600);
  });
  it("at 390px wide it stays on screen, below or above the mark", () => {
    const narrow = { w: 390, h: 700 };
    const b = { w: besideWidth(narrow.w), h: 180 };
    for (const y of [100, 650]) {
      const p = placeBesideRect(
        { x: 150, y, width: 60, height: 18 },
        narrow,
        b,
      );
      expect(onScreen(p, narrow, b)).toBe(true);
    }
    expect(
      placeBesideRect({ x: 150, y: 100, width: 60, height: 18 }, narrow, b).top,
    ).toBeGreaterThan(118);
    expect(
      placeBesideRect({ x: 150, y: 650, width: 60, height: 18 }, narrow, b).top,
    ).toBeLessThan(650);
  });
});
