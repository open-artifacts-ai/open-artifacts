// `pnpm oa:hosted <command> --env staging|prod ...` (P1 Task 8): the hosted
// control plane's CLI, read-only plus the two release publishes. Install
// writes go through the Provisioning API (design 10.1, W9b retired them
// here). Every command is a thin wrapper over @oa/provision (WfpProvisioner,
// publishRelease, publishFloor); this file holds no provisioning logic.
//
// - Token: the macOS keychain item oa-hosted-<env>, read with
//   `security find-generic-password -w`. CI reads a 0600 file named by
//   OA_HOSTED_TOKEN_FILE. Prod in CI only from the hosted-publish workflow's
//   gated job (GITHUB_ACTIONS=true, GITHUB_REF=refs/heads/main and
//   OA_HOSTED_ENVIRONMENT=hosted-prod-deploy); prod on a laptop never reads a
//   file. The token lives only in this process: never in argv, a file, a
//   child's environment or the output.
// - R2 credentials (publish-release, publish-floor only): the env's R2 API
//   token, keychain item oa-hosted-<env>-r2 holding <accessKeyId>:<secret>;
//   CI uses a 0600 file named by OA_HOSTED_R2_FILE (derived from the
//   Environment's CLOUDFLARE_API_TOKEN), under the same prod guard. Same
//   rules as the token; both halves are redacted. Publish writes go through
//   R2's S3 API with it, the only endpoint that enforces conditional writes.
// - Audit: a before row and an after row in hosted_audit, with the actor
//   (git config user.email, or the CI run URL).
// - Output: one JSON line per step, redacted; no secret, PAT or key is printed.
import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  isInstallId,
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
  WfpProvisioner,
} from "@oa/provision";

/** Retired by W9b (design 10.1): install writes are the Provisioning API's. */
export const RETIRED_COMMANDS = [
  "create",
  "upgrade",
  "rollback",
  "update-vars",
  "delete",
  "release-lease",
  "owner-token",
  "turnstile-init",
  "ci-token-sweep",
  "signup-redrive",
  "redline-creds",
] as const;

export const COMMANDS = ["status", "publish-release", "publish-floor"] as const;
type Command = (typeof COMMANDS)[number];

export const HELP = `Usage: pnpm oa:hosted <command> --env staging|prod [flags]

Commands:
  status          --install <id>  (read-only)
  publish-release --tag v<version>  (gh release download of oa-release-<env>-*, verified, then uploaded)
  publish-floor   --floor <path to floor-<env>-<seq>.sig.json>

Install writes (create, upgrade, rollback, update-vars, delete, release-lease,
owner tokens, red-line creds) go through the Provisioning API.
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

export interface Deps {
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  home: string;
  uid: number;
  /** Runs a tool with no shell; resolves to stdout. */
  execFile: (file: string, args: string[]) => Promise<string>;
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
/** The account every oa-hosted keychain item carries. */
const KEYCHAIN_ACCOUNT = "open-artifacts";

const PAT_RE = /oa_pat_[1-9A-HJ-NP-Za-km-z]+/g;

interface Flags {
  env: Env;
  install?: string;
  tag?: string;
  floor?: string;
}

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
        tag: { type: "string" },
        floor: { type: "string" },
      },
    });
  } catch (e) {
    throw new Refused((e as Error).message);
  }
  const v = p.values as Record<string, unknown>;
  const cmd = p.positionals[0] as Command;
  if (
    p.positionals.length === 1 &&
    (RETIRED_COMMANDS as readonly string[]).includes(cmd)
  )
    throw new Refused(`${cmd} is retired: use the Provisioning API`);
  if (p.positionals.length !== 1 || !COMMANDS.includes(cmd))
    throw new Refused(`usage: oa:hosted <${COMMANDS.join("|")}> --env <env>`);
  const env = v.env;
  if (env !== "staging" && env !== "prod")
    throw new Refused("--env must be staging or prod");
  const f: Flags = {
    env,
    install: v.install as string | undefined,
    tag: v.tag as string | undefined,
    floor: v.floor as string | undefined,
  };
  const need = (k: keyof Flags, flag: string) => {
    if (typeof f[k] !== "string" || f[k] === "")
      throw new Refused(`${cmd} needs --${flag}`);
  };
  if (cmd === "status") need("install", "install");
  else if (f.install !== undefined)
    throw new Refused(`${cmd} takes no --install`);
  if (f.install !== undefined && !isInstallId(f.install))
    throw new Refused("--install is not an install id");
  if (cmd === "publish-release") {
    need("tag", "tag");
    if (!/^v\d+\.\d+\.\d+$/.test(f.tag as string))
      throw new Refused("--tag must be a release tag like v1.2.3");
  } else if (f.tag !== undefined)
    throw new Refused("--tag is for publish-release only");
  if (cmd === "publish-floor") need("floor", "floor");
  else if (f.floor !== undefined)
    throw new Refused("--floor is for publish-floor only");
  return { cmd, f };
}

const inCi = (env: Deps["env"]) =>
  env.CI === "true" || env.GITHUB_ACTIONS === "true";

/** The Environment the hosted-publish workflow runs prod in (main only). */
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

  let cf: Cf;
  let r2: R2Releases | undefined;
  let actor: string;
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
      patDir: join(d.home, ".open-artifacts", `hosted-${env}`),
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

  // The provisioner's token checks, before this CLI's first write. status
  // runs near expiry with a warning, as the provisioner allows.
  try {
    await prov.verifyToken(cmd === "status" ? "warn" : "refuse");
    notes();
    emit({ step: "token", status: "ok", message: `${env} token verified` });
  } catch (e) {
    return fail("token", e);
  }

  let audit: PlatformDb;
  const subject = f.install ?? "-";
  try {
    const db = platformNames(env).db;
    const id = await cf.d1Get(db);
    if (!id) throw new Refused(`platform D1 ${db} not found`);
    audit = new PlatformDb(cf, { id, name: db }, env, d.now ?? Date.now);
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
    const r = await run(cmd, f, d, { cf, r2, env, prov, emit });
    notes();
    if (r.id) after = r.id;
    code = r.ok ? 0 : 1;
    emit({ step: cmd, status: r.ok ? "ok" : "error", data: r.data });
  } catch (e) {
    notes();
    code = fail(cmd, e);
  }
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
 * The broker (P2) is on for an install whose recorded vars turn google on:
 * status then also checks both registry copies for drift.
 */
async function brokerOn(
  cmd: Command,
  f: Flags,
  db: PlatformDb,
): Promise<boolean> {
  if (cmd !== "status" || !f.install) return false;
  const row = await db.byId(f.install);
  return row?.vars ? googleNewlyEnabled({}, JSON.parse(row.vars)) : false;
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
  },
): Promise<{ ok: boolean; id?: string; data: unknown }> {
  const { cf, env, prov } = c;
  const s3 = () => {
    if (!c.r2) throw new Refused("no R2 credentials were read");
    return c.r2;
  };
  const id = f.install as string;
  switch (cmd) {
    case "status":
      return { ok: true, data: await prov.status(id) };
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
    execFile: (file, args) =>
      new Promise((resolve, reject) => {
        execFileCb(file, args, { maxBuffer: 1 << 20 }, (e, stdout) =>
          e
            ? reject(new Error(`${file} exited ${e.code ?? "?"}`))
            : resolve(stdout),
        );
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
