import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, tilde } from "../context.ts";
import {
  claudeConfigFile,
  type EntryState,
  proofReport,
} from "./claude-proof.ts";

/** The event the daemon logs for each entry it gave the helper (name and scope only). */
export const PROOF_EVENT = "claude_proof_applied";

export type ProofCheck = { level: "pass" | "warn" | "fail"; lines: string[] };

const where = (ctx: Ctx, e: Pick<EntryState, "scope" | "project">) =>
  e.scope === "project"
    ? "project scope, .mcp.json in this folder"
    : e.scope === "local"
      ? `local scope, project ${tilde(ctx, e.project ?? "")}`
      : "user scope";

/**
 * #2688: every Claude entry for the instance and whether it has the helper
 * that ties its calls to this session. Read-only. Used by doctor and status.
 */
export function claudeProofChecks(ctx: Ctx, hub: string): ProofCheck[] {
  let origin: string;
  try {
    origin = new URL(hub).origin;
  } catch {
    return [];
  }
  const host = new URL(origin).host;
  const r = proofReport(
    claudeConfigFile(ctx.userHome, ctx.env),
    origin,
    join(ctx.cwd, ".mcp.json"),
  );
  const out: ProofCheck[] = [];
  for (const e of r.entries) {
    const at = `the ${e.name} entry (${where(ctx, e)})`;
    if (e.scope === "project")
      out.push({
        level: "fail",
        lines: [
          `Claude Code: ${at} can't show as this session: Claude skips the helper on project-scope entries.`,
          `  Fix: claude mcp remove ${e.name} -s project, then claude mcp add --transport http ${e.name} ${origin}/mcp -s user, then ${ctx.busCmd} install`,
        ],
      });
    else if (e.state === "helper")
      out.push({
        level: "pass",
        lines: [`Claude Code: ${at} shows as this session on pages.`],
      });
    else if (e.state === "missing")
      out.push({
        level: "fail",
        lines: [
          `Claude Code: ${at} has no session helper, so what it posts can't be tied to this session.`,
          `  Fix: ${ctx.busCmd} install`,
        ],
      });
    else
      out.push({
        level: "fail",
        lines: [
          `Claude Code: ${at} has a headersHelper that is not oa-bus's, so oa-bus left it alone.`,
          `  Fix: remove that headersHelper from the entry in ${tilde(ctx, claudeConfigFile(ctx.userHome, ctx.env))}, then run ${ctx.busCmd} install`,
        ],
      });
  }
  if (r.entries.length === 0)
    out.push({
      level: "warn",
      lines: [
        `Claude Code: no entry for ${host} was found at user, local or project scope.`,
        `  If you use Claude Code with it: claude mcp add --transport http <name> ${origin}/mcp -s user, then ${ctx.busCmd} install`,
      ],
    });
  for (const e of r.elsewhere)
    out.push({
      level: "warn",
      lines: [
        `Claude Code: the ${e.name} entry (${e.scope} scope) points at ${e.url}, not ${origin}/mcp, so it can't be linked.`,
      ],
    });
  return out;
}

/** What the daemon's last automatic re-apply changed, from the event log; none when it never wrote. */
export function lastAutoFix(ctx: Ctx): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(ctx.home, "logs", "events.log"), "utf8");
  } catch {
    return undefined;
  }
  const hits = text
    .split("\n")
    .filter((l) => l.includes(` ${PROOF_EVENT} `))
    .map((l) => {
      const [at = ""] = l.split(" ");
      return {
        at,
        name: / name=("[^"]*"|\S+)/.exec(l)?.[1]?.replaceAll('"', "") ?? "",
        scope: / kind=(\S+)/.exec(l)?.[1] ?? "",
      };
    });
  const last = hits.at(-1);
  if (!last) return undefined;
  const t = Date.parse(last.at);
  const run = hits.filter((h) => Math.abs(Date.parse(h.at) - t) < 60_000);
  return `Claude Code: the last automatic fix (${last.at.slice(0, 16).replace("T", " ")} UTC) added the helper to ${run.map((h) => `${h.name} (${h.scope} scope)`).join(", ")}.`;
}
