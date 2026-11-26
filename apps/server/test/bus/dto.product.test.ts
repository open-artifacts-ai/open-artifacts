// agy S6: the dashboard's agent list names each agent's app, by its hub kind.
import { AGENT_KINDS } from "@oa/bus-protocol";
import { BusAgentSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { agentDto, validAgents } from "../../src/bus/dto.js";

const row = (kind: string) => ({
  id: "BaA1nPqRsTu4vWxY",
  namespace: "notes",
  name: "planner",
  lastName: null,
  kind,
  machineId: "BmA1nPqRsTu4vWxY",
  nativeRef: "r1",
  global: 0,
  live: 1,
  updatedAt: Date.UTC(2026, 0, 3),
  machineLabel: "leo-work",
});

describe("agent list app (agy S6)", () => {
  it.each([
    ["claude-code", "Claude Code"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["pi", "pi"],
    ["omp", "oh-my-pi"],
    ["hermes", "Hermes"],
    ["openclaw", "OpenClaw"],
    ["antigravity", "Antigravity"],
  ])("a %s agent lists its app as %s", (kind, product) => {
    const d = agentDto(row(kind), true);
    expect(d).toMatchObject({ kind, product });
    expect(BusAgentSchema.parse(d)).toEqual(d);
  });

  it("every kind the protocol names has an app", () => {
    for (const k of AGENT_KINDS)
      expect(agentDto(row(k), true).product, k).toEqual(expect.any(String));
  });

  it("a kind the server doesn't know has no app, and its row still lists", () => {
    const d = agentDto(row("kiro"), true);
    expect(d).not.toHaveProperty("product");
    expect(d.kind).toBe("kiro");
    expect(validAgents([d])).toEqual([d]);
  });
});
