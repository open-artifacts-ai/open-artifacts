// #1100: "Comment" on a doc selection quotes it for the whole-page composer.
import { describe, expect, it } from "vitest";
import {
  quoteLines,
  quoteToNote,
  takeNoteQuote,
} from "../src/viewer/comments/noteQuote";

describe("quoteLines", () => {
  it("one line: a quote, then a blank line for the cursor", () => {
    expect(quoteLines("landing page")).toBe("> landing page\n\n");
  });
  it("several lines: one quoted paragraph each; blank lines and edges dropped", () => {
    expect(
      quoteLines("  Checklist\n\nFinal copy reviewed \r\nHero image\n"),
    ).toBe("> Checklist\n>\n> Final copy reviewed\n>\n> Hero image\n\n");
  });
  it("nothing but space: no quote", () => {
    expect(quoteLines(" \n\t\n")).toBe("");
  });
});

describe("the hand-off", () => {
  it("an empty quote is never handed over; a taken one is gone, a stale take is ignored", () => {
    quoteToNote("A1", "");
    quoteToNote("A1", "> x\n\n");
    // A take of an older hand-off does not drop the newer one.
    takeNoteQuote("A1", { text: "> x\n\n" });
    quoteToNote("A1", "> y\n\n");
    expect(() => takeNoteQuote("A1", { text: "> y\n\n" })).not.toThrow();
  });
});
