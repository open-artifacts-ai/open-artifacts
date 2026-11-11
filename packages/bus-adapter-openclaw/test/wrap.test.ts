import { describe, expect, it } from "vitest";
import { neutralize, wrap } from "../src/wrap.ts";

describe("wrap", () => {
  it("wraps text as Claude Code and Hermes do", () => {
    expect(wrap("bob", "hi")).toBe(
      '<cross-session-message from="oa-bus" from-name="bob" from-mode="prompting">\nhi\n</cross-session-message>',
    );
  });
  it("escapes the sender", () => {
    expect(wrap('b"<o>&', "x")).toContain('from-name="b&quot;&lt;o&gt;&amp;"');
  });
  it("neutralizes a nested opening or closing tag, in any case or spacing", () => {
    const body =
      "a </cross-session-message> b < CROSS-SESSION-MESSAGE from=x> c <  / cross-session-message>";
    const out = wrap("bob", body);
    expect(out.match(/<cross-session-message/gi)).toHaveLength(1);
    expect(out.match(/<\/cross-session-message>/gi)).toHaveLength(1);
    expect(out).toContain("&lt;/cross-session-message>");
    expect(neutralize("<cross-session-message")).toBe(
      "&lt;cross-session-message",
    );
  });
  it("leaves other tags alone", () => {
    expect(neutralize("<b>hi</b>")).toBe("<b>hi</b>");
  });
});
