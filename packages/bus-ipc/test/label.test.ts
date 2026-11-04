import { StatusLabelSchema } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { cleanStatusLabel, statusLabelTooLong } from "../src/index.ts";

describe("cleanStatusLabel (AC5b)", () => {
  it("folds whitespace, drops bad characters and trims", () => {
    expect(cleanStatusLabel("  writing\n\ttests  ")).toBe("writing tests");
    expect(cleanStatusLabel("a‮b​c⁦d")).toBe("abcd");
    expect(cleanStatusLabel("​ \n")).toBe("");
  });

  it.each([
    " x ",
    "a\nb",
    "‮x⁩",
    "\ud800y",
    "x\u0085y",
    " lane  6",
    "a­b᠎c",
    "é",
    "ㅤxﾠ",
    "😀".repeat(64),
    ` ${"é".repeat(64)}\n`,
  ])(
    "a cleaned label of at most 64 always passes StatusLabelSchema: %j",
    (raw) => {
      const out = cleanStatusLabel(raw);
      expect([...out].length).toBeLessThanOrEqual(64);
      expect(out).not.toBe("");
      expect(StatusLabelSchema.safeParse(out).success).toBe(true);
    },
  );

  it("over 64 the schema refuses it, and the adapter says so first", () => {
    const out = cleanStatusLabel("x".repeat(65));
    expect(StatusLabelSchema.safeParse(out).success).toBe(false);
    expect(statusLabelTooLong(65)).toBe(
      "oa-bus: that label is 65 characters, and the limit is 64. Your status did not change. Send a shorter one.",
    );
  });
});
