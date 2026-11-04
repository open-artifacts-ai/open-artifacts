import { describe, expect, it } from "vitest";
import {
  ApprovalBodySchema,
  DeviceCodeRequestSchema,
  newMachineLabel,
} from "../src/device.ts";
import { MachineLabelSchema } from "../src/refs.ts";

const BAD = [
  "Mac‮kooB",
  "Mac\u0000Book",
  "Mac\nBook",
  "Mac​Book",
  "Mac⁦Book",
  " MacBook",
  "MacBook\t",
];

describe("adv F2.4: labels bypass MachineLabelSchema", () => {
  // Anonymous POST /device/code: label is rendered on the approval page.
  it("DeviceCodeRequestSchema.machine_label rejects control/bidi/zero-width", () => {
    for (const l of BAD)
      expect(
        DeviceCodeRequestSchema.safeParse({ machine_label: l }).success,
        JSON.stringify(l),
      ).toBe(false);
  });
  it("ApprovalBodySchema.label rejects control/bidi/zero-width and blank", () => {
    for (const l of [...BAD, "   "])
      expect(
        ApprovalBodySchema.safeParse({ decision: "approve", label: l }).success,
        JSON.stringify(l),
      ).toBe(false);
  });
  it("MachineLabelSchema is bounded, non-empty and clean", () => {
    expect(MachineLabelSchema.safeParse("").success).toBe(false);
    expect(MachineLabelSchema.safeParse("x".repeat(100_000)).success).toBe(
      false,
    );
    expect(MachineLabelSchema.safeParse("M".repeat(100)).success).toBe(true);
    for (const l of BAD)
      expect(MachineLabelSchema.safeParse(l).success, JSON.stringify(l)).toBe(
        false,
      );
  });
  // newMachineLabel feeds the stored label from an anonymous hostname.
  it("newMachineLabel always returns a valid MachineLabelSchema value", () => {
    for (const h of [
      `${"a".repeat(63)} b`,
      `${"a".repeat(63)}\u{1F600}`,
      "‮evil",
      "Mac\u0000Book",
      "​",
    ]) {
      const out = newMachineLabel(h);
      expect(
        MachineLabelSchema.safeParse(out).success,
        JSON.stringify(out),
      ).toBe(true);
    }
  });
});

describe("newMachineLabel hostile inputs", () => {
  it("is always a valid label", () => {
    const parts = [
      "a",
      " ",
      "\u{1F600}",
      "‮",
      "\u0000",
      "​",
      "é",
      "é",
      "\n",
      "x".repeat(70),
      "\uD83D",
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      let h = "";
      const n = rnd() % 8;
      for (let j = 0; j < n; j++) h += parts[rnd() % parts.length];
      const out = newMachineLabel(h);
      expect(MachineLabelSchema.safeParse(out).success, JSON.stringify(h)).toBe(
        true,
      );
      expect(out).toBe(out.normalize("NFC"));
    }
    expect(newMachineLabel("​")).toBe("machine");
  });
});
