import { describe, expect, it } from "vitest";
import { nodeVersionError } from "../src/steps/prereqs.ts";

describe("prereqs Node floor", () => {
  it("refuses Node 22.12 with setup's own message", () => {
    expect(nodeVersionError("22.12.0")).toBe(
      "Node >= 22.13 required (found 22.12.0)",
    );
  });
  it("refuses Node 20", () => {
    expect(nodeVersionError("20.19.0")).toBe(
      "Node >= 22.13 required (found 20.19.0)",
    );
  });
  it("accepts 22.13, later 22s and later majors", () => {
    for (const v of ["22.13.0", "22.21.0", "24.0.0"])
      expect(nodeVersionError(v), v).toBeUndefined();
  });
});
