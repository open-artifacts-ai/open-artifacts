import type { McpServer } from "@modelcontextprotocol/server";
import { busConfigCap } from "../../bus/cap.js";
import { logError } from "../../log.js";
import {
  busOn,
  handOverBusRole,
  proposeBusRole,
  ROLE_PROPOSAL_TTL_MIN,
} from "../../services/bus.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { toolConfig } from "../tool-defs.js";

// #1372: the bus's one /mcp tool, offered only while the bus is on (BUS_HUB
// bound, not hosted). It PROPOSES a role change; the member confirms it on
// the returned link in a browser (bus/role-confirm.ts): the user's guardrail
// ("Let's do B", then "1, propose via MCP, I confirm by link"). One
// exception, by the user's later pick (#3132, 2026-11-26: "The holder hands
// it over, or you approve"): the role's live holder, proven by its session
// link (#1822), hands its role to another of the member's open agents at
// once. Any other caller only proposes.
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
        const identity = t.agentNow()?.identity?.identityId;
        if (input.action === "set" && input.agent && identity) {
          const role = await handOverBusRole(t.env, t.user.id, identity, {
            namespace: input.namespace,
            name: input.name,
            agent: input.agent,
          });
          if (role !== null)
            return ok(
              `Handed over: role "${role.name}" in ${role.namespace} now points at ${role.holderName ?? input.agent}. Your open asks, mentions and followed pages for it go there now.`,
              { handedOver: true, role },
            );
        }
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
