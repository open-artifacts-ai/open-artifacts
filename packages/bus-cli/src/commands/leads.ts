import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkLeadsDir,
  type LeadTemplateResult,
  leadsDir,
  listLeadTemplateNames,
  loadLeadTemplate,
} from "@oa/bus-daemon";
import { type Ctx, say, sayErr, tilde } from "../context.ts";

/** The origin of the hub this machine signed in to, or undefined. Reads only. */
function hubOrigin(ctx: Ctx): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(ctx.home, "machine.json"), "utf8"),
    ) as {
      hub?: unknown;
    } | null;
    return typeof raw?.hub === "string" ? new URL(raw.hub).origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `oa-bus leads check [name]` (#1328): reads the templates in
 * `<home>/leads` and says which a lead could be started from. Read-only: it
 * writes nothing, contacts nothing, starts nothing.
 */
export async function leads(
  opts: { sub: "check"; name?: string },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const origin = hubOrigin(ctx);
  if (!origin) {
    sayErr(ctx, c.leadsNoHub());
    return 1;
  }
  const dir = leadsDir(ctx.home);
  const shownDir = tilde(ctx, dir);
  const problem = checkLeadsDir(dir, process.getuid?.());
  if (problem && problem !== "none") {
    sayErr(ctx, c.leadsFolderUnusable(shownDir, problem));
    return 1;
  }
  const names = opts.name ? [opts.name] : listLeadTemplateNames(ctx.home);
  if (names.length === 0) {
    say(ctx, c.leadsNone(shownDir));
    return 0;
  }
  const results: LeadTemplateResult[] = [];
  for (const name of names)
    results.push(
      await loadLeadTemplate(name, { home: ctx.home, hubOrigin: origin }),
    );
  let ok = 0;
  let bad = 0;
  for (const r of results) {
    if (r.state === "ok") {
      ok++;
      say(
        ctx,
        c.leadsOk({
          name: r.name,
          harness: r.template.harness,
          role: r.template.role_name,
          cap: r.template.permission_cap,
          hash: r.hash,
        }),
      );
    } else {
      bad++;
      if (r.state === "none") sayErr(ctx, c.leadsNoSuch(r.name, shownDir));
      else sayErr(ctx, c.leadsRefused(r.name, r.why));
    }
  }
  say(ctx, "", c.leadsSummary(ok, bad));
  return bad > 0 ? 1 : 0;
}
