// #3043: the rules every session is told at start, kept short enough that no
// harness cuts them. The long text lives in the bus skill; the brief points
// there and does not repeat it.
import { describe, expect, it } from "vitest";
import {
  BRIEF_RULES,
  BRIEF_RULES_MAX_BYTES,
  briefRulesBytes,
} from "../src/habits.ts";

describe("the brief rules (#3043)", () => {
  const lines = BRIEF_RULES.trimEnd().split("\n");
  const rules = lines.slice(1);

  it("is a lead line and eight rules, one line each", () => {
    expect(lines[0]).toBe(
      "When you're connected to the Open Artifacts bus (details: the bus skill):",
    );
    expect(rules).toHaveLength(8);
    for (const r of rules) expect(r.startsWith("- ")).toBe(true);
  });

  it("fits the budget a harness will show, so no rule is cut", () => {
    expect(briefRulesBytes()).toBeLessThanOrEqual(BRIEF_RULES_MAX_BYTES);
    // Every rule survives a byte-for-byte slice at the budget.
    const cut = new TextEncoder()
      .encode(BRIEF_RULES)
      .slice(0, BRIEF_RULES_MAX_BYTES);
    expect(new TextDecoder().decode(cut)).toBe(BRIEF_RULES);
  });

  it("sends each habit to the skill rather than repeating it", () => {
    expect(BRIEF_RULES).toContain("the bus skill");
    // No letters in option labels: the card adds them (#3040).
    expect(BRIEF_RULES).toContain("no letters or numbers");
  });
});
