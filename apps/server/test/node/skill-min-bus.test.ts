// #2624: the first bus with `oa-bus skill` comes from the CHANGELOG, not a guess.
import { describe, expect, it } from "vitest";
import { firstReleaseCiting } from "../../scripts/skill-min-bus.ts";

const log = (...sections: [string, string][]) =>
  `# Changelog\n\n${sections.map(([v, body]) => `## [${v}](https://x/compare) (2026-11-18)\n\n${body}\n`).join("\n")}`;

describe("firstReleaseCiting", () => {
  it("is null until a release cites the issue", () => {
    expect(
      firstReleaseCiting(log(["0.202.0", "* a ([#2641](u))"]), "#2624"),
    ).toBeNull();
  });
  it("is the lowest release that cites it", () => {
    const c = log(
      ["0.210.0", "* later mention ([#2624](u))"],
      ["0.203.0", "* **setup:** the skill step (#2624) ([#2720](u))"],
      ["0.202.0", "* other ([#26240](u))"],
    );
    expect(firstReleaseCiting(c, "#2624")).toBe("0.203.0");
  });
  it("compares numerically, not as text", () => {
    const c = log(["0.10.0", "(#2624)"], ["0.9.0", "(#2624)"]);
    expect(firstReleaseCiting(c, "#2624")).toBe("0.9.0");
  });
});
