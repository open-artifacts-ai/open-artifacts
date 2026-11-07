import { callTool, TOOLS } from "@oa/bus-adapter-claude-code";
import type { AgentTool, ToolContext } from "./api.ts";
import type { Bus } from "./bus.ts";
import { LinkError } from "./link.ts";

/** The five bus tools, named as Pi and Hermes name them (#1448): the MCP tools behind an `oabus_` prefix. */
export const TOOL_NAMES = TOOLS.map((t) => `oabus_${t.name}`);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * The tools for one caller, or none: a session that cannot be on the bus
 * (a subagent, an ACP or cron session, a runtime this adapter does not
 * claim) never sees them. A tool call runs on the root's attested link; a
 * `from` argument is never read.
 */
export function toolsFor(bus: Bus, ctx: ToolContext): AgentTool[] {
  const r = bus.resolve(
    {
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      modelProviderId: ctx.activeModel?.provider,
      modelId: ctx.activeModel?.modelId,
      workspaceDir: ctx.workspaceDir,
    },
    false,
  );
  if (!r.ok) return [];
  const root = r.root;
  return TOOLS.map((t) => ({
    name: `oabus_${t.name}`,
    label: `oabus_${t.name}`,
    description: t.description,
    parameters: t.inputSchema,
    async execute(_id, params, signal) {
      try {
        const client = await bus.ensure(root);
        const out = await callTool(
          t.name,
          params && typeof params === "object" ? params : {},
          client,
          signal,
        );
        const body = out.content.map((c) => c.text).join("\n\n");
        // OpenClaw reads a thrown error as a failed tool call.
        if (out.isError) throw new Error(body);
        return text(body);
      } catch (e) {
        if (e instanceof LinkError) throw new Error(`oa-bus: ${e.message}`);
        throw e;
      }
    },
  }));
}
