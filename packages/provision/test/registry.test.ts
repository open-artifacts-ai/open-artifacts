import { describe, expect, it } from "vitest";
import { registryDomains, registryEntry, registryKey } from "../src/names.js";

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

  it("builds installId, origin, keys and domains, and disabled only when set", () => {
    const keys = [{ kid: "k".repeat(16), x: "x".repeat(43) }];
    const base = {
      installId: "iabc123def45",
      origin: "https://a.example",
      keys,
      domains: ["b.com", "a.com", "xn--bcher-kva.example"],
    };
    const e = registryEntry(base);
    expect(e).toEqual({
      ...base,
      domains: ["a.com", "b.com", "xn--bcher-kva.example"],
    });
    expect(Object.keys(e)).toEqual(["installId", "origin", "keys", "domains"]);
    // Always written, [] when the install has none.
    expect(registryEntry({ ...base, domains: [] }).domains).toEqual([]);
    expect(registryEntry({ ...base, disabled: true }).disabled).toBe(true);
    expect("disabled" in registryEntry({ ...base, disabled: false })).toBe(
      false,
    );
  });

  it("refuses more than 50 domains, or any that is not lowercase ASCII, unique and dot-free at the end", () => {
    const keys = [{ kid: "k".repeat(16), x: "x".repeat(43) }];
    const mk = (domains: unknown) => () =>
      registryEntry({
        installId: "iabc123def45",
        origin: "https://a.example",
        keys,
        domains: domains as string[],
      });
    const fifty = Array.from({ length: 50 }, (_, i) => `d${i}.example`);
    expect(mk(fifty)).not.toThrow();
    expect(mk([...fifty, "d50.example"])).toThrow(/more than 50 domains/);
    for (const bad of [
      "A.com",
      "a.com.",
      " a.com",
      "a.com,b.com",
      "localhost",
      "bücher.example",
      `${"a".repeat(64)}.com`,
      "",
      7,
    ])
      expect(mk([bad]), String(bad)).toThrow(/invalid domain/);
    expect(mk(["a.com", "a.com"])).toThrow(/duplicate domain/);
    expect(mk(undefined)).toThrow(/domains/);
  });

  it("registryDomains parses AUTH_DOMAINS with the shared parser: lowercased, unique, sorted", () => {
    expect(registryDomains(undefined)).toEqual([]);
    expect(registryDomains("")).toEqual([]);
    expect(registryDomains(" B.com, a.com ,b.com,, ")).toEqual([
      "a.com",
      "b.com",
    ]);
    expect(() => registryDomains("a.com,a.com.")).toThrow(
      /AUTH_DOMAINS has an invalid domain/,
    );
    expect(() =>
      registryDomains(
        Array.from({ length: 51 }, (_, i) => `d${i}.example`).join(","),
      ),
    ).toThrow(/more than 50 domains/);
  });

  it("refuses more than 2 keys (the broker rejects them)", () => {
    const k = { kid: "k".repeat(16), x: "x".repeat(43) };
    expect(() =>
      registryEntry({
        installId: "iabc123def45",
        origin: "https://a.example",
        keys: [k, k, k],
        domains: [],
      }),
    ).toThrow(/more than 2 keys/);
  });
});
