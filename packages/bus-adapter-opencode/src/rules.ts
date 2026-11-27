import { BRIEF_RULES, habitsOff } from "@oa/bus-ipc";

/**
 * #3043: MCP server options for the OpenCode oa_bus server. Sends `BRIEF_RULES`
 * as `instructions` in the initialize result unless `install.json` opted out,
 * matching Claude Code's main.ts.
 */
export function serverOptions(home: string): {
  capabilities: { tools: Record<string, never> };
  instructions?: string;
} {
  return habitsOff(home)
    ? { capabilities: { tools: {} } }
    : { capabilities: { tools: {} }, instructions: BRIEF_RULES };
}
