import { expect, it } from "vitest";
import { AGENT_KINDS, AgentKindSchema, KindTokenSchema } from "../src/kinds.ts";

it("accepts exactly the known kinds", () => {
  expect(AGENT_KINDS).toEqual([
    "claude-code",
    "opencode",
    "pi",
    "omp",
    "codex",
  ]);
  for (const k of AGENT_KINDS) expect(AgentKindSchema.parse(k)).toBe(k);
  expect(AgentKindSchema.safeParse("cursor").success).toBe(false);
  expect(AgentKindSchema.safeParse("Claude").success).toBe(false);
});

it("a kind token is any lowercase slug, so a reader takes future kinds", () => {
  for (const k of [...AGENT_KINDS, "zeta", "cursor-2", "a", "a".repeat(32)])
    expect(KindTokenSchema.parse(k)).toBe(k);
  for (const k of ["", "Claude", "a b", "-x", "2x", "x_y", "a".repeat(33)])
    expect(KindTokenSchema.safeParse(k).success).toBe(false);
});
