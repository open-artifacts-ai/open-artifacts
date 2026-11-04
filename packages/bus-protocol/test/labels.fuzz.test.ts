import { describe, expect, it } from "vitest";
import {
  ApprovalBodySchema,
  DeviceCodeRequestSchema,
  newMachineLabel,
} from "../src/device.js";
import { MachineLabelSchema } from "../src/refs.js";

const ok = (s: string) => MachineLabelSchema.safeParse(s).success;
const lone = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    s,
  );
const check = (h: string) => {
  const out = newMachineLabel(h);
  expect(ok(out), JSON.stringify(h)).toBe(true);
  expect(lone(out), JSON.stringify(out)).toBe(false);
  return out;
};

describe("newMachineLabel targeted", () => {
  it("emoji across the 128 boundary never splits a pair", () => {
    for (let pad = 120; pad <= 130; pad++)
      for (const e of ["😀", "👨‍👩‍👧", "🇺🇸", "𝔸"]) {
        const out = check("a".repeat(pad) + e.repeat(5));
        expect(out.length).toBeLessThanOrEqual(128);
      }
    check("😀".repeat(64));
    check("😀".repeat(65));
    check(`a${"😀".repeat(64)}`);
  });
  it("all-bidi / all-bad / empty -> machine", () => {
    for (const h of [
      "",
      " ",
      "‮‭⁦⁧⁨⁩‎‏؜",
      "​﻿⁠",
      "\u0000\u001f\u007f\u0085",
      "\uD83D",
      "\uDE00",
      "\uDE00\uD83D",
      "  ",
      " ‮ ",
    ])
      expect(check(h)).toBe("machine");
  });
  it("combining marks", () => {
    check("é".repeat(200));
    check("́".repeat(300));
    check(`a${"́".repeat(500)}`);
    check(`${"x".repeat(127)}é`);
  });
  it("output is NFC even when a stripped char sat between base and mark", () => {
    const out = newMachineLabel("e​́");
    expect(out, JSON.stringify(out)).toBe(out.normalize("NFC"));
  });
  it("random fuzz 20k over hostile alphabet", () => {
    const parts = [
      "a",
      " ",
      "\t",
      " ",
      "　",
      "😀",
      "\uD83D",
      "\uDE00",
      "‮",
      "​",
      "\u0000",
      "́",
      "e",
      " ",
      "x".repeat(60),
      "\u{E0041}",
      "᠎",
    ];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 20000; i++) {
      let h = "";
      const n = rnd() % 12;
      for (let j = 0; j < n; j++) h += parts[rnd() % parts.length];
      check(h);
    }
  });
  it("idempotent", () => {
    for (const h of ["a😀b", " x ", "é", "　a　"])
      expect(newMachineLabel(newMachineLabel(h))).toBe(newMachineLabel(h));
  });
});

describe("MachineLabelSchema gaps (ruling 1 fields)", () => {
  it("128 units ok, 129 rejected on every label field", () => {
    for (const [l, want] of [
      ["M".repeat(128), true],
      ["M".repeat(129), false],
      ["", false],
    ] as const) {
      expect(MachineLabelSchema.safeParse(l).success).toBe(want);
      expect(
        DeviceCodeRequestSchema.safeParse({ machine_label: l }).success,
      ).toBe(want);
      expect(
        ApprovalBodySchema.safeParse({ decision: "approve", label: l }).success,
      ).toBe(want);
    }
  });
  // Expected to FAIL if the schema allows these invisible/format chars or lone surrogates.
  it.each([
    ["lone surrogate", "Mac\uD83DBook"],
    ["U+180E", "Mac᠎Book"],
    ["U+2061", "Mac⁡Book"],
    ["soft hyphen", "Mac­Book"],
    ["tag char", "Mac\u{E0041}Book"],
    ["U+034F CGJ", "Mac͏Book"],
    ["Hangul filler", "ㅤ"],
  ])("rejects %s", (_n, l) => {
    expect(ok(l)).toBe(false);
  });
});
