import { makeApi } from "../cf.ts";
import { providersOf, type Signin } from "../signin.ts";
import { type State, writeState } from "../state.ts";
import {
  type ActionRequired,
  type Ctx,
  NeedInput,
  type Step,
} from "../step.ts";
import { linkFor, tokenById } from "../tokens.ts";
import { deployedVars, PINNED } from "../worker.ts";
import { writeConfig } from "./resources.ts";
import { ACCESS_SECRET, listSecrets, putSecret } from "./secrets.ts";

// Ported from scripts/ops/staging-access.ts (B4).
export const POLICY_NAME = "Open Artifacts – everyone";
const POLICY_BODY = {
  name: POLICY_NAME,
  decision: "allow",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
  approval_required: false,
  isolation_required: false,
  purpose_justification_required: false,
};
const CARRY_OVER = ["session_duration"] as const;
/** The access token's pre-filled link and permission labels, from the token table. */
const accessToken = (ctx: Ctx) => tokenById("access", { name: ctx.opts.name });
export const accessUrl = (ctx: Ctx, accountId?: string) =>
  linkFor(accessToken(ctx), { accountId });
const accessLabels = (ctx: Ctx) =>
  accessToken(ctx)
    .permissions.map((p) => p.label)
    .join("; ");
const ZERO_TRUST = "https://one.dash.cloudflare.com/";

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;
const AR = (message: string, data?: unknown): ActionRequired => ({
  status: "action_required",
  message,
  data,
});
const status = (e: unknown) => (e as { status?: number }).status;
const empty = (x: unknown) => x == null || (Array.isArray(x) && x.length === 0);
const isEveryone = (inc: unknown) =>
  Array.isArray(inc) &&
  inc.length === 1 &&
  JSON.stringify(inc[0]) === '{"everyone":{}}';
const policyMatches = (p: Obj) =>
  p.decision === "allow" &&
  isEveryone(p.include) &&
  empty(p.exclude) &&
  empty(p.require) &&
  !p.approval_required &&
  !p.isolation_required &&
  !p.purpose_justification_required;
const callback = (ctx: Ctx) => `https://${ctx.opts.appHost}/auth/callback`;
const linked = (app: Obj, policyId?: string) =>
  Boolean(policyId) && app.policies?.some((p: Obj) => p.id === policyId);

const TEAM = /(?:^|\/\/)([a-z0-9-]+\.cloudflareaccess\.com)(?=$|[/:?#])/i;
/** Seconds between OIDC discovery attempts: ~15s in all. */
const DISCOVERY_DELAYS = [1, 2, 4, 8];
const TEAM_HOST = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;

/**
 * The team domain from the Access app object, when a field carries it. The
 * documented OIDC `saas_app` has none; SAML's `sso_endpoint`/`idp_entity_id`
 * do, and the app's `domain` does when the API returns it.
 */
export function teamDomainOf(app: Obj): string | undefined {
  const fields = [
    app?.domain,
    app?.saas_app?.issuer,
    app?.saas_app?.sso_endpoint,
    app?.saas_app?.idp_entity_id,
  ];
  for (const v of fields) {
    const m = typeof v === "string" ? v.match(TEAM) : null;
    if (m) return m[1].toLowerCase();
  }
  return undefined;
}

/** OA_TEAM_DOMAIN (a non-secret CI variable): exactly `<team>.cloudflareaccess.com`, lowercased. */
function envTeamDomain(ctx: Ctx): string | undefined {
  const raw = ctx.deps.env.OA_TEAM_DOMAIN?.trim();
  if (!raw) return undefined;
  if (!TEAM_HOST.test(raw))
    throw new Error(
      `invalid OA_TEAM_DOMAIN: ${JSON.stringify(raw)} (expected <team>.cloudflareaccess.com)`,
    );
  return raw.toLowerCase();
}

/** OA_TEAM_DOMAIN counts only when its OIDC discovery for this client names that exact issuer. */
async function verifyIssuer(ctx: Ctx, domain: string, clientId: string) {
  const base = `https://${domain}/cdn-cgi/access/sso/oidc/${clientId}`;
  const url = `${base}/.well-known/openid-configuration`;
  const sleep =
    ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fix =
    "Fix OA_TEAM_DOMAIN, or use an OA_ACCESS_TOKEN with Access: Organizations Read.";
  let last = "";
  // Transient failures (fresh app, propagation) retry ~15s; a wrong issuer fails at once.
  for (const delay of [...DISCOVERY_DELAYS, undefined]) {
    let issuer: unknown;
    try {
      const res = await ctx.deps.fetch(url);
      if (res.ok) issuer = ((await res.json()) as { issuer?: unknown }).issuer;
      else last = `HTTP ${res.status}`;
      if (res.ok && typeof issuer !== "string") last = "no issuer in response";
    } catch (e) {
      last = (e as Error).message;
    }
    if (issuer === base) return;
    if (typeof issuer === "string")
      throw new NeedInput(
        `OA_TEAM_DOMAIN ${domain} not verified: OIDC issuer mismatch for client ${clientId} (got ${issuer}, expected ${base}). ${fix}`,
      );
    if (delay === undefined) break;
    await sleep(delay * 1000);
  }
  throw new NeedInput(
    `OA_TEAM_DOMAIN ${domain} not verified: OIDC discovery failed for client ${clientId} after ~15s (last: ${last}). ${fix}`,
  );
}

/** A 5xx or a timeout: the Access API is down, not refusing us. */
const outage = (e: unknown) => {
  if (e instanceof NeedInput) return false;
  const st = status(e);
  if (st !== undefined) return st >= 500;
  return /time(d)? ?out|ETIMEDOUT|fetch failed|ECONN/i.test(
    (e as Error)?.message ?? "",
  );
};

/**
 * Under --upgrade, an Access outage must not block a deploy that never changes
 * Access. The app counts as known from saved state (same host and account), or
 * from the live Worker's ACCESS_TEAM_DOMAIN and ACCESS_CLIENT_ID vars when there
 * is no state; either way the live Worker's hosts, owner and account must match
 * this run and its client secret must be there. Anything else stays an error.
 */
async function tolerateOutage(state: State, ctx: Ctx, e: unknown) {
  if (!ctx.opts.upgrade || !outage(e)) return false;
  const hadState = ctx.prev?.appHost !== undefined;
  if (
    hadState &&
    !(
      ctx.prev?.appHost === ctx.opts.appHost &&
      ctx.prev?.accountId === state.accountId
    )
  )
    throw new Error(
      "Access API unavailable; can't verify the new host's callback; retry later",
    );
  const accountId = state.accountId ?? "";
  const vars = await deployedVars(ctx, accountId).catch(() => undefined);
  if (!vars) return false;
  const fromState = Boolean(
    hadState && state.accessAppId && state.teamDomain && state.accessClientId,
  );
  const teamDomain = (
    fromState ? state.teamDomain : vars.get("ACCESS_TEAM_DOMAIN")
  )?.toLowerCase();
  const clientId = fromState
    ? state.accessClientId
    : vars.get("ACCESS_CLIENT_ID");
  if (!teamDomain || !TEAM_HOST.test(teamDomain) || !clientId) return false;
  if (
    !(await listSecrets(ctx).catch(() => new Set<string>())).has(ACCESS_SECRET)
  )
    return false;
  // A Workers API read, not Access: the live Worker must be this install.
  await verifyWorker(ctx, accountId, {
    APP_HOST: ctx.opts.appHost,
    CONTENT_HOST: ctx.opts.contentHost,
    OWNER_EMAIL: ctx.opts.ownerEmail,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_CLIENT_ID: clientId,
  });
  const liveAccount = vars.get("CF_ACCOUNT_ID");
  if (liveAccount && accountId && liveAccount !== accountId)
    throw new NeedInput(
      `the deployed Worker ${ctx.opts.name} differs in CF_ACCOUNT_ID; pass the flags it was deployed with, or rerun a full setup (without --upgrade) to change them`,
    );
  Object.assign(state, { teamDomain, accessClientId: clientId });
  writeConfig(state, ctx);
  ctx.notes.push(
    `Access API unavailable (${status(e) ?? "timeout"}); verified from ${fromState ? "saved state" : "the live Worker"} only (upgrade never changes Access)`,
  );
  return true;
}

/** Thrown when only the organization (team domain) is unreadable. */
const orgDenied = () =>
  Object.assign(new Error("GET organizations: 403"), {
    status: 403,
    teamDomain: true,
  });
/** Organization denied and no app visible: an unscoped token lists none, so this proves nothing. */
const noApps = () =>
  Object.assign(new Error("GET organizations: 403, no apps"), {
    status: 403,
    noApps: true,
  });

/** Finds the policy and app by name; the team domain from the app, the organization, then OA_TEAM_DOMAIN. */
async function lookup(ctx: Ctx, accountId: string) {
  const a = `/accounts/${accountId}/access`;
  const policy = (await ctx.accessApi.all<Obj>(`${a}/policies`)).find(
    (p) => p.name === POLICY_NAME,
  );
  const named = (await ctx.accessApi.all<Obj>(`${a}/apps`)).filter(
    (x) => x.name === ctx.opts.name,
  );
  if (named.length > 1)
    throw new NeedInput(
      `${named.length} Access apps are named ${ctx.opts.name}: ${named.map((x) => x.id).join(", ")}. Delete all but one in Zero Trust > Access > Applications, then rerun.`,
    );
  const app = named[0];
  let domain = app && teamDomainOf(app);
  /** OA_TEAM_DOMAIN with no app to verify it against yet: create() verifies it after the POST. */
  let unverified = false;
  if (!domain) {
    let forbidden = false;
    // A 404 or a null result both mean "no Zero Trust organization".
    const org = await ctx
      .accessApi<{ auth_domain?: string } | null>("GET", `${a}/organizations`)
      .catch((e) => {
        if (status(e) === 404) return null;
        if (status(e) !== 403) throw e;
        forbidden = true;
        return null;
      });
    domain = org?.auth_domain;
    if (forbidden) {
      const env = envTeamDomain(ctx);
      if (!app) {
        // Only a full setup may go on, and the app POST then proves the token's scope.
        if (!env || ctx.opts.upgrade || ctx.opts.check) throw noApps();
        unverified = true;
      } else if (!env) throw orgDenied();
      else await verifyIssuer(ctx, env, app.saas_app?.client_id ?? "");
      domain = env;
    }
  }
  return {
    a,
    domain,
    unverified,
    policy,
    app,
    have: await listSecrets(ctx),
  };
}

/**
 * Without saved state, the live Worker's plain-text vars must equal the flags
 * and the rebuilt values. Skipped when the Worker doesn't exist yet, or is a
 * draft (created by a secret put) with none of these vars.
 */
async function verifyWorker(
  ctx: Ctx,
  accountId: string,
  want: Record<(typeof PINNED)[number], string>,
) {
  const vars = await deployedVars(ctx, accountId);
  if (!vars) return;
  const off = PINNED.filter((k) => vars.get(k) !== want[k]);
  if (off.length)
    throw new NeedInput(
      `the deployed Worker ${ctx.opts.name} differs in ${off.join(", ")}; pass the flags it was deployed with, or rerun a full setup (without --upgrade) to change them`,
    );
}

async function record(
  state: State,
  ctx: Ctx,
  teamDomain: string,
  app: Obj,
  verify = true,
) {
  if (!app.saas_app.redirect_uris?.includes(callback(ctx)))
    throw new NeedInput(
      `Access app ${app.name} redirect_uris lack ${callback(ctx)}; add it in Zero Trust > Access > Applications > ${app.name}, then rerun.`,
    );
  if (verify && ctx.noState)
    await verifyWorker(ctx, state.accountId ?? "", {
      APP_HOST: ctx.opts.appHost,
      CONTENT_HOST: ctx.opts.contentHost,
      OWNER_EMAIL: ctx.opts.ownerEmail,
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_CLIENT_ID: app.saas_app.client_id,
    });
  Object.assign(state, {
    teamDomain,
    accessAppId: app.id,
    accessClientId: app.saas_app.client_id,
  });
  delete state.pendingAccessAppId;
  writeConfig(state, ctx);
}

/** How the user hands setup an Access token without it entering a chat. */
const saveFlow = (ctx: Ctx) =>
  `run \`pnpm -s oa:setup --token-links --json\` to get the save line (\`saveCommand\`); the user runs it in their own terminal (in Claude Code, type \`! \` then the line), and setup then reads ~/.open-artifacts/${ctx.opts.name}-access-token (or the OA_ACCESS_TOKEN env var)`;

/** Lookup with OA_ACCESS_TOKEN or the wrangler token; on 403, ask once (memory only). */
async function lookupWithToken(ctx: Ctx, accountId: string) {
  const how = ctx.opts.interactive
    ? `${saveFlow(ctx)}, or rerun interactively and paste it (kept in memory only)`
    : saveFlow(ctx);
  const url = accessUrl(ctx, accountId);
  const create = `Create one (${accessLabels(ctx)}) at ${url}, then ${how}; then rerun`;
  const lower = `${create[0].toLowerCase()}${create.slice(1)}`;
  const deny = (e: unknown) => {
    const x = e as { teamDomain?: boolean; noApps?: boolean };
    return AR(
      x.teamDomain
        ? `This token cannot read the Access organization, so the team domain is unknown. Set OA_TEAM_DOMAIN=<team>.cloudflareaccess.com, or ${lower}.`
        : x.noApps
          ? ctx.opts.upgrade
            ? `This token cannot read the Access organization and sees no Access app named ${ctx.opts.name} (a token without Access scopes sees none). ${create}.`
            : // A fresh install has no app to verify OA_TEAM_DOMAIN against, so don't offer it.
              `A fresh install needs a Cloudflare Access token (${accessToken(
                ctx,
              )
                .permissions.map((p) => p.label)
                .join(
                  ", ",
                )}). Create it at ${url}, save it with the line from \`pnpm -s oa:setup --token-links --json\` (saveCommand), then rerun.`
          : `This token cannot read Access. ${create}.${ctx.noState ? "" : " (OA_TEAM_DOMAIN can stand in for Organizations Read.)"}`,
      { url },
    );
  };
  try {
    return await lookup(ctx, accountId);
  } catch (e) {
    if (status(e) !== 403) throw e;
    if (!ctx.opts.interactive) return deny(e);
    const q = `Paste an OA_ACCESS_TOKEN (input hidden; create one at ${url}):`;
    const token = await ctx.deps.prompt(q, { secret: true });
    if (!token) return deny(e);
    ctx.accessApi = makeApi(ctx.deps, ctx.wrangler, token);
    try {
      return await lookup(ctx, accountId);
    } catch (e2) {
      if (status(e2) === 403) return deny(e2);
      throw e2;
    }
  }
}

/** An Access write answered 403: the token lacks Access: Apps and Policies Edit. */
const writeScope =
  (ctx: Ctx, accountId: string | undefined, what: string) => (e: unknown) => {
    if (status(e) !== 403) throw e;
    const edit = accessToken(ctx).permissions.find((p) => p.type === "edit");
    throw new NeedInput(
      `${what}: 403, this token cannot write Access. Use an OA_ACCESS_TOKEN with ${edit?.label} (create one at ${accessUrl(ctx, accountId)}), then rerun.`,
    );
  };

/** POST the app and put its client secret as one interruption-safe unit. */
async function create(
  state: State,
  ctx: Ctx,
  a: string,
  policyId: string,
  domain: string,
  unverified: boolean,
) {
  let interrupted = false;
  // First Ctrl-C: let the rollback run. Second: exit now, naming what may be orphaned.
  const onSigint = () => {
    if (interrupted) {
      const id = state.pendingAccessAppId ?? "unknown (POST in flight)";
      process.stderr.write(
        `\nSecond interrupt: exiting. Access app ${ctx.opts.name} (${id}) may be orphaned; pendingAccessAppId in .openartifacts/state.json lets the next run delete and recreate it.\n`,
      );
      process.exit(130);
    }
    interrupted = true;
  };
  process.on("SIGINT", onSigint);
  try {
    const created = await ctx
      .accessApi<Obj>("POST", `${a}/apps`, {
        name: ctx.opts.name,
        type: "saas",
        policies: [{ id: policyId, precedence: 1 }],
        saas_app: {
          auth_type: "oidc",
          redirect_uris: [callback(ctx)],
          grant_types: ["authorization_code_with_pkce"],
          allow_pkce_without_client_secret: false,
          scopes: ["openid", "email", "profile"],
        },
      })
      .catch(writeScope(ctx, state.accountId, "POST Access app"));
    state.pendingAccessAppId = created.id;
    writeState(ctx.fs, ctx.root, state);
    try {
      const secret = created?.saas_app?.client_secret;
      if (typeof secret !== "string" || !secret || !created.saas_app.client_id)
        throw new Error(
          "create response lacks saas_app.client_secret or client_id",
        );
      // OA_TEAM_DOMAIN stood in for the organization: verify it before keeping the app.
      if (unverified)
        await verifyIssuer(ctx, domain, created.saas_app.client_id);
      await putSecret(ctx, ACCESS_SECRET, secret);
      if (interrupted)
        throw new Error("interrupted (SIGINT); Access app rolled back");
      await record(state, ctx, domain, created, false);
    } catch (e) {
      // The client secret is unrecoverable once lost: undo the create.
      await ctx.accessApi("DELETE", `${a}/apps/${created.id}`).then(
        () => delete state.pendingAccessAppId,
        () => {
          (e as Error).message +=
            `; rollback failed: DELETE of Access app ${created.id} also failed, delete it in Zero Trust > Access > Applications`;
        },
      );
      throw interrupted ? Object.assign(e as Error, { exitCode: 130 }) : e;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/**
 * Whether sign-in uses Access: AUTH_PROVIDERS from the flag, else the live
 * Worker's. Unset, or unreadable, counts as access (the server's default).
 */
async function accessInUse(ctx: Ctx, accountId: string): Promise<boolean> {
  const live = async () =>
    (await deployedVars(ctx, accountId).catch(() => undefined))?.get(
      "AUTH_PROVIDERS",
    );
  const v = ctx.opts.signinFlags.AUTH_PROVIDERS ?? (await live()) ?? "";
  return providersOf({ AUTH_PROVIDERS: v } as Signin).includes("access");
}
const NOT_NEEDED = "not needed: access isn't in AUTH_PROVIDERS";

export const access: Step = {
  name: "access",
  async check(state, ctx) {
    // Google or email only: never look up, create or require an Access app.
    if (!(await accessInUse(ctx, state.accountId ?? ""))) {
      ctx.notes.push(NOT_NEEDED);
      return "done";
    }
    // From state alone under --upgrade, or when no OA_ACCESS_TOKEN can re-check.
    const noToken = !ctx.deps.env.OA_ACCESS_TOKEN;
    // Only for the same install: a changed host or account needs the full path.
    const same =
      ctx.prev?.appHost === ctx.opts.appHost &&
      ctx.prev?.accountId === state.accountId;
    if (
      (ctx.opts.upgrade || noToken) &&
      same &&
      state.accessAppId &&
      state.accessClientId &&
      state.teamDomain
    ) {
      if (!(await listSecrets(ctx)).has(ACCESS_SECRET)) return "todo";
      ctx.notes.push(
        ctx.opts.upgrade
          ? "verified from state only (--upgrade); rerun without --upgrade to reconcile Access"
          : `Access not re-verified: to re-check, ${saveFlow(ctx)}`,
      );
      return "done";
    }
    let down = false;
    const l = await lookup(ctx, state.accountId ?? "").catch(async (e) => {
      if (await tolerateOutage(state, ctx, e)) {
        down = true;
        return undefined;
      }
      if (status(e) !== 403) throw e;
      ctx.notes.push(
        e.teamDomain
          ? "team domain unknown: organizations 403; set OA_TEAM_DOMAIN or use an OA_ACCESS_TOKEN with Access: Organizations Read"
          : `this token cannot read Access (organizations 403, no app named ${ctx.opts.name} visible); set OA_ACCESS_TOKEN`,
      );
      return undefined;
    });
    if (down) return "done";
    if (!l) return "todo";
    const drift = !l.policy || !policyMatches(l.policy);
    const why = !l.domain
      ? "no Zero Trust organization"
      : !l.app
        ? `Access app ${ctx.opts.name} not found`
        : l.app.type !== "saas" || l.app.saas_app?.auth_type !== "oidc"
          ? `Access app ${ctx.opts.name} is not SaaS OIDC`
          : !linked(l.app, l.policy?.id)
            ? `Access app ${ctx.opts.name} not linked to policy "${POLICY_NAME}"`
            : !l.app.saas_app.client_id
              ? `Access app ${ctx.opts.name} has no client_id`
              : !l.have.has(ACCESS_SECRET)
                ? `${ACCESS_SECRET} missing on the Worker`
                : drift && !ctx.opts.upgrade
                  ? `policy "${POLICY_NAME}" drifted`
                  : undefined;
    if (why) {
      ctx.notes.push(why);
      return "todo";
    }
    if (drift)
      ctx.notes.push(
        `policy "${POLICY_NAME}" drifted; not reconciled (--upgrade), rerun without --upgrade to fix`,
      );
    await record(state, ctx, l.domain as string, l.app);
    return "done";
  },
  async apply(state, ctx) {
    if (!(await accessInUse(ctx, state.accountId ?? ""))) {
      ctx.notes.push(NOT_NEEDED);
      return undefined;
    }
    // Preflight: nothing is written until every check below has passed.
    let l: Awaited<ReturnType<typeof lookupWithToken>>;
    try {
      l = await lookupWithToken(ctx, state.accountId ?? "");
    } catch (e) {
      if (await tolerateOutage(state, ctx, e)) return undefined;
      throw e;
    }
    if ("status" in l) return l;
    if (!l.domain)
      return AR(
        `No Zero Trust organization on this account: open ${ZERO_TRUST}, enable Zero Trust (free), then rerun.`,
        { url: ZERO_TRUST },
      );
    const where = `Zero Trust > Access > Applications > ${ctx.opts.name}`;
    let app = l.app;
    if (
      !ctx.opts.upgrade &&
      app &&
      app.id === state.pendingAccessAppId &&
      !l.have.has(ACCESS_SECRET) &&
      app.saas_app?.redirect_uris?.includes(callback(ctx))
    ) {
      // Ours, from an interrupted run, and its secret is lost: recreate it.
      await ctx.accessApi("DELETE", `${l.a}/apps/${app.id}`);
      delete state.pendingAccessAppId;
      app = undefined;
    }
    if (app) {
      // Never PUT an existing app: a full replace would drop dashboard edits.
      if (app.type !== "saas" || app.saas_app?.auth_type !== "oidc")
        return AR(
          `Access app ${ctx.opts.name} exists but is not a SaaS OIDC app. Rename or delete it (${where}), then rerun.`,
        );
      if (!linked(app, l.policy?.id))
        return AR(
          `Access app ${ctx.opts.name} is not linked to policy "${POLICY_NAME}". Attach it in ${where} > Policies, or delete the app, then rerun.`,
        );
      if (!app.saas_app.client_id)
        throw new Error(
          `Access app ${ctx.opts.name} has no saas_app.client_id`,
        );
      if (!l.have.has(ACCESS_SECRET))
        return AR(
          `${ACCESS_SECRET} is missing on the Worker and can't be recovered: the API returns the client secret only on create. Delete the Access app (${where}), then rerun.`,
        );
    }
    if (ctx.opts.upgrade) {
      // --upgrade never writes Access: no create, no policy POST or PUT.
      if (!app)
        return AR(
          `Access app ${ctx.opts.name} not found on account ${state.accountId}; --upgrade never creates it, run a full setup first (without --upgrade).`,
        );
      await record(state, ctx, l.domain, app);
      return undefined;
    }
    // Redirect and deployed-Worker checks also come before any policy write.
    if (app) await record(state, ctx, l.domain, app);
    // The policy is written only once the existing-app checks have passed.
    let policyId: string = l.policy?.id;
    if (!l.policy)
      policyId = (
        await ctx
          .accessApi<Obj>("POST", `${l.a}/policies`, POLICY_BODY)
          .catch(writeScope(ctx, state.accountId, "POST Access policy"))
      ).id;
    else if (!policyMatches(l.policy)) {
      const kept = Object.fromEntries(
        CARRY_OVER.filter((k) => l.policy[k] !== undefined).map((k) => [
          k,
          l.policy[k],
        ]),
      );
      await ctx
        .accessApi("PUT", `${l.a}/policies/${policyId}`, {
          ...kept,
          ...POLICY_BODY,
        })
        .catch(writeScope(ctx, state.accountId, "PUT Access policy"));
    }
    if (!app) await create(state, ctx, l.a, policyId, l.domain, l.unverified);
    return undefined;
  },
};
