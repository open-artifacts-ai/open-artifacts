import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, tilde } from "../context.ts";
import { originOf } from "../machine.ts";
import {
  claudeConfigFile,
  type EntryState,
  proofReport,
  readRecord,
} from "./claude-proof.ts";

/** The event the daemon logs for each entry it gave the helper (name and scope only). */
export const PROOF_EVENT = "claude_proof_applied";

/** `info` is said but not counted: it is no problem. */
export type ProofCheck = {
  level: "pass" | "warn" | "fail" | "info";
  lines: string[];
};

const DAY_MS = 86_400_000;

const where = (ctx: Ctx, e: Pick<EntryState, "scope" | "project">) =>
  e.scope === "project"
    ? "project scope, .mcp.json in this folder"
    : e.scope === "local"
      ? `local scope, project ${tilde(ctx, e.project ?? "")}`
      : "user scope";

/**
 * #2688: every Claude entry for the instance and whether it has the helper
 * that ties its calls to this session. Read-only. Used by doctor and status.
 * No line shows a command that edits a repo's `.mcp.json`, and an entry's
 * name (a repo can choose it) appears only in prose.
 */
export function claudeProofChecks(ctx: Ctx, hub: string): ProofCheck[] {
  const origin = originOf(hub);
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return [];
  }
  const rec = readRecord(join(ctx.home, "install.json"));
  // The file install used, which is the one the daemon edits.
  const file = rec.config ?? claudeConfigFile(ctx.userHome, ctx.env);
  const r = proofReport(file, origin, {
    projectFile: join(ctx.cwd, ".mcp.json"),
    cwd: ctx.cwd,
    recorded: rec.proofs,
  });
  const out: ProofCheck[] = [];
  const install = `run ${ctx.busCmd} install`;
  for (const e of r.entries) {
    const at = `the ${e.name} entry (${where(ctx, e)})`;
    if (e.scope === "project") {
      out.push(
        e.state === "helper" && e.trusted !== false
          ? {
              level: "pass",
              lines: [`Claude Code: ${at} has the helper.`],
            }
          : {
              level: "warn",
              lines: [
                e.state === "helper"
                  ? `Claude Code: ${at} has the helper, but Claude doesn't trust this folder yet, so it won't run it.`
                  : `Claude Code: ${at} is not set up by the bus; it links only if it has our helper and the folder is trusted.`,
                e.state === "helper"
                  ? "  Open Claude Code in this folder and accept the trust prompt."
                  : `  Re-add it at user scope with Claude Code, then ${install}.`,
              ],
            },
      );
      continue;
    }
    if (e.state === "helper")
      out.push(
        e.trusted === false
          ? {
              level: "warn",
              lines: [
                `Claude Code: ${at} has the helper, but Claude doesn't trust that folder yet, so it won't run it.`,
                "  Open Claude Code in that folder and accept the trust prompt.",
              ],
            }
          : {
              level: "pass",
              lines: [`Claude Code: ${at} shows as this session on pages.`],
            },
      );
    else if (e.state === "unrecorded")
      out.push({
        level: "warn",
        lines: [
          `Claude Code: ${at} has the helper, but was set up by another bus or an older install.`,
          `  Fix: ${install} to adopt it`,
        ],
      });
    else if (e.state === "missing")
      out.push({
        level: "fail",
        lines: [
          `Claude Code: ${at} has no session helper, so what it posts can't be tied to this session.`,
          `  Fix: ${install}`,
        ],
      });
    else
      out.push({
        level: "fail",
        lines: [
          `Claude Code: ${at} has a headersHelper that is not oa-bus's, so oa-bus left it alone.`,
          `  Fix: remove that headersHelper from the entry in ${tilde(ctx, file)}, then ${install}`,
        ],
      });
  }
  if (r.symlink)
    out.push({
      level: "warn",
      lines: [
        `Claude Code: ${tilde(ctx, file)} is a symlink, so the daemon doesn't edit it on its own.`,
        `  Fix: ${install} to link its entries`,
      ],
    });
  if (r.entries.length === 0)
    out.push({
      level: "info",
      lines: [
        `No Claude Code entry for ${host}.`,
        "   Agents using a connector or another client aren't checked.",
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

/** What the daemon's last automatic re-apply changed, from the event log, when it ran in the last 7 days. */
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
  if (!(ctx.now() - t < 7 * DAY_MS)) return undefined;
  const run = hits.filter((h) => Math.abs(Date.parse(h.at) - t) < 60_000);
  return `Claude Code: the last automatic fix (${last.at.slice(0, 16).replace("T", " ")} UTC) added the helper to ${run.map((h) => `${h.name} (${h.scope} scope)`).join(", ")}.`;
}
