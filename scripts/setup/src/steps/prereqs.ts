import { type Api, makeApi } from "../cf.ts";
import { decide, detectPlan, warnings } from "../plan.ts";
import { providersOf, type Signin } from "../signin.ts";
import type { State } from "../state.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";
import {
  ENV_NAME,
  linkFor,
  type Token,
  tokens,
  type Zone,
  type ZoneScope,
  zoneScopeFor,
} from "../tokens.ts";
import { downgradeMessage, versionInfo } from "../version-guard.ts";
import { reusesDeployToken } from "./secrets.ts";

/** Hosts lacking a zone, found by check and reported by apply. */
const missingFor = new WeakMap<Ctx, string[]>();

/** Candidate zones for a host, most specific first: a.b.c.com → a.b.c.com, b.c.com, c.com. */
export const apexCandidates = (host: string) => {
  const labels = host.split(".");
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
};

/** The account's active zone holding `host`, most specific first. */
export async function zoneOf(ctx: Ctx, accountId: string, host: string) {
  for (const name of apexCandidates(host)) {
    const q = `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}&status=active`;
    const zones = await ctx.api<{ id: string; name: string }[]>("GET", q);
    if (zones.length) return { id: zones[0].id, name };
  }
  return null;
}

async function missingHosts(ctx: Ctx, accountId: string) {
  const { appHost, contentHost } = ctx.opts;
  const missing: string[] = [];
  const zones: Zone[] = [];
  for (const h of [appHost, contentHost]) {
    const z = await zoneOf(ctx, accountId, h);
    if (!z) missing.push(h);
    else if (!zones.some((x) => x.id === z.id)) zones.push(z);
  }
  return { missing, zones };
}

type ProbeIds = { a: string; zones: Zone[] };
/**
 * The token checks: read-only GETs per permission in the token table, keyed
 * `key:type`, one per zone for zone permissions; a 401/403 means the token
 * lacks it. A GET proves read access only, so an Edit is confirmed when its
 * step writes. Account Analytics has no GET probe (GraphQL is POST): the
 * token is verified live, and checked against the deploy token's id.
 */
export const PROBES: Record<string, (i: ProbeIds) => string[]> = {
  "workers_scripts:edit": ({ a }) => [`/accounts/${a}/workers/scripts`],
  "workers_kv_storage:edit": ({ a }) => [
    `/accounts/${a}/storage/kv/namespaces?per_page=1`,
  ],
  "workers_r2:edit": ({ a }) => [`/accounts/${a}/r2/buckets?per_page=1`],
  "d1:edit": ({ a }) => [`/accounts/${a}/d1/database?per_page=1`],
  "billing:read": ({ a }) => [`/accounts/${a}/subscriptions`],
  "zone:read": ({ a }) => [`/zones?account.id=${a}&per_page=1`],
  "workers_routes:edit": ({ zones }) =>
    zones.map((z) => `/zones/${z.id}/workers/routes`),
  "dns:edit": ({ zones }) =>
    zones.map((z) => `/zones/${z.id}/dns_records?per_page=1`),
  "access:edit": ({ a }) => [`/accounts/${a}/access/apps?per_page=1`],
  "access_acct:read": ({ a }) => [`/accounts/${a}/access/organizations`],
  "account_analytics:read": () => ["/user/tokens/verify"],
};

export type TokenIssue = {
  id: Token["id"];
  name: string;
  /** reused: ANALYTICS_TOKEN is the deploy token. optional: only optional permissions are absent. */
  status: "missing" | "lacks" | "reused" | "optional";
  env: string;
  missing?: string[];
  optional?: string[];
  required: boolean;
  url: string;
  zoneScope?: ZoneScope;
};

/** Which client checks a token; undefined when it isn't set (and isn't needed). */
function clientFor(t: Token, ctx: Ctx): Api | "missing" | undefined {
  const env = ctx.deps.env;
  if (t.id === "deploy")
    // Unset is fine: setup then uses the `wrangler login` token.
    return env.CLOUDFLARE_API_TOKEN ? ctx.api : undefined;
  if (t.id === "access")
    return env.OA_ACCESS_TOKEN || env.CLOUDFLARE_API_TOKEN
      ? ctx.accessApi
      : "missing";
  const v = env.ANALYTICS_TOKEN?.trim();
  return v ? makeApi(ctx.deps, ctx.wrangler, v) : "missing";
}

/**
 * Tokens that are missing, lack a permission, or (analytics) reuse the deploy
 * token, each with its pre-filled link. Under --ci or --strict, optional
 * tokens and optional permissions are never reported.
 */
export async function tokenIssues(
  state: State,
  ctx: Ctx,
  ids: ProbeIds,
): Promise<TokenIssue[]> {
  const quiet = ctx.opts.ci || ctx.opts.strict;
  const out: TokenIssue[] = [];
  // --auth-providers without access: the Access token is neither needed nor
  // probed. (Only the flag: prereqs reads nothing from the Worker; a missing
  // or failing token is a note here, never a refusal.)
  const flag = ctx.opts.signinFlags.AUTH_PROVIDERS;
  const accessOff =
    flag !== undefined &&
    !providersOf({ AUTH_PROVIDERS: flag } as Signin).includes("access");
  for (const t of tokens({ name: ctx.opts.name })) {
    if (t.id === "access" && accessOff) continue;
    const zoneScope = zoneScopeFor(t, ids.zones);
    const base = {
      id: t.id,
      name: t.name,
      env: ENV_NAME[t.id],
      required: t.required,
      url: linkFor(t, { accountId: ids.a, zones: ids.zones }),
      ...(zoneScope ? { zoneScope } : {}),
    };
    const client = clientFor(t, ctx);
    if (client === "missing") {
      // Access is only needed until the app exists; analytics until declined.
      const needed =
        t.id === "access"
          ? !state.accessClientId
          : !state.analyticsSkipped && !quiet;
      if (needed) out.push({ ...base, status: "missing" });
      continue;
    }
    if (!client) continue;
    if (
      t.id === "analytics" &&
      (await reusesDeployToken(ctx, ctx.deps.env.ANALYTICS_TOKEN?.trim() ?? ""))
    ) {
      out.push({ ...base, status: "reused" });
      continue;
    }
    const missing: string[] = [];
    const optional: string[] = [];
    for (const p of t.permissions) {
      if (p.required === false && quiet) continue;
      for (const path of PROBES[`${p.key}:${p.type}`]?.(ids) ?? []) {
        try {
          await client("GET", path);
        } catch (e) {
          const s = (e as { status?: number }).status;
          if (s !== 401 && s !== 403) continue;
          if (p.required === false)
            optional.push(`${p.label} (optional, ${p.note})`);
          else missing.push(p.label);
          break;
        }
      }
    }
    if (missing.length)
      out.push({
        ...base,
        status: "lacks",
        missing,
        ...(optional.length ? { optional } : {}),
      });
    else if (optional.length)
      out.push({ ...base, status: "optional", missing, optional });
  }
  return out;
}

const issueNote = (i: TokenIssue) => {
  const zones = i.zoneScope
    ? ` (under Zone Resources pick Specific zone: ${i.zoneScope.zones.join(", ")})`
    : "";
  if (i.status === "missing")
    return `${i.name} token not set (${i.env}${i.required ? "" : ", optional"}); create it: ${i.url}${zones}`;
  if (i.status === "reused")
    return `${i.env} is the deploy token (same token id); create a dedicated read-only one: ${i.url}`;
  const opt = i.optional?.length ? `${i.optional.join(", ")} not granted` : "";
  const lacks = i.missing?.length ? `lacks ${i.missing.join(", ")}` : "";
  return `${i.name} token (${i.env}) ${[lacks, opt].filter(Boolean).join("; ")}; ${lacks ? "create one" : "add it"}: ${i.url}${zones}`;
};

/** A pure verification: `done` (skipped) when every prerequisite holds. */
export const prereqs: Step = {
  name: "prereqs",
  okWhenDone: "prerequisites ok",
  async check(state, ctx) {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22)
      throw new Error(`Node >= 22 required (found ${process.versions.node})`);
    if ((await ctx.deps.exec("pnpm", ["--version"])).code !== 0)
      throw new Error("pnpm not found on PATH");
    // First, so an older checkout stops before any step has a side effect (--check only reports).
    ctx.version = await versionInfo(state, ctx);
    if (ctx.version.downgrade && !ctx.opts.allowDowngrade && !ctx.opts.check)
      throw new NeedInput(downgradeMessage(ctx.version));
    const who = JSON.parse(await ctx.wrangler(["whoami", "--json"])) as {
      accounts?: { id: string; name: string }[];
    };
    const accounts = who.accounts ?? [];
    if (!accounts.length)
      throw new Error(
        "`wrangler whoami` lists no accounts; run `wrangler login`",
      );
    let id =
      ctx.opts.accountId ??
      (accounts.length === 1 ? accounts[0].id : undefined);
    if (!id) {
      const list = accounts.map((a) => `${a.id} (${a.name})`).join(", ");
      if (ctx.opts.json)
        throw new NeedInput(`several accounts (${list}); pass --account-id`);
      if (ctx.opts.yes)
        throw new Error(`several accounts (${list}); pass --account-id`);
      id = await ctx.deps.prompt(`Cloudflare account id [${list}]:`);
    }
    if (!accounts.some((a) => a.id === id))
      throw new Error(`--account-id ${id} is not in \`wrangler whoami\``);
    state.accountId = id;
    const plan = await detectPlan(ctx, id);
    const extra = await decide(state, ctx, plan);
    const confirmed = plan !== "paid" && ctx.opts.planVar === "paid";
    const warns = [...warnings(plan, confirmed), ...extra];
    if (plan === "paid") ctx.notes.unshift("Workers Paid detected");
    else if (confirmed)
      ctx.notes.unshift(
        ctx.opts.yesPaid
          ? "Workers Paid confirmed (--yes-paid)"
          : ctx.opts.planFlag === "paid"
            ? "Workers Paid (--plan paid)"
            : "Workers Paid (saved plan)",
      );
    const { missing, zones } = await missingHosts(ctx, id);
    const issues = await tokenIssues(state, ctx, { a: id, zones });
    // The optional analytics token's link is a note only on the first run (no saved state);
    // data.tokens always lists it.
    ctx.notes.push(
      ...issues
        .filter(
          (i) => i.id !== "analytics" || i.status !== "missing" || ctx.noState,
        )
        .map(issueNote),
    );
    // Nothing goes into the message: warnings and notes are data.
    const notes = ctx.notes.splice(0);
    ctx.data = {
      plan,
      planVar: ctx.opts.planVar,
      warnings: warns,
      ...(notes.length ? { notes } : {}),
      ...(issues.length ? { tokens: issues } : {}),
    };
    missingFor.set(ctx, missing);
    return missing.length ? "todo" : "done";
  },
  async apply(state, ctx) {
    const missing = missingFor.get(ctx) ?? [];
    return {
      status: "action_required",
      message: `not in any zone of account ${state.accountId}: ${missing.join(", ")}. Add the zone to this account, then rerun.`,
      data: { missing },
    };
  },
};
