import { describe, expect, it } from "vitest";
import { MAX_LINE_BYTES } from "../src/frames.ts";
import { FrameTooLarge, LineDecoder } from "../src/lines.ts";

describe("LineDecoder", () => {
  it("decodes a multibyte char split across chunks intact", () => {
    const bytes = Buffer.from(`${JSON.stringify({ s: "a€b" })}\n`, "utf8");
    const cut = bytes.indexOf(0xe2) + 1; // mid-codepoint
    const d = new LineDecoder();
    expect(d.push(bytes.subarray(0, cut))).toEqual([]);
    expect(d.push(bytes.subarray(cut))).toEqual([{ s: "a€b" }]);
  });

  it("caps a line by UTF-8 bytes, not UTF-16 length", () => {
    const d = new LineDecoder();
    const chunk = "€".repeat(Math.ceil(MAX_LINE_BYTES / 3) + 10); // chars < cap, bytes > cap
    expect(chunk.length).toBeLessThan(MAX_LINE_BYTES);
    expect(() => d.push(Buffer.from(chunk, "utf8"))).toThrow(FrameTooLarge);
  });

  it("still accepts strings", () => {
    expect(new LineDecoder().push('{"a":1}\n')).toEqual([{ a: 1 }]);
  });
});
