import { describe, expect, it } from "vitest";
import { semverGte } from "../src/semver.ts";

describe("semverGte", () => {
  it("compares major.minor.patch numerically", () => {
    expect(semverGte("1.2.3", "1.2.3")).toBe(true);
    expect(semverGte("1.2.4", "1.2.3")).toBe(true);
    expect(semverGte("1.10.0", "1.9.9")).toBe(true);
    expect(semverGte("2.0.0", "1.99.99")).toBe(true);
    expect(semverGte("1.2.2", "1.2.3")).toBe(false);
    expect(semverGte("0.9.10", "0.10.0")).toBe(false);
  });
  it("handles 0.0.0", () => {
    expect(semverGte("0.0.0", "0.0.0")).toBe(true);
    expect(semverGte("0.0.1", "0.0.0")).toBe(true);
    expect(semverGte("0.0.0", "0.0.1")).toBe(false);
    expect(semverGte("0.0.0", "0.1.0")).toBe(false);
  });
  it("ranks a pre-release below its release", () => {
    expect(semverGte("1.2.3-rc.1", "1.2.3")).toBe(false);
    expect(semverGte("1.2.3", "1.2.3-rc.1")).toBe(true);
    expect(semverGte("1.2.4-rc.1", "1.2.3")).toBe(true);
    expect(semverGte("0.0.0-pending", "0.0.0")).toBe(false);
  });
  it("ignores build metadata", () => {
    expect(semverGte("1.2.3+abc", "1.2.3")).toBe(true);
    expect(semverGte("1.2.3", "1.2.3+abc")).toBe(true);
    expect(semverGte("1.2.3-rc.1+abc", "1.2.3")).toBe(false);
  });
  it("returns false on malformed input", () => {
    for (const bad of [
      "",
      "1",
      "1.2",
      "1.2.3.4",
      "v1.2.3",
      " 1.2.3",
      "1.2.x",
      "01.2.3",
      "1.-2.3",
      "1.2.3-",
      "1.2.3+",
      "１.2.3",
      "99999999999999999999.0.0",
    ]) {
      expect(semverGte(bad, "0.0.0"), bad).toBe(false);
      expect(semverGte("9.9.9", bad), bad).toBe(false);
    }
  });
});
