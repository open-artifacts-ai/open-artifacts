import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type Deployed, fromWorker, type Sources } from "./by-name.ts";
import { type Deps, makeApi, makeWrangler, realDeps, realFs } from "./cf.ts";
import { hostPairProblem } from "./hosts.ts";
import { readOnlyDeps } from "./readonly.ts";
import { rollbackCommand } from "./rollback.ts";
import { parseSigninFlags } from "./signin.ts";
import { readState, type State, statePath, writeState } from "./state.ts";
import { type Ctx, NeedInput, type Opts, type Step } from "./step.ts";
import { access } from "./steps/access.ts";
import { agentConfig } from "./steps/agent-config.ts";
import { deploy } from "./steps/deploy.ts";
import { email } from "./steps/email.ts";
import {
  ownerToken,
  revokeCiTokens,
  revokeToken,
} from "./steps/owner-token.ts";
import { prereqs } from "./steps/prereqs.ts";
import { resources } from "./steps/resources.ts";
import { secrets } from "./steps/secrets.ts";
import { healthcheck, selftest } from "./steps/selftest.ts";
import { withTokenFiles } from "./token-files.ts";
import { isTokenCommand, tokenCommand } from "./token-page.ts";
import { parseVarFlags } from "./tunables.ts";

export const STEPS: Step[] = [
  prereqs,
  resources,
  access,
  secrets,
  email,
  deploy,
  healthcheck,
  ownerToken,
  selftest,
  agentConfig,
];

type Line = {
  step: string;
  /** `done`/`todo` only under --check. */
  status: "ok" | "skipped" | "action_required" | "error" | "done" | "todo";
  message: string;
  data?: unknown;
};
const ICON = {
  ok: "✓",
  skipped: "·",
  action_required: "!",
  error: "✗",
  done: "✓",
  todo: "○",
};

/** Token env vars whose values are scrubbed from every reported line. */
const SECRET_ENV = [
  "CLOUDFLARE_API_TOKEN",
  "OA_ACCESS_TOKEN",
  "ANALYTICS_TOKEN",
] as const;
const PAT_RE = /oa_pat_[1-9A-HJ-NP-Za-km-z]+/g;
const HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL = /^[^\s@"\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const NAME = /^[a-z0-9-]+$/;

function valid(flag: string, val: string, re: RegExp) {
  if (!re.test(val)) throw new Error(`invalid ${flag}: ${JSON.stringify(val)}`);
  return val;
}

// apps/server/src/db/email.ts: printable ASCII, checked before and after lowercasing.
const ASCII_EMAIL = /^[!-?A-~]+@[!-?A-~]+$/;
function normEmail(raw: string) {
  const e = raw.trim().toLowerCase();
  if (![raw.trim(), e].every((x) => x.length <= 320 && ASCII_EMAIL.test(x)))
    throw new Error(`invalid --owner-email: ${JSON.stringify(raw)}`);
  return e;
}

async function resolve(
  argv: string[],
  deps: Deps,
  state: State,
  deployed?: Deployed,
) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      name: { type: "string" },
      "app-host": { type: "string" },
      "content-host": { type: "string" },
      "owner-email": { type: "string" },
      "account-id": { type: "string" },
      yes: { type: "boolean", default: false },
      upgrade: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "allow-downgrade": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      "new-owner-token": { type: "boolean", default: false },
      "print-token": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      ci: { type: "boolean", default: false },
      "revoke-ci-tokens": { type: "boolean", default: false },
      "token-file": { type: "string" },
      "access-token-file": { type: "string" },
      "analytics-token-file": { type: "string" },
      browser: { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      solo: { type: "boolean", default: false },
      team: { type: "boolean", default: false },
      "no-email": { type: "boolean", default: false },
      "email-domain": { type: "string" },
      "yes-email-domain": { type: "boolean", default: false },
      "yes-paid": { type: "boolean", default: false },
      plan: { type: "string" },
      var: { type: "string", multiple: true },
      // Direct sign-in vars (src/signin.ts SIGNIN).
      "auth-providers": { type: "string" },
      "auth-domains": { type: "string" },
      "auth-domain-join": { type: "string" },
      "google-client-id": { type: "string" },
      "turnstile-site-key": { type: "string" },
      "email-code-domain": { type: "string" },
      "code-emails-per-day": { type: "string" },
      // Handled before resolve() by tokenCommand (src/token-page.ts).
      "token-links": { type: "boolean", default: false },
      "token-page": { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      repo: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const json = v.json || v.ci;
  const interactive = !v.yes && !json;
  // Precedence: flag, then saved state, then an interactive prompt.
  const need = async (
    flag: string,
    re: RegExp,
    saved?: string,
    live?: string,
  ) => {
    const q = `${flag.slice(2).replace("-", " ")}:`;
    const val =
      (v[flag.slice(2) as keyof typeof v] as string | undefined) ??
      saved ??
      live ??
      (interactive ? await deps.prompt(q) : undefined);
    if (val) return valid(flag, val, re);
    if (json) throw new NeedInput(`pass ${flag} (--json never prompts)`);
    throw new Error(`missing ${flag} (required with --yes)`);
  };
  if (v.ci && !v.name) throw new Error("--ci requires --name");
  if (v.ci && v["new-owner-token"])
    throw new Error(
      "--ci mints and revokes its own token; drop --new-owner-token",
    );
  if (v["revoke-ci-tokens"] && !v.ci)
    throw new Error("--revoke-ci-tokens needs --ci");
  if (v.strict && !v.check) throw new Error("--strict needs --check");
  if (v.repo !== undefined || v["no-open"])
    throw new Error(
      "--repo and --no-open only go with --token-links or --token-page",
    );
  if (v.plan !== undefined && v.plan !== "paid" && v.plan !== "free")
    throw new Error(
      `invalid --plan: ${JSON.stringify(v.plan)} (expected paid or free)`,
    );
  if (v.solo && v.team) throw new Error("--solo and --team conflict; pass one");
  if (v.browser && v["no-browser"])
    throw new Error("--browser and --no-browser conflict; pass one");
  // Without state, the name is what everything is found by: never guess it.
  if (!v.name && !state.name && (v.upgrade || v.check || v.yes || v.json))
    throw new NeedInput(
      "pass --name (no saved state; with --upgrade, --check, --yes or --json the install name is never defaulted)",
    );
  const name = valid("--name", v.name ?? state.name ?? "open-artifacts", NAME);
  if (state.name && name !== state.name) {
    const q = `State is for --name ${state.name}; switch to ${name}? [y/N]`;
    if (json)
      throw new NeedInput(
        `--name ${name} conflicts with saved --name ${state.name}; pass --name ${state.name}, or rerun interactively to switch`,
      );
    if (v.yes || !/^y(es)?$/i.test(await deps.prompt(q)))
      throw new Error(
        `--name ${name} conflicts with saved --name ${state.name}; confirm interactively to switch`,
      );
  }
  const opts: Opts = {
    name,
    // The cleanup-only mode touches D1 by name: no hosts needed.
    appHost: v["revoke-ci-tokens"]
      ? (v["app-host"] ?? state.appHost ?? "")
      : await need("--app-host", HOST, state.appHost, deployed?.appHost),
    contentHost: v["revoke-ci-tokens"]
      ? (v["content-host"] ?? state.contentHost ?? "")
      : await need(
          "--content-host",
          HOST,
          state.contentHost,
          deployed?.contentHost,
        ),
    ownerEmail: valid(
      "--owner-email",
      normEmail(
        await need(
          "--owner-email",
          /./,
          state.ownerEmail,
          deployed?.ownerEmail,
        ),
      ),
      EMAIL,
    ),
    accountId:
      v["account-id"] ??
      state.accountId ??
      deployed?.accountId ??
      deps.env.CLOUDFLARE_ACCOUNT_ID,
    // Flag, then saved state; undefined is decided (asked) in prereqs once the plan is known.
    // --upgrade from saved state: v0.1.0-v0.2.1 has no `team`, and absent means solo.
    teamChoice: v.team
      ? true
      : v.solo
        ? false
        : v.upgrade && state.name
          ? (state.team ?? false)
          : state.team,
    teamFlag: v.team,
    emailDomainFlag: v["email-domain"] !== undefined,
    team: false,
    noEmail: v["no-email"],
    email: false,
    yesEmailDomain: v["yes-email-domain"],
    yesPaid: v["yes-paid"],
    planFlag: v.plan,
    varFlags: parseVarFlags(v.var),
    signinFlags: parseSigninFlags(v),
    planVar: "free",
    yes: v.yes || v.ci,
    upgrade: v.upgrade,
    check: v.check,
    strict: v.strict,
    newOwnerToken: v["new-owner-token"],
    printToken: v["print-token"],
    allowDowngrade: v["allow-downgrade"],
    // Decided in prereqs: flag, then the plan (Paid only), then saved state.
    browser: false,
    browserFlag: v.browser ? true : v["no-browser"] ? false : undefined,
    interactive,
    json,
    ci: v.ci,
    revokeCi: v["revoke-ci-tokens"],
  };
  // Setup and every --check/--upgrade preflight: refuse a pair the server
  // can't serve (it answers APP_HOST and CONTENT_HOST only).
  if (!v["revoke-ci-tokens"]) {
    const problem = hostPairProblem(opts.appHost, opts.contentHost);
    if (problem) throw new Error(`${problem} (--app-host, --content-host)`);
  }
  // A saved default follows a changed app host; an explicit domain is kept.
  // prereqs keeps it only for a team install.
  const saved =
    state.emailDomain !== `mail.${state.appHost}`
      ? state.emailDomain
      : undefined;
  if (opts.appHost)
    opts.emailDomain = valid(
      "--email-domain",
      v["email-domain"] ?? saved ?? `mail.${opts.appHost}`,
      HOST,
    );
  return opts;
}

/** State fields --check reports: ids and hosts, never secrets. */
const REPORTED = [
  "name",
  "accountId",
  "appHost",
  "contentHost",
  "ownerEmail",
  "d1Id",
  "r2Bucket",
  "kvId",
  "accessAppId",
  "accessClientId",
  "teamDomain",
  "ownerTokenId",
  "browser",
  "plan",
  "planVar",
  "team",
  "email",
  "emailDomain",
  "workerVersion",
  "previousWorkerVersion",
] as const;

/** --check: every step's check(), never apply; the rebuilt state goes in the last line. */
async function checkOnly(
  steps: Step[],
  state: State,
  ctx: Ctx,
  report: (l: Line) => void,
): Promise<number> {
  let todo = false;
  for (const step of steps) {
    ctx.data = ctx.human = undefined;
    ctx.mustRun = false;
    try {
      const r = await step.check(state, ctx);
      if (r === "todo" && (!step.always || ctx.mustRun)) todo = true;
      const notes = ctx.notes.splice(0).join("; ");
      report({
        step: step.name,
        status: r,
        message: notes ? `${r}: ${notes}` : r,
        ...((step.name === "deploy" || step.name === "prereqs") && ctx.data
          ? { data: ctx.data }
          : {}),
      });
    } catch (e) {
      ctx.notes.length = 0;
      const message = (e as Error).message;
      const ar = e instanceof NeedInput;
      report({
        step: step.name,
        status: ar ? "action_required" : "error",
        message,
      });
      return ar ? 2 : 1;
    }
  }
  ctx.data = ctx.human = undefined;
  const data = Object.fromEntries(
    REPORTED.filter((k) => state[k] !== undefined).map((k) => [k, state[k]]),
  );
  if (ctx.sources) Object.assign(data, { sources: ctx.sources });
  report({
    step: "state",
    status: "ok",
    message: "rebuilt from Cloudflare (not written)",
    data,
  });
  return ctx.opts.strict && todo ? 2 : 0;
}

export const HELP = `Usage: pnpm oa:setup [options]
  --name <n>  --app-host <h>  --content-host <h>  --owner-email <e>  --account-id <id>
  --yes  --upgrade  --check [--strict]  --json  --ci [--revoke-ci-tokens]  --new-owner-token  --print-token
  --print-token  Also report the minted owner token as data.token (and in human output).
                Without it setup saves the token to ~/.open-artifacts/<host-slug>-pat-token
                (0600) and reports only data.tokenFile. Not used with --ci, whose token
                is revoked at the end of the run.
  --allow-downgrade  Deploy a checkout older than the deployed version (from /healthz
                version, else saved state). Without it setup stops with action_required
                before the D1 migrations. D1 is not rolled back. --check reports
                {repoVersion, liveVersion, downgrade} on the deploy line.
  --upgrade     With no saved state it needs only --name (plus --account-id when the
                login has several accounts): hosts, owner, plan, team, email domain and
                thumbnails are read from the deployed Worker's plain-text vars and
                bindings (never secrets). Flags win, with a note when they differ; the
                state line and --check report data.sources (worker|flag) per value.
  --token-file <p>  --access-token-file <p>  --analytics-token-file <p>
                Read the deploy (CLOUDFLARE_API_TOKEN), Access (OA_ACCESS_TOKEN) or
                analytics (ANALYTICS_TOKEN) token from a file instead of the env.
                Order: the env var, the flag's file, then ~/.open-artifacts/<name>-
                cloudflare-token, -access-token, -analytics-token, then the usual
                fallback (wrangler login). Refused unless mode 0600 (exit 2); a
                missing flag file is exit 1, an empty or
                multi-line one exit 2; symlinks are refused; POSIX only (WSL on Windows). Never printed or
                stored. --token-links prints the hidden line that saves each one.
  --browser | --no-browser  Server-side thumbnails: the BROWSER binding (Browser Run)
                and SERVER_THUMBNAILS=on. Paid only: on when the plan reads paid, off
                on free; on unknown, saved state decides. --browser forces it on
                (warns on free), --no-browser off. A deploy never drops a live
                BROWSER without --no-browser. --check/--json report browser.
  --solo | --team  "Just you, or a team?" Solo sends no email. Required with --json,
                --yes or --ci when no choice is saved (action_required otherwise).
                Team turns on the email step: invites via Cloudflare Email Sending
                (Workers Paid only) and the send_email binding (EMAIL, EMAIL_FROM).
  --no-email    With --team: omit the send_email binding.
  --email-domain <d>  Sending domain; default mail.<app host>. Onboard it at
                https://dash.cloudflare.com/?to=/:account/email-service/sending
  --yes-email-domain  Accept a sending domain that already has MX/SPF elsewhere.
  --yes-paid    Confirm Workers Paid when setup reads the plan as free or unknown
                (prereqs reads it; without Billing Read it is unknown).
                Saved in state: plan, team, email, emailDomain (--check/--json report them).
  --plan paid|free  The PLAN var the Worker serves (/healthz reports it). Default:
                paid when the plan reads paid or --yes-paid, else free; an unknown
                plan on --upgrade keeps the saved value. A deploy never turns a
                live paid PLAN into free without --plan free. Reported as
                prereqs data.planVar (data.plan is the detected plan).
  --var NAME=value  Keep a tunable Worker var across deploys (repeatable; NAME= clears).
                Names: PUBLIC_HOME (artifact id), EMBED_ORIGINS (https://host[:port],...),
                EMBED_ALLOW_SAME_SITE (1), ANON_WRITES_PER_MIN (1-600),
                DATA_DOC_BYTES, DATA_DAILY_WRITES (> 0).
                EMBED_ALLOW_SAME_SITE=1 lets EMBED_ORIGINS list an origin on the same
                site as the app (for example open-artifacts.com embedding
                demo.open-artifacts.com); needs 0.12 or later. Empty turns it off.
                Precedence: the flag, then saved state (state.vars), then the live
                Worker's value, then the template default. So a value set with --var or
                saved in state wins over a dashboard edit; the dashboard value is kept
                (noted "kept live") only when setup has none. Invalid saved or live
                values are ignored with a note. --check/--json report data.vars.
  --auth-providers <list>  --auth-domains <list>  --auth-domain-join invite|member
  --google-client-id <id>  --turnstile-site-key <key>  --email-code-domain on
  --code-emails-per-day <n>
                Direct sign-in (docs/self-hosting/direct-sign-in.md): the Worker vars
                AUTH_PROVIDERS (access, google, email), AUTH_DOMAINS, AUTH_DOMAIN_JOIN,
                GOOGLE_CLIENT_ID, TURNSTILE_SITE_KEY, EMAIL_CODE_DOMAIN and
                CODE_EMAILS_PER_DAY (1-10000). Without a flag a deploy keeps
                the live Worker's value (an --upgrade in CI included); a flag replaces
                it, and an empty value (--auth-domains "") clears it, so the server
                default applies. --auth-providers access switches back to Access only.
                Refused before deploying: an unknown provider, a malformed domain, a
                join other than invite or member, or google without both
                GOOGLE_CLIENT_ID and AUTH_DOMAINS. A missing GOOGLE_CLIENT_SECRET
                secret only warns. Flags are trimmed (and lowercased, except ids);
                a live value is carried byte for byte, and one the server would read
                differently (padded, wrong case, empty list items, a secret or json
                binding) is refused: fix it with its flag. A Worker whose settings
                can't be read (or come back with no bindings) is never deployed
                (action_required). --check reports data.signin.
  --token-links [--json]  Print each Cloudflare token setup needs (deploy, access,
                analytics) with its permissions and a link that pre-fills the
                dashboard form; account and zone come from --account-id/--app-host
                or saved state. Prereqs also prints the link for a token that is
                missing or lacks a permission.
  --token-page [--no-open] [--json]  Serve the same links as a page on
                127.0.0.1 (random port), print its URL (json: tokenPage.url) and
                open it unless --no-open. Stops on Ctrl-C or after 30 min idle.
  --content-host <h>  With --token-links/--token-page: the zones of both hosts
                are listed (zoneScope) for the zone-scoped tokens.
  --repo <owner/name>  With --token-links/--token-page: store each token as a
                GitHub secret there (gh secret set) instead of an env var.
  --rollback    Roll the Worker back to the version the last deploy replaced
                (state previousWorkerVersion; wrangler rollback), run nothing else,
                and swap the two ids so a second --rollback undoes it. With --json:
                {step:"rollback", status:"ok", data:{from, to}}. No saved previous
                version: exit 2 (roll back in the dashboard: Workers → <name> →
                Deployments). Never touches D1: migrations are additive, so the code
                rolls back and the data stays. Not with --upgrade, --check or --ci.
                Reads the deploy token like setup (env, --token-file, then the
                saved file).
  -h, --help`;

/** Runs setup; resolves to the exit code (0 ok, 2 action_required, 1 error). */
export async function run(
  argv: string[],
  deps: Deps,
  root: string,
  steps: Step[] = STEPS,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.out(HELP);
    return 0;
  }
  if (isTokenCommand(argv)) return tokenCommand(argv, deps, root);
  if (argv.includes("--rollback")) return rollbackCommand(argv, deps, root);
  const ci = argv.includes("--ci");
  const json = argv.includes("--json") || ci;
  let human: string | undefined;
  const report = (l: Line) => {
    const extra = human
      ? `\n${human}`
      : l.data
        ? ` ${JSON.stringify(l.data)}`
        : "";
    let text = json
      ? JSON.stringify(l)
      : `${ICON[l.status]} ${l.step}: ${l.message}${extra}`;
    // Belt and braces: a token echoed by a library or wrangler error never reaches the output.
    for (const k of SECRET_ENV) {
      const t = deps.env[k]?.trim();
      // Short values (test stand-ins) would shred ordinary words.
      if (t && t.length >= 16)
        text = text
          .split(JSON.stringify(t).slice(1, -1))
          .join("[redacted]")
          .split(t)
          .join("[redacted]");
    }
    // --ci: belt and braces, a PAT echoed by a library error never reaches the output.
    deps.out(ci ? text.replace(PAT_RE, "[redacted]") : text);
  };
  const rawFs = deps.fs ?? realFs;
  let fs = rawFs;
  let opts: Opts;
  let state: State;
  let deployed: Deployed | undefined;
  try {
    state = readState(fs, root);
    deps = withTokenFiles(argv, deps, state);
    deployed = await fromWorker(argv, deps, root, state);
    opts = await resolve(argv, deps, state, deployed);
  } catch (e) {
    const ar = e instanceof NeedInput;
    const status = ar ? "action_required" : "error";
    report({ step: "args", status, message: (e as Error).message });
    return ar ? 2 : 1;
  }
  // --ci never writes state.json (an ephemeral runner; ownerTokenId is meaningless once revoked).
  // tempDir and removeTree stay: deploy's OA_CHECK_NO_TEST_HOOKS check needs a
  // scratch dir (v0.35.0's deploy-prod refused without one). hashTree stays
  // off, as before, so --ci never skips a deploy as unchanged.
  if (opts.ci)
    fs = {
      read: rawFs.read,
      write: (p, d) => {
        if (p !== statePath(root)) rawFs.write(p, d);
      },
      tempDir: rawFs.tempDir,
      removeTree: rawFs.removeTree,
    };
  const { name, appHost, contentHost, ownerEmail } = opts;
  const prev = {
    name: state.name,
    appHost: state.appHost,
    accountId: state.accountId,
  };
  Object.assign(state, {
    name,
    appHost,
    contentHost,
    ownerEmail,
  });
  const noState = !prev.name;
  // --check: fetch is GET-only and exec runs only read-only wrangler, for every client.
  if (opts.check) deps = readOnlyDeps(deps);
  const wrangler = makeWrangler(deps, root, () => state.accountId);
  const api = makeApi(deps, wrangler);
  const accessApi = makeApi(deps, wrangler, deps.env.OA_ACCESS_TOKEN);
  const ctx: Ctx = {
    deps,
    noState,
    // --check writes nothing: no state, no rendered config.
    fs: opts.check ? { read: fs.read, write: () => {} } : fs,
    root,
    opts,
    wrangler,
    api,
    accessApi,
    notes: [...(deployed?.notes ?? [])],
    sources: deployed?.sources,
    prev,
  };
  const msg = (fallback: string) => ctx.notes.splice(0).join("; ") || fallback;
  /** Moves the step's data (and human text) out of ctx onto its line. */
  const take = (status: "ok" | "skipped", fallback: string): Line => {
    const { data } = ctx;
    human = ctx.human;
    ctx.data = ctx.human = undefined;
    const l: Line = { step: "", status, message: msg(fallback) };
    return data === undefined ? l : { ...l, data };
  };
  if (opts.revokeCi && !opts.check) {
    try {
      const n = await revokeCiTokens(ctx);
      report({
        step: "revoke-ci-tokens",
        status: "ok",
        message: `revoked ${n} live setup-ci tokens`,
        data: { revoked: n },
      });
      return 0;
    } catch (e) {
      report({
        step: "revoke-ci-tokens",
        status: "error",
        message: `could not revoke setup-ci tokens: ${(e as Error).message}; revoke tokens labelled setup-ci in Settings → Agents`,
      });
      return 1;
    }
  }
  if (opts.check) return checkOnly(steps, state, ctx, report);
  // A refused by-name run must not leave a flag that contradicts the Worker in state.json.
  let refused = false;
  const persist = () => {
    if (refused && deployed)
      for (const k of Object.keys(deployed.live) as (keyof Sources)[])
        if (deployed.sources[k] === "flag") state[k] = deployed.live[k];
    writeState(fs, root, state);
  };
  /** Runs one step and reports it; the exit code when it stopped the run. */
  const runStep = async (step: Step): Promise<number | undefined> => {
    human = ctx.data = ctx.human = undefined;
    ctx.skipped = false;
    try {
      if ((await step.check(state, ctx)) === "done") {
        report(
          step.okWhenDone
            ? { ...take("ok", step.okWhenDone), step: step.name }
            : { ...take("skipped", "already done"), step: step.name },
        );
        return undefined;
      }
      // Check-time notes explain the todo; apply reports its own.
      ctx.notes.length = 0;
      const r = await step.apply(state, ctx);
      if (r) {
        refused = true;
        ctx.notes.length = 0;
        report({ step: step.name, ...r });
        return 2;
      }
      report({
        ...take(ctx.skipped ? "skipped" : "ok", "done"),
        step: step.name,
      });
      return undefined;
    } catch (e) {
      refused = true;
      ctx.notes.length = 0;
      const message = (e as Error).message;
      if (e instanceof NeedInput) {
        report({ step: step.name, status: "action_required", message });
        return 2;
      }
      report({ step: step.name, status: "error", message });
      return (e as { exitCode?: number }).exitCode ?? 1;
    } finally {
      persist();
    }
  };
  const runSteps = async (): Promise<number> => {
    for (const [i, step] of steps.entries()) {
      const code = await runStep(step);
      if (code === undefined) continue;
      // E.g. agent-config still prints after a failed selftest.
      for (const later of steps.slice(i + 1))
        if (later.runAfterFailureOf?.includes(step.name)) await runStep(later);
      return code;
    }
    writeState(fs, root, state);
    if (json) {
      const keys = [
        "plan",
        "planVar",
        "team",
        "email",
        "emailDomain",
        "browser",
      ] as const;
      report({
        step: "state",
        status: "ok",
        message: opts.ci ? "final (not written: --ci)" : "final",
        data: Object.fromEntries([
          ...keys
            .filter((k) => state[k] !== undefined)
            .map((k) => [k, state[k]]),
          ...(ctx.sources ? [["sources", ctx.sources]] : []),
        ]),
      });
    }
    return 0;
  };
  let revokeFailed = false;
  let revoking: Promise<void> | undefined;
  /** Best-effort, guarded: runs at most once, from the end of the run or a signal. */
  const revokeOnce = async () => {
    if (!opts.ci) return;
    if (!revoking && ctx.ciTokenId) {
      const id = ctx.ciTokenId;
      ctx.pat = ctx.ciTokenId = state.ownerTokenId = undefined;
      revoking = (async () => {
        try {
          await revokeToken(ctx, id);
          report({
            step: "revoke-ci-token",
            status: "ok",
            message: `revoked CI owner token ${id}`,
          });
        } catch {
          report({
            step: "revoke-ci-token",
            status: "error",
            message: `could not revoke CI owner token ${id}; action_required: revoke it in Settings → Agents`,
            data: { tokenId: id },
          });
          revokeFailed = true;
        }
      })();
    }
    await revoking;
  };
  const unsub: (() => void)[] = [];
  if (opts.ci) {
    const on =
      deps.onSignal ??
      ((sig, h) => {
        process.on(sig, h);
        return () => void process.off(sig, h);
      });
    for (const [sig, c] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const)
      unsub.push(
        on(sig, () => {
          human = undefined;
          void revokeOnce().finally(() => (deps.exit ?? process.exit)(c));
        }),
      );
  }
  let code = 1;
  try {
    code = await runSteps();
  } finally {
    await revokeOnce();
    for (const u of unsub) u();
  }
  return revokeFailed && code === 0 ? 2 : code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  process.exitCode = await run(process.argv.slice(2), realDeps(), root);
}
