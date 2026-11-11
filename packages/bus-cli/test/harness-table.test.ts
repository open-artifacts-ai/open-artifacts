import { harnessSkills } from "@oa/shared/harness-skills";
import { describe, expect, it } from "vitest";
import { harnessNames } from "../src/harness-table.ts";

describe("harness table", () => {
  it("is the shared leaf's table", () => {
    expect(harnessNames).toEqual(Object.keys(harnessSkills));
    expect(harnessSkills.claude.skillPath).toContain("SKILL.md");
  });
});
