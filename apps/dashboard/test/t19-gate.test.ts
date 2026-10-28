import { describe, expect, it } from "vitest";
import { below, gate } from "../e2e/staging/gate";

// T19's version gate: an unpinned run skips a flow rl-a can't run yet; the
// pinned gate run (T19_EXPECT_VERSION) fails it instead, never skips.
describe("T19 gate", () => {
  it("orders versions numerically", () => {
    expect(below("0.72.0", "0.73.0")).toBe(true);
    expect(below("0.9.0", "0.10.0")).toBe(true);
    expect(below("0.73.0", "0.73.0")).toBe(false);
    expect(below("1.0.0", "0.73.0")).toBe(false);
    expect(below("0.73.0-rc.1", "0.73.0")).toBe(false);
  });

  it("unpinned: an older rl-a skips", () => {
    expect(gate("#766", "0.73.0", "0.72.0", undefined)).toBe("needs 0.73.0");
    expect(gate("#766", "0.73.0", "0.72.0", "")).toBe("needs 0.73.0");
  });

  it("pinned: an older rl-a fails, naming the flow", () => {
    expect(() => gate("#766", "0.73.0", "0.72.0", "0.72.0")).toThrow(
      "T19 gate: #766 needs 0.73.0, rl-a is 0.72.0",
    );
  });

  it("runs when rl-a is new enough, pinned or not", () => {
    expect(gate("#766", "0.73.0", "0.73.0", undefined)).toBeNull();
    expect(gate("#766", "0.73.0", "0.74.1", "0.74.1")).toBeNull();
  });
});
