import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalArgs, canonicalArgsSha256 } from "../src/index.ts";

describe("canonicalArgs (#3108)", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalArgs({ b: 1, a: { d: [3, 1], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    );
  });
  it("gives the same text for parsed args and the rollout's JSON text", () => {
    const text = '{ "id": "abc", "body": "hi \\u00e9", "n": 1.50 }';
    expect(canonicalArgs(JSON.parse(text))).toBe(
      canonicalArgs({ n: 1.5, body: "hi é", id: "abc" }),
    );
  });
  it("refuses what is not plain JSON", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(canonicalArgs(cyc)).toBeUndefined();
    expect(canonicalArgs({ n: Number.NaN })).toBeUndefined();
    expect(canonicalArgs({ f: () => 1 })).toBeUndefined();
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(canonicalArgs(deep)).toBeUndefined();
  });
  it("hashes the canonical text with sha256", async () => {
    const want = createHash("sha256").update('{"a":1}').digest("hex");
    expect(await canonicalArgsSha256({ a: 1 })).toBe(want);
    expect(await canonicalArgsSha256(undefined)).toBeUndefined();
  });
});
