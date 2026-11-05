import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { below, gate, leoPin } from "../e2e/staging/gate";

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

  it("leo has its own pin: rl-a's alone never checks leo (#1251)", () => {
    expect(leoPin({ T19_EXPECT_VERSION: "0.97.0" })).toBeUndefined();
    expect(leoPin({})).toBeUndefined();
    expect(leoPin({ T19_EXPECT_LEO_VERSION: "" })).toBeUndefined();
    expect(
      leoPin({
        T19_EXPECT_VERSION: "0.97.0",
        T19_EXPECT_LEO_VERSION: "0.96.0",
      }),
    ).toBe("0.96.0");
    // The spec reads leo's pin through leoPin, never rl-a's variable.
    const spec = readFileSync(
      resolve(__dirname, "../e2e/staging/leo/readonly.spec.ts"),
      "utf8",
    );
    expect(spec).toContain("leoPin(process.env)");
    expect(spec).not.toContain("process.env.T19_EXPECT_VERSION");
  });
});
