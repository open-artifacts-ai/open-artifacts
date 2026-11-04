import { describe, expect, it } from "vitest";
import { excerptOf, receiptText } from "../src/index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to match controls
const bad = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏﻿"]/;
describe("excerpt adversarial", () => {
  for (const b of [
    "a‮b",
    "a​b",
    "x\u001b]0;t\u0007y",
    "x\u009b31m",
    "x\u001bPq\u001b\\y",
    "⁦a⁩",
    "a\u0085b",
    "\u001b[",
    "a\u001b]8;;http://e\u0007z",
    "﻿q",
    "“q”",
    "a­b",
  ]) {
    it(JSON.stringify(b), () => {
      const e = excerptOf(b) ?? "";
      expect(e).not.toMatch(bad);
    });
  }
  it("40 boundary surrogate", () => {
    const e = excerptOf(`${"a".repeat(39)}😀z`) ?? "";
    expect(e.includes("�")).toBe(false);
    expect(Array.from(e).length).toBeLessThanOrEqual(41);
  });
  it("space at cut", () => {
    expect(excerptOf(`${"a".repeat(39)} b`)).toBe(`${"a".repeat(39)}…`);
  });
  it("lines<=80", () => {
    for (const r of [
      { state: "expired" },
      { state: "expired", reason: "recipient_closed" },
      { state: "refused", reason: "revoked" },
    ] as Parameters<typeof receiptText>[0][])
      for (const to of ["a", "x".repeat(64)]) {
        const t = receiptText(r, to, 2, excerptOf("w".repeat(100)));
        for (const l of t.split("\n"))
          expect(Array.from(l).length).toBeLessThanOrEqual(80);
      }
  });
});
