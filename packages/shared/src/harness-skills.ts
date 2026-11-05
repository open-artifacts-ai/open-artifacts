// A leaf: imports nothing, so the published bus CLI can bundle it without zod
// or any server code. Reached as `@oa/shared/harness-skills`.
/**
 * The harnesses the bus installer wires today: one table. The server renders
 * `/skill.md?harness=` from it; the installer will read it in PR 2 of #1456.
 */
export const HARNESSES = ["claude", "codex", "opencode", "pi", "omp"] as const;
export type Harness = (typeof HARNESSES)[number];

export type HarnessSkill = {
  /** Where the installer writes SKILL.md, or the marked block for codex. */
  skillPath: string;
  /**
   * The bus tool name this harness shows for `tool` (send_message, …).
   * Undefined means the extension exposes the bare names.
   */
  busToolName?: (tool: string) => string;
  /** Codex 0.47 has no skill loader: its text goes into AGENTS.md. */
  agentsMd?: boolean;
};

export const harnessSkills: Record<Harness, HarnessSkill> = {
  claude: {
    skillPath: "~/.claude/skills/open-artifacts/SKILL.md",
    busToolName: (tool) => `mcp__oa_bus__${tool}`,
  },
  // CODEX_TOOL_NAMESPACE = "mcp__oa_bus" (packages/bus-daemon/src/codex-attest.ts).
  codex: {
    skillPath: "~/.codex/AGENTS.md",
    busToolName: (tool) => `mcp__oa_bus__${tool}`,
    agentsMd: true,
  },
  opencode: {
    skillPath: "~/.config/opencode/skills/open-artifacts/SKILL.md",
    busToolName: (tool) => `oa_bus_${tool}`,
  },
  pi: {
    skillPath: "~/.agents/skills/open-artifacts/SKILL.md",
  },
  omp: {
    skillPath: "~/.agents/skills/open-artifacts/SKILL.md",
  },
};

/** A harness name from a query string, or undefined when it is not one. */
export const parseHarness = (raw: string | undefined): Harness | undefined =>
  (HARNESSES as readonly string[]).includes(raw ?? "")
    ? (raw as Harness)
    : undefined;
