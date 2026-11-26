// agy S6: one spelling for pi, and an unknown kind's own token for a letter tile.
import { describe, expect, it } from "vitest";
import {
  knownProduct,
  linkedFields,
  productOf,
} from "../src/services/agent-display.ts";

describe("agent app names (agy S6)", () => {
  it("pi is spelled the project's own way, and a grant named Pi matches it", () => {
    expect(productOf("pi")).toBe("pi");
    expect(knownProduct("Pi")).toBe("pi");
    expect(knownProduct(" PI ")).toBe("pi");
    expect(productOf("omp")).toBe("oh-my-pi");
  });

  it("a kind the server doesn't know carries its own token, never for an outsider", () => {
    expect(linkedFields({ identityId: "i", kind: "kiro" }, false)).toEqual({
      linked: true,
      appKind: "kiro",
      animal: expect.any(Object),
    });
    expect(linkedFields({ identityId: "i", kind: "kiro" }, true)).toEqual({});
    // A known kind names its product and no token.
    expect(
      linkedFields({ identityId: "i", kind: "codex" }, false),
    ).not.toHaveProperty("appKind");
  });

  it("the token is tidied and capped at 32 characters", () => {
    const f = (kind: string) =>
      linkedFields({ identityId: "i", kind }, false).appKind;
    expect(f("k".repeat(80))).toBe("k".repeat(32));
    expect(f("ki\u0000ro\u0007")).toBe("kiro");
    expect(f("   ")).toBeUndefined();
  });
});
