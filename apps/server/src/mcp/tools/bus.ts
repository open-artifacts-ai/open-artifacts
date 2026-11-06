import type { McpServer } from "@modelcontextprotocol/server";
import { busConfigCap } from "../../bus/cap.js";
import { logError } from "../../log.js";
import {
  busOn,
  proposeBusRole,
  ROLE_PROPOSAL_TTL_MIN,
} from "../../services/bus.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { toolConfig } from "../tool-defs.js";

// #1372: the bus's one /mcp tool, offered only while the bus is on (BUS_HUB
// bound, not hosted). It PROPOSES a role change; the member confirms it on
// the returned link in a browser (bus/role-confirm.ts). No /mcp tool
// confirms or applies one: the user's guardrail ("Let's do B", then "1,
// propose via MCP, I confirm by link").
export function registerBusTools(server: McpServer, t: ToolEnv): void {
  if (!busOn(t.env)) return;
  server.registerTool(
    "bus_role_propose",
    toolConfig("bus_role_propose"),
    (input) =>
      guard(async () => {
        // #1299: proposing new configuration is refused under a plan cap.
        busConfigCap(t.user);
        const via = t.agentNow()?.via;
        // No PAT or grant id to attach: a revoke can't end this proposal.
        if (!via) logError("bus_role_propose_no_credential");
        const { proposal: p, confirmUrl } = await proposeBusRole(
          t.env,
          t.user.id,
          input,
          via,
        );
        const role = `role "${p.name}" in ${p.namespace}`;
        const was = p.priorHolderName ? ` (now ${p.priorHolderName})` : "";
        const what =
          p.action === "clear"
            ? `remove ${role}${was}`
            : p.action === "repoint"
              ? `point ${role} at ${p.agentName}${was}`
              : `create ${role} pointing at ${p.agentName}`;
        return ok(
          `Proposed: ${what}. Nothing has changed. Give the person this link to confirm it in their browser, signed in (it works once and expires in ${ROLE_PROPOSAL_TTL_MIN} minutes): ${confirmUrl}`,
          { proposal: p, confirmUrl },
        );
      }),
  );
}
