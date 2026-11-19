import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listInstances } from "@oa/bus-daemon";
import { wiredTo } from "../bus-cmd.ts";
import { type Ctx, tilde } from "../context.ts";
import { originOf } from "../machine.ts";
import {
  claudeConfigFile,
  type EntryState,
  type InstanceTarget,
  proofReport,
  readRecord,
} from "./claude-proof.ts";
import { isDefaultHome } from "./service.ts";

/** The event the daemon logs for each entry it gave the helper (name and scope only). */
export const PROOF_EVENT = "claude_proof_applied";

/** `info` is said but not counted: it is no problem. */
export type ProofCheck = {
  level: "pass" | "warn" | "fail" | "info";
  lines: string[];
};

const DAY_MS = 86_400_000;

/**
 * Text from a config file a repo or another tool controls (an entry name, a
 * project path) is never printed raw: control and format characters (newline,
 * ESC, bidi marks) become "?", so it can't forge a line such as "Fix: ...".
 */
export const safeText = (s: string, max = 80): string => {
  const t = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** An entry's address as origin and path only: no userinfo, query or fragment (they may hold a token). */
export const safeUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return safeText(`${x.origin}${x.pathname}`, 120);
  } catch {
    return "an address that can't be read";
  }
};

const where = (ctx: Ctx, e: Pick<EntryState, "scope" | "project">) =>
  e.scope === "project"
    ? "project scope, .mcp.json in this folder"
    : e.scope === "local"
      ? `local scope, project ${safeText(tilde(ctx, e.project ?? ""), 120)}`
      : "user scope";

/**
 * #2688: every Claude entry for the instance and whether it has the helper
 * that ties its calls to this session. Read-only. Used by doctor and status.
 * No line shows a command that edits a repo's `.mcp.json`, and an entry's
 * name (a repo can choose it) appears only in prose.
 */
export function claudeProofChecks(
  ctx: Ctx,
  hub: string,
  instance?: InstanceTarget,
): ProofCheck[] {
  const origin = originOf(hub);
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return [];
  }
  const cc = instance
    ? `Claude Code (${safeText(instance.name, 32)}):`
    : "Claude Code:";
  const rec = readRecord(join(ctx.home, "install.json"));
  // The file install used, which is the one the daemon edits.
  const file = rec.config ?? claudeConfigFile(ctx.userHome, ctx.env);
  const r = proofReport(file, origin, {
    projectFile: join(ctx.cwd, ".mcp.json"),
    cwd: ctx.cwd,
    recorded: rec.proofs,
    ...(instance ? { instance } : {}),
    ...(isDefaultHome(ctx.home, ctx.userHome) ? {} : { busHome: ctx.home }),
  });
  const out: ProofCheck[] = [];
  const install = `run ${ctx.busCmd} install`;
  for (const e of r.entries) {
    const at = `the ${safeText(e.name)} entry (${where(ctx, e)})`;
    if (e.scope === "project") {
      out.push(
        e.state === "helper" && e.trusted !== false
          ? {
              level: "pass",
              lines: [`${cc} ${at} has the helper.`],
            }
          : {
              level: "warn",
              lines: [
                e.state === "helper"
                  ? `${cc} ${at} has the helper, but Claude doesn't trust this folder yet, so it won't run it.`
                  : `${cc} ${at} is not set up by the bus; it links only if it has our helper and the folder is trusted.`,
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
                `${cc} ${at} has the helper, but Claude doesn't trust that folder yet, so it won't run it.`,
                "  Open Claude Code in that folder and accept the trust prompt.",
              ],
            }
          : {
              level: "pass",
              lines: [`${cc} ${at} shows as this session on pages.`],
            },
      );
    else if (e.state === "other-bus")
      out.push({
        level: "warn",
        lines: [
          `${cc} ${at} has the helper of another bus (${e.owner === undefined ? "the default home" : safeText(tilde(ctx, e.owner), 120)}), so this bus left it alone.`,
          "  An entry links one bus; use another entry for this one.",
        ],
      });
    else if (e.state === "other-instance")
      out.push({
        level: "fail",
        lines: [
          `${cc} ${at} has a helper for another instance, so its calls can't be tied to this session.`,
          `  Fix: ${install}`,
        ],
      });
    else if (e.state === "unrecorded")
      out.push({
        level: "warn",
        lines: [
          `${cc} ${at} has the helper, but was set up by another bus or an older install.`,
          `  Fix: ${install} to adopt it`,
        ],
      });
    else if (e.state === "missing")
      out.push({
        level: "fail",
        lines: [
          `${cc} ${at} has no session helper, so what it posts can't be tied to this session.`,
          `  Fix: ${install}`,
        ],
      });
    else
      out.push({
        level: "fail",
        lines: [
          `${cc} ${at} has a headersHelper that is not oa-bus's, so oa-bus left it alone.`,
          `  Fix: remove that headersHelper from the entry in ${tilde(ctx, file)}, then ${install}`,
        ],
      });
  }
  // Existing installs: nothing was recorded, so the daemon has no file to keep linked.
  if (
    !instance &&
    rec.config === undefined &&
    wiredTo(ctx) &&
    r.entries.some((e) => e.scope !== "project")
  )
    out.push({
      level: "warn",
      lines: [
        "Claude Code: automatic linking is off for this bus.",
        `  Fix: ${install} once to turn it on`,
      ],
    });
  if (r.symlink && !instance)
    out.push({
      level: "warn",
      lines: [
        `${cc} ${tilde(ctx, file)} is a symlink, so the daemon doesn't edit it on its own.`,
        `  Fix: ${install} to link its entries`,
      ],
    });
  if (r.entries.length === 0)
    out.push({
      level: "info",
      lines: [
        `No Claude Code entry for ${host}.`,
        instance
          ? `   To connect it: claude mcp add --transport http open-artifacts-${safeText(instance.name, 32)} ${safeUrl(`${instance.hub}/mcp`)}, then run ${ctx.busCmd} install`
          : "   Agents using a connector or another client aren't checked.",
      ],
    });
  for (const e of r.elsewhere)
    out.push({
      level: "warn",
      lines: [
        `${cc} the ${safeText(e.name)} entry (${e.scope} scope) points at ${safeUrl(e.url)}, not ${safeUrl(`${instance ? instance.hub : origin}/mcp`)}, so it can't be linked.`,
      ],
    });
  return out;
}

/** #2793 S4: the same checks for each added instance's entries. Nothing for a home with only main. */
export function instanceProofChecks(ctx: Ctx): ProofCheck[] {
  return listInstances(ctx.home)
    .filter((i) => !i.main && i.hub !== "")
    .flatMap((i) =>
      claudeProofChecks(ctx, i.hub, { name: i.name, hub: i.hub }),
    );
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
  return `Claude Code: the last automatic fix (${last.at.slice(0, 16).replace("T", " ")} UTC) added the helper to ${run.map((h) => `${safeText(h.name)} (${safeText(h.scope, 20)} scope)`).join(", ")}.`;
}
