// `pnpm oa:hosted <command> --env staging|prod ...` (P1 Task 8): the hosted
// control plane's laptop CLI. Every command is a thin wrapper over
// @oa/provision (WfpProvisioner, publishRelease, publishFloor,
// turnstileInit); this file holds no provisioning logic of its own.
//
// - Token: the macOS keychain item oa-hosted-<env>, read with
//   `security find-generic-password -w`. CI reads a 0600 file named by
//   OA_HOSTED_TOKEN_FILE. Prod in CI only from the hosted-ops workflow's
//   gated job (GITHUB_ACTIONS=true, GITHUB_REF=refs/heads/main and
//   OA_HOSTED_ENVIRONMENT=hosted-prod-deploy); prod on a laptop never reads a
//   file. The token lives only in this process: never in argv, a file, a
//   child's environment or the output.
// - R2 credentials (publish-release, publish-floor only): the env's R2 API
//   token, keychain item oa-hosted-<env>-r2 holding <accessKeyId>:<secret>;
//   CI uses a 0600 file named by OA_HOSTED_R2_FILE, under the same prod
//   guard. Same rules as the token; both halves are redacted. Publish writes
//   go through R2's S3 API with it, the only endpoint that enforces
//   conditional writes.
// - --ci-owner-token (CI only): create, upgrade, rollback and update-vars
//   run their selftest on an owner PAT labelled ci-<GITHUB_RUN_ID>, minted
//   under the lease, held in memory and revoked before the lease goes;
//   ci-token-sweep revokes and verifies what a crashed run left.
// - Before any write: flag refusals, then the provisioner's own token checks.
// - Audit: a before row and an after row in hosted_audit, with the actor
//   (git config user.email, or the CI run URL).
// - Output: one JSON line per step, redacted; no secret, PAT or key is printed.
import { execFile as execFileCb, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type Cf,
  cfClient,
  type Env,
  googleNewlyEnabled,
  HOSTED_DOMAINS,
  hostedVarProblem,
  isInstallId,
  isReleaseVersion,
  NAMESPACES,
  PlatformDb,
  platformNames,
  probeR2Conditionals,
  publishFloor,
  publishRelease,
  type R2Credentials,
  type R2Releases,
  type ReleaseReader,
  r2ReleaseReader,
  r2S3Client,
  type TurnstileKeys,
  turnstileInit,
  WfpProvisioner,
} from "@oa/provision";
import {
  CredsRefused,
  REDLINE_ENVIRONMENT,
  redlineCreds,
} from "./redline-creds.ts";

export const COMMANDS = [
  "create",
  "upgrade",
  "rollback",
  "update-vars",
  "delete",
  "release-lease",
  "status",
  "publish-release",
  "publish-floor",
  "turnstile-init",
  "redline-creds",
  "owner-token",
  "ci-token-sweep",
] as const;
type Command = (typeof COMMANDS)[number];

export const HELP = `Usage: pnpm oa:hosted <command> --env staging|prod [flags]

Commands:
  create          --slug <s> --owner <email> --to <version> [--var K=V]... [--test-hooks] [--install <id>]
                  --test-hooks: staging only (redline bundle); --install resumes that create
  upgrade         --install <id> --to <version>
  rollback        --install <id>
  update-vars     --install <id> --var K=V... (the full set)
                  create, upgrade, rollback, update-vars: --ci-owner-token (CI only) runs the
                  selftest on an in-memory owner PAT labelled ci-<GITHUB_RUN_ID>, revoked
                  before the lease is released; no PAT file is read or written
  delete          --install <id> --confirm <the same id> [--skip-directory-revoke "<reason>"]
                  waits (up to 10 min) for the scheduler to revoke the Google directory
                  grant; the skip leaves the grant live (revoke it in Google Admin)
  release-lease   --install <id> --confirm <the same id> [--force]
                  --force: release a live lease; only when no operation is running
  status          --install <id>
  publish-release --tag v<version>  (gh release download of oa-release-<env>-*, verified, then uploaded)
  publish-floor   --floor <path to floor-<env>-<seq>.sig.json>
  turnstile-init  (the env's one Turnstile widget; idempotent)
  owner-token     --install <id> --confirm <the same id>  (laptop only)
                  mints a fresh owner PAT into the install's 0600 PAT file, retiring
                  the earlier provision ones; lifecycle operations need that file
  redline-creds   --install <id> --confirm <the same id>  (staging, rl-a or rl-b only)
                  mints the red-line admin PAT, sets it and the hook key in the
                  redline-staging Environment over stdin and in 0600 files under
                  ~/.open-artifacts/redline-capture/secrets, then revokes earlier ones
  ci-token-sweep  --install <id> --run <GitHub run id>
                  revokes every active owner token labelled ci-<run id>, then lists them
                  again; exits 1 unless none remains

Flags:
  --var K=V       repeatable; checked by provision's var allowlist. AUTH_PROVIDERS with
                  google turns the sign-in broker on for the install.
Token: keychain item oa-hosted-<env> (account open-artifacts). CI: a 0600 file at OA_HOSTED_TOKEN_FILE.
R2 (publish-release, publish-floor): keychain item oa-hosted-<env>-r2, <accessKeyId>:<secretAccessKey>. CI: a 0600 file at OA_HOSTED_R2_FILE.
Prod in CI: only with GITHUB_ACTIONS=true, GITHUB_REF=refs/heads/main and OA_HOSTED_ENVIRONMENT=hosted-prod-deploy.
Exit 3: an AUDIT GAP (the after-row failed twice; recorded under ~/.config/oa-hosted/pending-audit).
Env: CLOUDFLARE_ACCOUNT_ID (the hosted account id). Output: one JSON line per step.`;

/** The tenant domain pair per env: provision's table, never a flag. */
export const DOMAINS = HOSTED_DOMAINS;

/** The GitHub repo whose releases publish-release downloads. */
export const REPO = "open-artifacts-ai/open-artifacts";

export const keychainItem = (env: Env) => `oa-hosted-${env}`;
export const turnstileItem = (env: Env) => `oa-hosted-${env}-turnstile`;
/** The env's R2 API token (Object Read & Write on oa-<p>-releases only). */
export const r2Item = (env: Env) => `oa-hosted-${env}-r2`;

export interface FileInfo {
  mode: number;
  uid: number;
  isFile: boolean;
}

export interface OpenedFile {
  /** fstat of the opened fd. */
  info: FileInfo;
  /** Reads that same fd, so a swap of the path after the open is not seen. */
  read: () => Uint8Array;
  close: () => void;
}

/** O_NOFOLLOW: a symlink at `path` fails the open (ELOOP); nothing is read by path. */
export function openNoFollow(path: string): OpenedFile {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    return {
      info: { mode: st.mode, uid: st.uid, isFile: st.isFile() },
      read: () => new Uint8Array(readFileSync(fd)),
      close: () => closeSync(fd),
    };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/**
 * `<dir>/<name>` as a 0600 file of this user (dir 0700, made if missing),
 * opened with O_NOFOLLOW and written through that fd.
 */
export function writePrivateFile(
  dir: string,
  name: string,
  value: string,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const fd = openSync(
    join(dir, name),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Refused(`${name} is not a regular file`);
    fchmodSync(fd, 0o600);
    writeSync(fd, `${value}\n`);
  } finally {
    closeSync(fd);
  }
}

export interface Deps {
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  home: string;
  uid: number;
  /** Runs a tool with no shell; resolves to stdout. `input` goes to stdin. */
  execFile: (
    file: string,
    args: string[],
    o?: { input?: string },
  ) => Promise<string>;
  /** stderr: only the AUDIT GAP line. */
  err: (line: string) => void;
  /** The token file: opened with O_NOFOLLOW, then fstat and read on that fd. */
  openNoFollow: (path: string) => OpenedFile;
  readFile: (path: string) => Uint8Array;
  tempDir: () => string;
  listDir: (dir: string) => string[];
  removeTree: (dir: string) => void;
  cf: (o: { accountId: string; token: string }) => Cf;
  /** The env's releases bucket over R2's S3 API (publish writes). */
  r2: (o: {
    accountId: string;
    env: Env;
    credentials: R2Credentials;
  }) => R2Releases;
  /** Test seam: the release store (R2 in production). */
  release?: (cf: Cf, env: Env) => ReleaseReader;
  /** Test seams for the provisioner (/healthz, clock). */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

class Refused extends Error {}

/** Never a PATH lookup: node_modules/.bin comes first under pnpm. */
const SECURITY = "/usr/bin/security";
/** The account every oa-hosted keychain item carries (reads and writes). */
const KEYCHAIN_ACCOUNT = "open-artifacts";

const PAT_RE = /oa_pat_[1-9A-HJ-NP-Za-km-z]+/g;
const KEY_CHARS = /^[A-Za-z0-9._-]+$/;

interface Flags {
  env: Env;
  install?: string;
  slug?: string;
  owner?: string;
  to?: string;
  confirm?: string;
  tag?: string;
  floor?: string;
  testHooks: boolean;
  force: boolean;
  /** delete only: skip the Google directory revoke, with this reason. */
  skipRevoke?: string;
  vars: Record<string, string>;
  /** CI only: the selftest's owner PAT is ephemeral (ci-<run id>). */
  ciOwnerToken: boolean;
  /** ci-token-sweep: the GitHub run id whose ci-<run id> tokens to revoke. */
  run?: string;
}

/** The commands --ci-owner-token applies to: each runs an MCP selftest. */
export const CI_TOKEN_COMMANDS = [
  "create",
  "upgrade",
  "rollback",
  "update-vars",
] as const;

const RUN_ID = /^[1-9][0-9]{0,19}$/;

/** Every refusal that needs no call: exits 1 before the token is read. */
function parse(argv: string[]): { cmd: Command; f: Flags } {
  let p: ReturnType<typeof parseArgs>;
  try {
    p = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        env: { type: "string" },
        install: { type: "string" },
        slug: { type: "string" },
        owner: { type: "string" },
        to: { type: "string" },
        confirm: { type: "string" },
        tag: { type: "string" },
        floor: { type: "string" },
        "test-hooks": { type: "boolean" },
        force: { type: "boolean" },
        "skip-directory-revoke": { type: "string" },
        var: { type: "string", multiple: true },
        "ci-owner-token": { type: "boolean" },
        run: { type: "string" },
      },
    });
  } catch (e) {
    throw new Refused((e as Error).message);
  }
  const v = p.values as Record<string, unknown>;
  const cmd = p.positionals[0] as Command;
  if (p.positionals.length !== 1 || !COMMANDS.includes(cmd))
    throw new Refused(`usage: oa:hosted <${COMMANDS.join("|")}> --env <env>`);
  const env = v.env;
  if (env !== "staging" && env !== "prod")
    throw new Refused("--env must be staging or prod");
  const testHooks = v["test-hooks"] === true;
  if (testHooks && env === "prod")
    throw new Refused("--test-hooks is refused with --env prod");
  if (testHooks && cmd !== "create")
    throw new Refused("--test-hooks is for create only");
  const vars: Record<string, string> = {};
  for (const kv of (v.var as string[] | undefined) ?? []) {
    const i = kv.indexOf("=");
    const k = i > 0 ? kv.slice(0, i) : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(k))
      throw new Refused("--var must be NAME=value with an uppercase NAME");
    if (Object.hasOwn(vars, k)) throw new Refused(`--var ${k} given twice`);
    const val = kv.slice(i + 1);
    const why = hostedVarProblem(k, val);
    if (why) throw new Refused(`--var: ${why}`);
    vars[k] = val;
  }
  const f: Flags = {
    env,
    install: v.install as string | undefined,
    slug: v.slug as string | undefined,
    owner: v.owner as string | undefined,
    to: v.to as string | undefined,
    confirm: v.confirm as string | undefined,
    tag: v.tag as string | undefined,
    floor: v.floor as string | undefined,
    testHooks,
    force: v.force === true,
    skipRevoke: v["skip-directory-revoke"] as string | undefined,
    vars,
    ciOwnerToken: v["ci-owner-token"] === true,
    run: v.run as string | undefined,
  };
  const need = (k: keyof Flags, flag: string) => {
    if (typeof f[k] !== "string" || f[k] === "")
      throw new Refused(`${cmd} needs --${flag}`);
  };
  const byInstall = [
    "upgrade",
    "rollback",
    "update-vars",
    "delete",
    "release-lease",
    "status",
    "redline-creds",
    "owner-token",
    "ci-token-sweep",
  ];
  if (byInstall.includes(cmd)) need("install", "install");
  else if (cmd !== "create" && f.install !== undefined)
    throw new Refused(`${cmd} takes no --install`);
  if (f.install !== undefined && !isInstallId(f.install))
    throw new Refused("--install is not an install id");
  if (cmd === "create") {
    need("slug", "slug");
    need("owner", "owner");
    need("to", "to");
  }
  if (cmd === "upgrade") need("to", "to");
  if (f.to !== undefined && !isReleaseVersion(f.to))
    throw new Refused("--to is not a release version");
  if (cmd === "redline-creds" && env !== "staging")
    throw new Refused("redline-creds is for --env staging only");
  if (
    cmd === "delete" ||
    cmd === "release-lease" ||
    cmd === "redline-creds" ||
    cmd === "owner-token"
  ) {
    if (f.confirm !== f.install)
      throw new Refused(
        `${cmd} needs --confirm to be exactly the install id (--install)`,
      );
  }
  if (f.force && cmd !== "release-lease")
    throw new Refused("--force is for release-lease only");
  if (f.skipRevoke !== undefined) {
    if (cmd !== "delete")
      throw new Refused("--skip-directory-revoke is for delete only");
    if (f.skipRevoke.trim() === "")
      throw new Refused(
        '--skip-directory-revoke needs a reason: --skip-directory-revoke "<reason>"',
      );
  }
  if (cmd === "update-vars" && Object.keys(vars).length === 0)
    throw new Refused("update-vars needs the full set of --var NAME=value");
  if (cmd === "publish-release") {
    need("tag", "tag");
    if (!/^v\d+\.\d+\.\d+$/.test(f.tag as string))
      throw new Refused("--tag must be a release tag like v1.2.3");
  }
  if (cmd === "publish-floor") need("floor", "floor");
  if (
    f.ciOwnerToken &&
    !(CI_TOKEN_COMMANDS as readonly string[]).includes(cmd)
  )
    throw new Refused(
      `--ci-owner-token is for ${CI_TOKEN_COMMANDS.join(", ")} only`,
    );
  if (cmd === "ci-token-sweep") {
    need("run", "run");
    if (!RUN_ID.test(f.run as string))
      throw new Refused("--run must be a GitHub run id");
  } else if (f.run !== undefined)
    throw new Refused("--run is for ci-token-sweep only");
  return { cmd, f };
}

const inCi = (env: Deps["env"]) =>
  env.CI === "true" || env.GITHUB_ACTIONS === "true";

/** The Environment the hosted-ops workflow runs prod in (main only, reviewer-gated). */
export const PROD_CI_ENVIRONMENT = "hosted-prod-deploy";

/**
 * Prod in CI: only a GitHub Actions job on main in the hosted-prod-deploy
 * Environment (the workflow sets OA_HOSTED_ENVIRONMENT from the same
 * expression that picks the Environment). GitHub's Environment protection is
 * the real gate; this stops a misconfigured workflow from reaching prod.
 */
const prodCiAllowed = (env: Deps["env"]) =>
  env.GITHUB_ACTIONS === "true" &&
  env.GITHUB_REF === "refs/heads/main" &&
  env.OA_HOSTED_ENVIRONMENT === PROD_CI_ENVIRONMENT;

/**
 * A secret from the only source `env` allows: the keychain item `item`, or
 * (CI) a 0600 file of this user named by `$fileVar`, opened with O_NOFOLLOW
 * and read through that fd. Prod on a laptop reads only the keychain; prod in
 * CI only under prodCiAllowed, and then only the file.
 */
async function readSecret(
  d: Deps,
  env: Env,
  fileVar: "OA_HOSTED_TOKEN_FILE" | "OA_HOSTED_R2_FILE",
  item: string,
  what: string,
): Promise<string> {
  const file = d.env[fileVar];
  if (env === "prod") {
    if (inCi(d.env)) {
      if (!prodCiAllowed(d.env))
        throw new Refused("CI is staging only; prod refused");
    } else if (file !== undefined)
      throw new Refused(
        `prod reads its ${what} only from the keychain; unset ${fileVar}`,
      );
  }
  if (file !== undefined) return readPrivateFile(d, file, fileVar);
  if (inCi(d.env)) throw new Refused(`CI has no keychain; set ${fileVar}`);
  try {
    return (
      await d.execFile(SECURITY, [
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        item,
        "-w",
      ])
    ).trim();
  } catch {
    throw new Refused(`keychain item ${item} not found`);
  }
}

/**
 * A 0600 regular file of this user, opened with O_NOFOLLOW and read through
 * that fd; `what` names it in a refusal (never its contents).
 */
function readPrivateFile(d: Deps, path: string, what: string): string {
  let o: OpenedFile;
  try {
    o = d.openNoFollow(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new Refused(
      code === "ELOOP"
        ? `${what} is a symlink`
        : `${what} can't be opened (${code ?? "error"})`,
    );
  }
  try {
    const st = o.info;
    if (!st.isFile) throw new Refused(`${what} is not a regular file`);
    if ((st.mode & 0o777) !== 0o600)
      throw new Refused(`${what} must be mode 0600`);
    if (st.uid !== d.uid)
      throw new Refused(`${what} must be owned by this user`);
    return new TextDecoder().decode(o.read()).trim();
  } finally {
    o.close();
  }
}

/** The env's provisioning token, from the only source that env allows. */
async function readToken(d: Deps, env: Env): Promise<string> {
  const token = await readSecret(
    d,
    env,
    "OA_HOSTED_TOKEN_FILE",
    keychainItem(env),
    "token",
  );
  if (!token || /\s/.test(token))
    throw new Refused("the token is empty or has whitespace in it");
  return token;
}

const R2_HALF = /^[A-Za-z0-9]{16,128}$/;

/**
 * The env's R2 API token as S3 credentials: oa-hosted-<env>-r2 (or
 * OA_HOSTED_R2_FILE in staging CI) holding <accessKeyId>:<secretAccessKey>.
 * The item name is env-specific, so another env's item is never read.
 */
async function readR2(d: Deps, env: Env): Promise<R2Credentials> {
  const raw = await readSecret(
    d,
    env,
    "OA_HOSTED_R2_FILE",
    r2Item(env),
    "R2 credentials",
  );
  const i = raw.indexOf(":");
  const accessKeyId = raw.slice(0, i);
  const secretAccessKey = raw.slice(i + 1);
  if (i < 1 || !R2_HALF.test(accessKeyId) || !R2_HALF.test(secretAccessKey))
    throw new Refused(
      `the R2 credentials (${r2Item(env)}) are not <accessKeyId>:<secretAccessKey>`,
    );
  return { accessKeyId, secretAccessKey };
}

async function readTurnstile(d: Deps, env: Env): Promise<TurnstileKeys | null> {
  if (inCi(d.env)) return null;
  let raw: string;
  try {
    raw = (
      await d.execFile(SECURITY, [
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        turnstileItem(env),
        "-w",
      ])
    ).trim();
  } catch {
    return null;
  }
  const i = raw.indexOf(":");
  const sitekey = raw.slice(0, i);
  const secret = raw.slice(i + 1);
  if (i < 1 || !KEY_CHARS.test(sitekey) || !KEY_CHARS.test(secret))
    throw new Refused(
      `keychain item ${turnstileItem(env)} is not <sitekey>:<secret>`,
    );
  return { sitekey, secret };
}

/** Written through `security -i` on stdin, so the secret is never in argv. */
async function writeTurnstile(d: Deps, env: Env, k: TurnstileKeys) {
  if (!KEY_CHARS.test(k.sitekey) || !KEY_CHARS.test(k.secret))
    throw new Error("the Turnstile keys have unexpected characters");
  await d.execFile(SECURITY, ["-i"], {
    input: `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${turnstileItem(env)} -w ${k.sitekey}:${k.secret}\n`,
  });
  // `security -i` can exit 0 when the command inside it failed (a locked
  // keychain, a denied prompt): read the item back.
  const back = await readTurnstile(d, env);
  if (back?.sitekey !== k.sitekey || back.secret !== k.secret)
    throw new Error(
      `keychain item ${turnstileItem(env)} did not store; unlock the keychain and rerun`,
    );
}

async function actorOf(d: Deps): Promise<string> {
  if (inCi(d.env)) {
    const {
      GITHUB_SERVER_URL: s,
      GITHUB_REPOSITORY: r,
      GITHUB_RUN_ID: id,
    } = d.env;
    if (!s || !r || !id) throw new Refused("CI run URL is not known");
    return `${s}/${r}/actions/runs/${id}`;
  }
  let email = "";
  try {
    email = (await d.execFile("git", ["config", "user.email"])).trim();
  } catch {}
  if (!email) throw new Refused("set git config user.email (the audit actor)");
  return email;
}

export async function main(argv: string[], d: Deps): Promise<number> {
  const secrets: string[] = [];
  const emit = (line: Record<string, unknown>) => {
    let s = JSON.stringify(line).replace(PAT_RE, "[redacted]");
    for (const x of secrets)
      if (x)
        s = s
          .split(x)
          .join("[redacted]")
          .split(JSON.stringify(x).slice(1, -1))
          .join("[redacted]");
    d.out(s);
  };
  const fail = (step: string, e: unknown) => {
    emit({
      step,
      status: "error",
      error: (e as Error)?.name ?? "Error",
      message: String((e as Error)?.message ?? e),
    });
    return 1;
  };

  if (argv.includes("--help") || argv.includes("-h")) {
    d.out(HELP);
    return 0;
  }
  let cmd: Command;
  let f: Flags;
  try {
    ({ cmd, f } = parse(argv));
  } catch (e) {
    return fail("args", e);
  }
  const env = f.env;
  let ciLabel: string | undefined;
  if (f.ciOwnerToken) {
    const runId = d.env.GITHUB_RUN_ID ?? "";
    if (!inCi(d.env) || !RUN_ID.test(runId))
      return fail(
        "args",
        new Refused("--ci-owner-token runs in CI only (with GITHUB_RUN_ID)"),
      );
    ciLabel = `ci-${runId}`;
  }

  let cf: Cf;
  let r2: R2Releases | undefined;
  let actor: string;
  let turnstile: TurnstileKeys | null = null;
  try {
    const token = await readToken(d, env);
    secrets.push(token);
    actor = await actorOf(d);
    const accountId = d.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    if (!/^[0-9a-f]{32}$/.test(accountId))
      throw new Refused("set CLOUDFLARE_ACCOUNT_ID to the hosted account id");
    cf = d.cf({ accountId, token });
    if (cmd === "publish-release" || cmd === "publish-floor") {
      const credentials = await readR2(d, env);
      secrets.push(credentials.accessKeyId, credentials.secretAccessKey);
      r2 = d.r2({ accountId, env, credentials });
    }
    // Every command that renders an install's vars: codes on needs the pair.
    if (["create", "update-vars", "upgrade", "rollback"].includes(cmd))
      turnstile = await readTurnstile(d, env);
    if (turnstile) secrets.push(turnstile.secret);
  } catch (e) {
    return fail("token", e);
  }

  const mk = (brokerEnabled: boolean) =>
    new WfpProvisioner({
      cf,
      env,
      target: { kind: "namespace", ns: NAMESPACES[env] },
      domains: DOMAINS[env],
      release: (d.release ?? r2ReleaseReader)(cf, env),
      ...(turnstile ? { turnstile } : {}),
      patDir: join(d.home, ".open-artifacts", `hosted-${env}`),
      ...(ciLabel ? { ciOwnerToken: { label: ciLabel } } : {}),
      brokerEnabled,
      // Health must come from this install, not just any install that
      // answers on its host (review item 43). Every hosted release reports
      // installId in /healthz.
      requireInstallId: true,
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(d.now ? { now: d.now } : {}),
      ...(d.sleep ? { sleep: d.sleep } : {}),
    });
  let prov = mk(false);
  const notes = () => {
    for (const n of prov.notes.splice(0))
      emit({ step: "note", status: "ok", message: n });
  };

  // The provisioner's token checks, before this CLI's first write. Recovery
  // commands run near expiry with a warning, as the provisioner allows.
  const recovery = [
    "rollback",
    "delete",
    "release-lease",
    "status",
    "ci-token-sweep",
  ];
  try {
    await prov.verifyToken(recovery.includes(cmd) ? "warn" : "refuse");
    notes();
    emit({ step: "token", status: "ok", message: `${env} token verified` });
  } catch (e) {
    return fail("token", e);
  }

  let audit: PlatformDb;
  let startedAt = 0;
  const subject = f.install ?? "-";
  try {
    const db = platformNames(env).db;
    const id = await cf.d1Get(db);
    if (!id) throw new Refused(`platform D1 ${db} not found`);
    audit = new PlatformDb(cf, { id, name: db }, env, d.now ?? Date.now);
    startedAt = (d.now ?? Date.now)();
    await recoverGaps(d, env, subject, audit, emit);
    await audit.auditAs(actor, subject, `cli.${cmd}.start`, { cmd });
    emit({ step: "audit", status: "ok", message: "before row written" });
  } catch (e) {
    return fail("audit", e);
  }

  let code = 0;
  let after = subject;
  try {
    notes();
    prov = mk(await brokerOn(cmd, f, audit));
    const r = await run(cmd, f, d, {
      cf,
      r2,
      env,
      prov,
      emit,
      db: audit,
      hide: (x) => secrets.push(x),
    });
    notes();
    if (r.id) after = r.id;
    code = r.ok ? 0 : 1;
    emit({ step: cmd, status: r.ok ? "ok" : "error", data: r.data });
  } catch (e) {
    notes();
    code = fail(cmd, e);
    // A create that failed after minting its id: the after row names it,
    // but only a row this run made (L8: never another install on the slug).
    if (cmd === "create" && after === "-") {
      const row = await audit.bySlug(f.slug as string).catch(() => undefined);
      if (row && (row.created_at ?? 0) >= startedAt) after = row.id;
    }
  }
  // The workflow's always() sweep needs the install a CI token was minted
  // in; a create learns it only here.
  if (ciLabel && after !== "-")
    emit({ step: "ci-owner-token", status: "ok", install: after });
  const action = `cli.${cmd}.${code === 0 ? "done" : "failed"}`;
  const write = () => audit.auditAs(actor, after, action, { cmd, exit: code });
  try {
    await write().catch(write);
    emit({ step: "audit", status: "ok", message: "after row written" });
  } catch (e) {
    fail("audit", e);
    d.err(`AUDIT GAP: ${cmd} ${after} took effect, after-row not written`);
    recordGap(d, { env, install: after, action, cmd, exit: code, actor });
    return AUDIT_GAP_EXIT;
  }
  return code;
}

/** Exit code of a command whose after-row could not be written. */
export const AUDIT_GAP_EXIT = 3;

interface Gap {
  env: Env;
  install: string;
  action: string;
  cmd: string;
  exit: number;
  actor: string;
  at?: number;
}

/**
 * Audit gaps (an after-row that failed twice): one 0600 JSON file each under
 * ~/.config/oa-hosted/pending-audit (0700), named <env>-<install>-<at>.json.
 * No secret: env, install id, action, command, exit code and actor only.
 */
const gapDir = (d: Deps) =>
  join(d.home, ".config", "oa-hosted", "pending-audit");

function recordGap(d: Deps, g: Gap): void {
  try {
    const dir = gapDir(d);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const at = (d.now ?? Date.now)();
    writeFileSync(
      join(dir, `${g.env}-${g.install}-${at}.json`),
      JSON.stringify({ ...g, at }),
      { mode: 0o600, flag: "wx" },
    );
  } catch {
    d.err("AUDIT GAP: could not record it locally either; add the row by hand");
  }
}

/** Before a command's own start row: the after-rows its install still owes. */
async function recoverGaps(
  d: Deps,
  env: Env,
  install: string,
  audit: PlatformDb,
  emit: (l: Record<string, unknown>) => void,
): Promise<void> {
  const dir = gapDir(d);
  if (!existsSync(dir)) return;
  const prefix = `${env}-${install}-`;
  for (const f of readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .sort()) {
    const g = JSON.parse(readFileSync(join(dir, f), "utf8")) as Gap;
    if (g.env !== env || g.install !== install) continue;
    await audit.auditAs(g.actor, g.install, g.action, {
      cmd: g.cmd,
      exit: g.exit,
      recovered: 1,
      at: g.at ?? 0,
    });
    rmSync(join(dir, f), { force: true });
    emit({ step: "audit", status: "ok", message: `recovered ${g.action}` });
  }
}

/**
 * The broker (P2) is on for an install whose vars turn google on: hosted
 * Google sign-in works only once the install is in the broker registry.
 * Provision then needs both registry KVs and derives the origin from the
 * app host. create renders --var; update-vars renders --var and may be
 * turning google off on an install that had it; the rest read the row.
 */
async function brokerOn(
  cmd: Command,
  f: Flags,
  db: PlatformDb,
): Promise<boolean> {
  const google = (v: Record<string, string>) => googleNewlyEnabled({}, v);
  if (cmd === "create") return google(f.vars);
  if (!f.install) return false;
  if (cmd === "update-vars" && google(f.vars)) return true;
  const row = await db.byId(f.install);
  return row?.vars ? google(JSON.parse(row.vars)) : false;
}

async function run(
  cmd: Command,
  f: Flags,
  d: Deps,
  c: {
    cf: Cf;
    r2: R2Releases | undefined;
    env: Env;
    prov: WfpProvisioner;
    emit: (l: Record<string, unknown>) => void;
    db: PlatformDb;
    hide: (value: string) => void;
  },
): Promise<{ ok: boolean; id?: string; data: unknown }> {
  const { cf, env, prov } = c;
  const s3 = () => {
    if (!c.r2) throw new Refused("no R2 credentials were read");
    return c.r2;
  };
  const id = f.install as string;
  switch (cmd) {
    case "create": {
      const inst = await prov.create({
        slug: f.slug as string,
        ownerEmail: f.owner as string,
        plan: "paid",
        vars: f.vars,
        testHooks: f.testHooks,
        bundle: f.testHooks ? "redline" : "release",
        version: f.to as string,
        ...(f.install ? { resumeId: f.install } : {}),
      });
      return { ok: true, id: inst.id, data: inst };
    }
    case "upgrade": {
      const r = await prov.upgrade(id, f.to as string);
      return { ok: r.ok, data: r };
    }
    case "rollback": {
      const r = await prov.rollback(id);
      return { ok: r.ok, data: r };
    }
    case "update-vars": {
      const r = await prov.updateVars(id, f.vars);
      return { ok: r.ok, data: r };
    }
    case "delete": {
      // H-DV: provision waits for the scheduler to revoke the install's
      // Google directory grant (or skips it with a reason), then tears down.
      // Progress: one line per poll, at most every 60 s.
      let last = Number.NEGATIVE_INFINITY;
      const r = await prov.delete(id, f.confirm as string, {
        ...(f.skipRevoke !== undefined
          ? { skipDirectoryRevoke: f.skipRevoke }
          : {}),
        onPoll: (p) => {
          if (p.waitedMs - last < 60_000) return;
          last = p.waitedMs;
          c.emit({ step: "directory-revoke", status: "ok", data: p });
        },
      });
      return { ok: true, data: r };
    }
    case "release-lease": {
      const r = await prov.releaseLease(id, f.confirm as string, {
        force: f.force,
      });
      return { ok: true, data: r };
    }
    case "status":
      return { ok: true, data: await prov.status(id) };
    case "ci-token-sweep":
      return {
        ok: true,
        data: await prov.ciTokenSweep(id, `ci-${f.run as string}`),
      };
    case "owner-token": {
      if (inCi(d.env)) throw new Refused("owner-token runs on a laptop only");
      return {
        ok: true,
        id,
        data: await prov.reissueOwnerToken(id, f.confirm as string),
      };
    }
    case "redline-creds": {
      if (inCi(d.env)) throw new Refused("redline-creds runs on a laptop only");
      try {
        const r = await redlineCreds(id, await c.db.byId(id), {
          fetch: d.fetch ?? fetch,
          readHookKey: (p) => readPrivateFile(d, p, "the hook key file"),
          setSecret: async (name, value) => {
            await d.execFile(
              "gh",
              ["secret", "set", name, "--env", REDLINE_ENVIRONMENT, "-R", REPO],
              { input: value },
            );
          },
          writeLocal: writePrivateFile,
          hide: c.hide,
          home: d.home,
          now: (d.now ?? Date.now)(),
        });
        return { ok: true, id, data: r };
      } catch (e) {
        if (e instanceof CredsRefused) throw new Refused(e.message);
        throw e;
      }
    }
    case "turnstile-init": {
      if (inCi(d.env))
        throw new Refused("turnstile-init runs on a laptop only");
      const r = await turnstileInit({
        cf,
        env,
        store: {
          read: () => readTurnstile(d, env),
          write: (k) => writeTurnstile(d, env, k),
        },
        ...(d.sleep ? { sleep: d.sleep } : {}),
      });
      return { ok: true, data: r };
    }
    case "publish-floor": {
      const r2 = s3();
      await probeR2Conditionals(r2, env);
      const floor = d.readFile(f.floor as string);
      const r = await publishFloor({ r2, env, floor });
      return { ok: true, data: r };
    }
    case "publish-release": {
      const tag = f.tag as string;
      const version = tag.slice(1);
      const dir = d.tempDir();
      try {
        await d.execFile("gh", [
          "release",
          "download",
          tag,
          "--repo",
          REPO,
          "--pattern",
          `oa-release-${env}-*`,
          "--dir",
          dir,
        ]);
        const have = new Set(d.listDir(dir));
        const variants = (["release", "redline"] as const).filter((v) =>
          have.has(`oa-release-${env}-${v}-${version}.tar`),
        );
        if (variants.length === 0)
          throw new Refused(`release ${tag} has no ${env} tar`);
        const r2 = s3();
        await probeR2Conditionals(r2, env);
        const out = [];
        for (const v of variants) {
          const base = join(dir, `oa-release-${env}-${v}-${version}`);
          if (!have.has(`oa-release-${env}-${v}-${version}.sig.json`))
            throw new Refused(`release ${tag}: ${v} has no .sig.json`);
          const r = await publishRelease({
            cf,
            r2,
            env,
            version,
            files: {
              tar: d.readFile(`${base}.tar`),
              sig: d.readFile(`${base}.sig.json`),
            },
          });
          c.emit({
            step: "publish",
            status: "ok",
            data: { variant: r.variant, objects: r.keys.length },
          });
          out.push({ variant: r.variant, objects: r.keys.length });
        }
        return { ok: true, data: { version, published: out } };
      } finally {
        d.removeTree(dir);
      }
    }
  }
}

export function realDeps(): Deps {
  return {
    out: (l) => process.stdout.write(`${l}\n`),
    env: process.env,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    execFile: (file, args, o) =>
      new Promise((resolve, reject) => {
        if (o?.input === undefined) {
          execFileCb(file, args, { maxBuffer: 1 << 20 }, (e, stdout) =>
            e
              ? reject(new Error(`${file} exited ${e.code ?? "?"}`))
              : resolve(stdout),
          );
          return;
        }
        const p = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
        let stdout = "";
        p.stdout.on("data", (b) => {
          stdout += b;
        });
        p.on("error", reject);
        p.on("close", (code) =>
          code === 0
            ? resolve(stdout)
            : reject(new Error(`${file} exited ${code}`)),
        );
        p.stdin.end(o.input);
      }),
    err: (l) => process.stderr.write(`${l}\n`),
    openNoFollow,
    readFile: (p) => new Uint8Array(readFileSync(p)),
    tempDir: () => mkdtempSync(join(tmpdir(), "oa-hosted-")),
    listDir: (dir) => readdirSync(dir),
    removeTree: (dir) => rmSync(dir, { recursive: true, force: true }),
    cf: (o) => cfClient(o),
    r2: (o) => r2S3Client(o),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), realDeps());
}
