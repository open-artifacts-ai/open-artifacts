import { describe, expect, it } from "vitest";
import { pinChanged } from "../src/viewer/comments/model";

describe("pinChanged (#1490)", () => {
  const h = "a".repeat(64);
  it("is true only when both hashes are known and differ", () => {
    expect(pinChanged(h, "b".repeat(64))).toBe(true);
    expect(pinChanged(h, h)).toBe(false);
  });
  it("is false when either side is null", () => {
    expect(pinChanged(null, h)).toBe(false);
    expect(pinChanged(h, null)).toBe(false);
    expect(pinChanged(null, null)).toBe(false);
  });
});
