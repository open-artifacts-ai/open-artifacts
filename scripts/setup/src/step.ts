import type { Sources } from "./by-name.ts";
import type { Api, Deps, Fs, Wrangler } from "./cf.ts";
import type { Signin } from "./signin.ts";
import type { State } from "./state.ts";
import type { VersionInfo } from "./version-guard.ts";

export type Opts = {
  name: string;
  appHost: string;
  contentHost: string;
  ownerEmail: string;
  accountId?: string;
  yes: boolean;
  upgrade: boolean;
  /** Read-only: run every check(), never apply, write nothing. */
  check: boolean;
  /** With --check: exit 2 when a step (other than an `always` one) is todo. */
  strict: boolean;
  newOwnerToken: boolean;
  /** --allow-downgrade: deploy a checkout older than the deployed version. */
  allowDowngrade: boolean;
  /** Render BROWSER + SERVER_THUMBNAILS (Paid only): decided by prereqs from browserFlag, the plan, then state. */
  browser: boolean;
  /** --browser (true) or --no-browser (false). */
  browserFlag?: boolean;
  /** --team/--solo, else saved state; undefined: prereqs asks (or defaults to solo). */
  teamChoice?: boolean;
  /** --team was passed. */
  teamFlag: boolean;
  /** Team install, decided by prereqs: turns the email step on. */
  team: boolean;
  /** --no-email. */
  noEmail: boolean;
  /** Render the send_email binding and EMAIL_FROM: team, not --no-email, and Paid (detected, --yes-paid, or saved). */
  email: boolean;
  /** The Email Sending domain: --email-domain, saved state, else mail.<app host>. */
  emailDomain?: string;
  /** --email-domain was passed this run (an apex is never reused from state). */
  emailDomainFlag: boolean;
  /** --yes-email-domain: accept a domain with existing mail records non-interactively. */
  yesEmailDomain: boolean;
  /** --yes-paid: the account is on Workers Paid though setup read free or unknown. */
  yesPaid: boolean;
  /** --plan paid|free: the PLAN var to render, overriding detection. */
  planFlag?: "free" | "paid";
  /** The PLAN var rendered into the Worker config, decided by prereqs; saved to state only after a successful deploy. */
  planVar: "free" | "paid";
  /** --var NAME=value flags, validated. */
  varFlags: Record<string, string>;
  /** --auth-providers, --auth-domains, ...: the direct sign-in vars given this run ("" clears). */
  signinFlags: Partial<Signin>;
  /** False under --yes or --json: never prompt. */
  interactive: boolean;
  json: boolean;
  /** --print-token: report the minted token in data.token (otherwise only data.tokenFile). */
  printToken: boolean;
  /** CI mode: implies --json; the owner token lives in memory only and is revoked at the end. */
  ci: boolean;
  /** With --ci: revoke every live setup-ci token of the owner and exit. */
  revokeCi: boolean;
};
export type Ctx = {
  deps: Deps;
  fs: Fs;
  root: string;
  opts: Opts;
  api: Api;
  /** Access API client: OA_ACCESS_TOKEN, else the wrangler token. */
  accessApi: Api;
  wrangler: Wrangler;
  /** Notes appended to the current step's reported message. */
  notes: string[];
  /** `data` for the current step's line; `human` replaces it in human output. */
  data?: unknown;
  human?: string;
  /** Set by a step's apply: it had nothing to do, so its line is `skipped`, not `ok`. */
  skipped?: boolean;
  /** The PAT minted this run, in memory only. */
  pat?: string;
  /** Under --ci: the minted token's row id, revoked at the end of the run. */
  ciTokenId?: string;
  /** The welcome artifact's view URL, when selftest published it this run. */
  welcomeUrl?: string;
  /** The tunable vars to render (flag, state, live), settled by the deploy step. */
  tunables?: Record<string, string>;
  /** The direct sign-in vars to render (flag, then live), settled by the deploy step. */
  signin?: Signin;
  /** Where appHost, contentHost and ownerEmail came from (upgrade by name only). */
  sources?: Sources;
  /** Set by prereqs: this checkout against the deployed version. */
  version?: VersionInfo;
  /** Set by an `always` step's check: its todo counts for --strict this run. */
  mustRun?: boolean;
  /** No saved state: it is being rebuilt from Cloudflare by name. */
  noState?: boolean;
  /** Saved state as loaded, before this run's flags were applied. */
  prev?: { name?: string; appHost?: string; accountId?: string };
};

/** Missing input where prompting isn't allowed (--json): reported as action_required, exit 2. */
export class NeedInput extends Error {}
export type ActionRequired = {
  status: "action_required";
  message: string;
  data?: unknown;
};
export type Step = {
  name: string;
  /** Runs on every setup (deploy, selftest): its todo is not drift, --strict ignores it. */
  always?: boolean;
  /** A step that only verifies: reports `ok` with this message (not `skipped`) when its check is done. */
  okWhenDone?: string;
  /** Still runs (and prints) when one of these steps failed; the run keeps the failure's exit code. */
  runAfterFailureOf?: string[];
  check: (state: State, ctx: Ctx) => Promise<"done" | "todo">;
  apply: (state: State, ctx: Ctx) => Promise<ActionRequired | undefined>;
};
