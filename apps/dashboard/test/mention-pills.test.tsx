import type { ArtifactAgent } from "@oa/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { atomicBackspace, mentionSegments } from "../src/viewer/comments/asks";
import { MentionMirror } from "../src/viewer/comments/MentionMirror";

const ag = (key: string, name: string): ArtifactAgent => ({
  key,
  name,
  online: true,
  state: "online",
});
const agents = [ag("p", "OA Product"), ag("m", "OA Manager"), ag("o", "OA")];
const pills = (t: string) =>
  mentionSegments(t, agents)
    .filter((s) => s.key)
    .map((s) => s.text);

describe("mentionSegments (#2317)", () => {
  it("pills a resolved name and leaves an unknown one plain", () => {
    expect(pills("@OA Product hello @nobody")).toEqual(["@OA Product"]);
  });
  it("round-trips the text", () => {
    const t = "hi @OA Product, and @nobody x";
    expect(
      mentionSegments(t, agents)
        .map((s) => s.text)
        .join(""),
    ).toBe(t);
  });
  it("pills only the first of a duplicate", () => {
    const segs = mentionSegments(
      "@OA Manager and @OA Manager",
      agents.slice(0, 2),
    );
    expect(segs.filter((s) => s.key)).toHaveLength(1);
    expect(segs[0]).toEqual({ text: "@OA Manager", key: "m" });
  });
  it("not in an email or inside a word", () => {
    expect(pills("mail me@OA.com")).toEqual([]);
    expect(pills("foo@OA bar")).toEqual([]);
    expect(pills("(@OA)")).toEqual([]);
  });
  it("the longer name wins over its stem", () => {
    expect(pills("@OA Product")).toEqual(["@OA Product"]);
    expect(pills("@OA hi")).toEqual(["@OA"]);
  });
  it("text order with several pills", () => {
    expect(pills("@OA Manager then @OA Product.")).toEqual([
      "@OA Manager",
      "@OA Product",
    ]);
  });
});

describe("atomicBackspace (#2317)", () => {
  it("selects the whole name when the caret is at its end", () => {
    const t = "hi @OA Product there";
    expect(atomicBackspace(t, 14, 14, agents)).toEqual({ start: 3, end: 14 });
  });
  it("acts normally with a selection, mid-name or after the space", () => {
    const t = "hi @OA Product there";
    expect(atomicBackspace(t, 10, 14, agents)).toBeNull();
    expect(atomicBackspace(t, 10, 10, agents)).toBeNull();
    expect(atomicBackspace(t, 15, 15, agents)).toBeNull();
  });
  it("acts normally after a plain @name", () => {
    expect(atomicBackspace("hi @nobody", 10, 10, agents)).toBeNull();
  });
});

describe("MentionMirror", () => {
  it("is aria-hidden and renders one pill", () => {
    const ta = document.createElement("textarea");
    document.body.append(ta);
    const { container } = render(
      <MentionMirror
        field={{ current: ta }}
        text="@OA Product hello @nobody"
        agents={agents}
      />,
    );
    const m = container.querySelector("[data-oa-mirror]");
    expect(m?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("[data-oa-pill]")).toHaveLength(1);
    ta.remove();
  });
});
