import { describe, expect, it } from "vitest";
import { registryEntry, registryKey } from "../src/names.js";

// The auth broker (apps/auth-broker/src/registry.ts) reads exactly this key
// and shape; apps/auth-broker/test/registry-contract.test.ts round-trips it.
describe("install registry format", () => {
  it("keys an entry as install:<id>", () => {
    expect(registryKey("iabc123def45")).toBe("install:iabc123def45");
  });

  it("refuses an id that is not an install id", () => {
    for (const bad of [
      "",
      "IABC123DEF45",
      "install:iabc123def45",
      "install:x",
      "../iabc123def45",
      "iabc123def45/x",
      "iabc123def45a",
      `i${"a".repeat(64)}`,
    ])
      expect(() => registryKey(bad), bad).toThrow(/not an install id/);
  });

  it("builds installId, origin and keys, and disabled only when set", () => {
    const keys = [{ kid: "k".repeat(16), x: "x".repeat(43) }];
    const e = registryEntry({
      installId: "iabc123def45",
      origin: "https://a.example",
      keys,
    });
    expect(e).toEqual({
      installId: "iabc123def45",
      origin: "https://a.example",
      keys,
    });
    expect(Object.keys(e)).toEqual(["installId", "origin", "keys"]);
    expect(
      registryEntry({
        installId: "iabc123def45",
        origin: "https://a.example",
        keys,
        disabled: true,
      }).disabled,
    ).toBe(true);
    expect(
      "disabled" in
        registryEntry({
          installId: "iabc123def45",
          origin: "https://a.example",
          keys,
          disabled: false,
        }),
    ).toBe(false);
  });

  it("refuses more than 2 keys (the broker rejects them)", () => {
    const k = { kid: "k".repeat(16), x: "x".repeat(43) };
    expect(() =>
      registryEntry({
        installId: "iabc123def45",
        origin: "https://a.example",
        keys: [k, k, k],
      }),
    ).toThrow(/more than 2 keys/);
  });
});
