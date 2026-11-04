import { describe, expect, it } from "vitest";
import { expectedToolCount, skillEtagPattern } from "../smoke-setup/spaces.ts";

// #829: staging runs without spaces, so the smoke follows the instance.
describe("smoke expectations follow the spaces feature", () => {
  const v = "0.115.0-dev+7f1de9f";
  const off = `"${v}-paid-nospaces-0123abcd"`;
  const on = `"${v}-paid-0123abcd"`;

  it("spaces off: only the nospaces ETag, weak or strong", () => {
    expect(off).toMatch(skillEtagPattern(v, false));
    expect(`W/${off}`).toMatch(skillEtagPattern(v, false));
    expect(on).not.toMatch(skillEtagPattern(v, false));
  });

  it("spaces on: only the plain ETag", () => {
    expect(on).toMatch(skillEtagPattern(v, true));
    expect(off).not.toMatch(skillEtagPattern(v, true));
  });

  it("unknown: either, but never another version", () => {
    expect(on).toMatch(skillEtagPattern(v, undefined));
    expect(off).toMatch(skillEtagPattern(v, undefined));
    expect(`"0.115.0-paid-0123abcd"`).not.toMatch(
      skillEtagPattern(v, undefined),
    );
  });

  it("tool count: 19 with list_spaces, 18 without", () => {
    expect(expectedToolCount(true)).toBe(19);
    expect(expectedToolCount(false)).toBe(18);
  });
});
