import { join } from "node:path";
import { hostPairProblem } from "../hosts.ts";
import type { State } from "../state.ts";
import type { Ctx, Step } from "../step.ts";
import { resolveVars } from "../tunables.ts";

const TEMPLATE = "apps/server/wrangler.template.jsonc";
const CONFIG = "apps/server/wrangler.jsonc";

/** Deterministic, adoptable names: everything is prefixed with --name. */
export const names = (name: string) => ({
  d1: name,
  r2: name,
  kv: `${name}-oauth`,
});

async function find(ctx: Ctx, accountId: string) {
  const n = names(ctx.opts.name);
  const a = `/accounts/${accountId}`;
  // ?name= is a fuzzy filter: page through every match for the exact name.
  const d1 = await ctx.api.all<{ uuid: string; name: string }>(
    `${a}/d1/database?name=${encodeURIComponent(n.d1)}`,
  );
  const r2 = await ctx
    .api<{ name: string }>("GET", `${a}/r2/buckets/${encodeURIComponent(n.r2)}`)
    .catch((e: { status?: number }) => {
      if (e.status === 404) return undefined;
      throw e;
    });
  const kv = await ctx.api.all<{ id: string; title: string }>(
    `${a}/storage/kv/namespaces`,
  );
  return {
    d1Id: d1.find((d) => d.name === n.d1)?.uuid,
    r2Bucket: r2?.name === n.r2 ? n.r2 : undefined,
    kvId: kv.find((k) => k.title === n.kv)?.id,
  };
}

/** What `find` did not find, by kind and name; empty when nothing is missing. */
function missingOf(ctx: Ctx, found: Awaited<ReturnType<typeof find>>) {
  const n = names(ctx.opts.name);
  return [
    !found.d1Id && `D1 ${n.d1}`,
    !found.r2Bucket && `R2 ${n.r2}`,
    !found.kvId && `KV ${n.kv}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Strips JSONC comments outside strings. */
export const stripComments = (text: string) =>
  text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_, str) => str ?? "",
  );

/**
 * Sets the tunable vars in rendered config text by parsing it, setting or
 * deleting keys of `vars` (an empty value is deleted: not rendered), and
 * serializing it back. Untouched when there is nothing to set.
 */
export function applyTunables(
  text: string,
  tunables: Record<string, string>,
): string {
  if (!Object.keys(tunables).length) return text;
  const cfg = JSON.parse(stripComments(text));
  cfg.vars ??= {};
  for (const [k, v] of Object.entries(tunables)) {
    if (v === "") delete cfg.vars[k];
    else cfg.vars[k] = v;
  }
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** Fills `{{KEY}}` with JSON-escaped values, then asserts the result is valid production config. */
export function renderConfig(
  template: string,
  vars: Record<string, string | undefined>,
  browser = true,
  email = false,
  plan: "free" | "paid" = "free",
  tunables: Record<string, string> = {},
): string {
  // The server answers these two hosts only (no any-host fallback), so a
  // template naming them must get a pair it can serve. A missing value is
  // the placeholder error below.
  if (
    template.includes("{{APP_HOST}}") &&
    template.includes("{{CONTENT_HOST}}") &&
    vars.APP_HOST !== undefined &&
    vars.CONTENT_HOST !== undefined
  ) {
    const problem = hostPairProblem(vars.APP_HOST, vars.CONTENT_HOST);
    if (problem) throw new Error(`rendered config: ${problem}`);
  }
  // The template stays strict JSON (e2e fixtures JSON.parse it), so the
  // browser and email lines are matched by their keys and dropped when off.
  // EMAIL_FROM and SERVER_THUMBNAILS are never the last var, so dropping
  // them leaves no trailing comma.
  const text = template
    .split("\n")
    .filter((l) => browser || !/^\s*"(browser|SERVER_THUMBNAILS)":/.test(l))
    .filter((l) => email || !/^\s*"(send_email|EMAIL_FROM)":/.test(l))
    .join("\n")
    .replace(/^(\s*"PLAN":\s*)"[^"\n]*"/m, `$1"${plan}"`)
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const val = vars[k];
      if (val === undefined)
        throw new Error(`no value for template placeholder {{${k}}}`);
      return JSON.stringify(val).slice(1, -1);
    });
  const out = applyTunables(text, tunables);
  JSON.parse(stripComments(out));
  if (!text.includes(`"PLAN": "${plan}"`))
    throw new Error(`rendered config must contain "PLAN": "${plan}"`);
  if (!text.includes('"ENVIRONMENT": "production"'))
    throw new Error('rendered config must contain "ENVIRONMENT": "production"');
  return out;
}

const configVars = (s: State, ctx: Ctx) => ({
  WORKER_NAME: ctx.opts.name,
  APP_HOST: ctx.opts.appHost,
  CONTENT_HOST: ctx.opts.contentHost,
  OWNER_EMAIL: ctx.opts.ownerEmail,
  D1_NAME: names(ctx.opts.name).d1,
  D1_ID: s.d1Id,
  R2_BUCKET: s.r2Bucket,
  KV_ID: s.kvId,
  CF_ACCOUNT_ID: s.accountId,
  // Filled by the `access` step (B16-2); B16-3's deploy refuses them empty.
  ACCESS_TEAM_DOMAIN: s.teamDomain ?? "",
  ACCESS_CLIENT_ID: s.accessClientId ?? "",
  EMAIL_FROM: ctx.opts.email ? `noreply@${ctx.opts.emailDomain}` : undefined,
});

/** Records ids in state and (re)writes the gitignored config; local only. */
function sync(state: State, ctx: Ctx, found: Awaited<ReturnType<typeof find>>) {
  Object.assign(state, found);
  writeConfig(state, ctx);
}

/** The config text the template and current state render to (nothing written). */
export function renderedConfig(state: State, ctx: Ctx): string {
  const template = ctx.fs.read(join(ctx.root, TEMPLATE));
  if (template === null) throw new Error(`missing ${TEMPLATE}`);
  return renderConfig(
    template,
    configVars(state, ctx),
    ctx.opts.browser,
    ctx.opts.email,
    ctx.opts.planVar,
    ctx.tunables ??
      resolveVars({
        flags: ctx.opts.varFlags,
        state: state.vars ?? {},
        live: {},
      }).values,
  );
}

/** Renders `apps/server/wrangler.jsonc` from the template and current state. */
export function writeConfig(state: State, ctx: Ctx) {
  const text = renderedConfig(state, ctx);
  if (ctx.fs.read(join(ctx.root, CONFIG)) !== text)
    ctx.fs.write(join(ctx.root, CONFIG), text);
}

export const resources: Step = {
  name: "resources",
  async check(state, ctx) {
    const found = await find(ctx, state.accountId ?? "");
    const missing = missingOf(ctx, found);
    if (missing) {
      ctx.notes.push(`missing: ${missing}`);
      return "todo";
    }
    sync(state, ctx, found);
    return "done";
  },
  async apply(state, ctx) {
    const n = names(ctx.opts.name);
    let found = await find(ctx, state.accountId ?? "");
    ctx.notes.length = 0;
    if (ctx.opts.upgrade) {
      const message = `missing ${missingOf(ctx, found)} on account ${state.accountId}; --upgrade never creates resources, run a full setup first (without --upgrade)`;
      return { status: "action_required", message };
    }
    if (!found.d1Id) await ctx.wrangler(["d1", "create", n.d1]);
    if (!found.r2Bucket) await ctx.wrangler(["r2", "bucket", "create", n.r2]);
    if (!found.kvId) await ctx.wrangler(["kv", "namespace", "create", n.kv]);
    found = await find(ctx, state.accountId ?? "");
    if (!found.d1Id || !found.r2Bucket || !found.kvId)
      throw new Error(
        `created resources not visible yet: ${JSON.stringify(found)}`,
      );
    sync(state, ctx, found);
    return undefined;
  },
};
