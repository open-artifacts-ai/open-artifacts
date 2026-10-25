// `pnpm oa:hosted <command> --env staging|prod ...` (P1 Task 8): the hosted
// control plane's laptop CLI. Every command is a thin wrapper over
// @oa/provision (WfpProvisioner, publishRelease, publishFloor,
// turnstileInit); this file holds no provisioning logic of its own.
//
// - Token: the macOS keychain item oa-hosted-<env>, read with
//   `security find-generic-password -w`. CI is staging only and reads a 0600
//   file named by OA_HOSTED_TOKEN_FILE; prod never reads a file. The token
//   lives only in this process: never in argv, a file, a child's environment
//   or the output.
// - Before any write: flag refusals, then the provisioner's own token checks.
// - Audit: a before row and an after row in hosted_audit, with the actor
//   (git config user.email, or the CI run URL).
// - Output: one JSON line per step, redacted; no secret, PAT or key is printed.
import { execFile as execFileCb, spawn } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  type ReleaseReader,
  r2ReleaseReader,
  type TurnstileKeys,
  turnstileInit,
  WfpProvisioner,
} from "@oa/provision";

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
] as const;
type Command = (typeof COMMANDS)[number];

export const HELP = `Usage: pnpm oa:hosted <command> --env staging|prod [flags]

Commands:
  create          --slug <s> --owner <email> --to <version> [--var K=V]... [--test-hooks] [--install <id>]
                  --test-hooks: staging only (redline bundle); --install resumes that create
  upgrade         --install <id> --to <version>
  rollback        --install <id>
  update-vars     --install <id> --var K=V... (the full set)
  delete          --install <id> --confirm <the same id>
  release-lease   --install <id> --confirm <the same id> [--force]
                  --force: release a live lease; only when no operation is running
  status          --install <id>
  publish-release --tag v<version>  (gh release download of oa-release-<env>-*, verified, then uploaded)
  publish-floor   --floor <path to floor-<env>-<seq>.sig.json>
  turnstile-init  (the env's one Turnstile widget; idempotent)

Flags:
  --var K=V       repeatable; checked by provision's var allowlist. AUTH_PROVIDERS with
                  google turns the sign-in broker on for the install.
Token: keychain item oa-hosted-<env>. CI (staging only): a 0600 file at OA_HOSTED_TOKEN_FILE.
Env: CLOUDFLARE_ACCOUNT_ID (the hosted account id). Output: one JSON line per step.`;

/** The tenant domain pair per env: provision's table, never a flag. */
export const DOMAINS = HOSTED_DOMAINS;

/** The GitHub repo whose releases publish-release downloads. */
export const REPO = "open-artifacts-ai/open-artifacts";

export const keychainItem = (env: Env) => `oa-hosted-${env}`;
export const turnstileItem = (env: Env) => `oa-hosted-${env}-turnstile`;

export interface FileInfo {
  mode: number;
  uid: number;
  isFile: boolean;
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
  /** lstat (a symlink is not a file). */
  stat: (path: string) => FileInfo | null;
  readFile: (path: string) => Uint8Array;
  tempDir: () => string;
  listDir: (dir: string) => string[];
  removeTree: (dir: string) => void;
  cf: (o: { accountId: string; token: string }) => Cf;
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
  vars: Record<string, string>;
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
        slug: { type: "string" },
        owner: { type: "string" },
        to: { type: "string" },
        confirm: { type: "string" },
        tag: { type: "string" },
        floor: { type: "string" },
        "test-hooks": { type: "boolean" },
        force: { type: "boolean" },
        var: { type: "string", multiple: true },
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
    vars,
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
  if (cmd === "delete" || cmd === "release-lease") {
    if (f.confirm !== f.install)
      throw new Refused(
        `${cmd} needs --confirm to be exactly the install id (--install)`,
      );
  }
  if (f.force && cmd !== "release-lease")
    throw new Refused("--force is for release-lease only");
  if (cmd === "update-vars" && Object.keys(vars).length === 0)
    throw new Refused("update-vars needs the full set of --var NAME=value");
  if (cmd === "publish-release") {
    need("tag", "tag");
    if (!/^v\d+\.\d+\.\d+$/.test(f.tag as string))
      throw new Refused("--tag must be a release tag like v1.2.3");
  }
  if (cmd === "publish-floor") need("floor", "floor");
  return { cmd, f };
}

const inCi = (env: Deps["env"]) =>
  env.CI === "true" || env.GITHUB_ACTIONS === "true";

/** The env's provisioning token, from the only source that env allows. */
async function readToken(d: Deps, env: Env): Promise<string> {
  const file = d.env.OA_HOSTED_TOKEN_FILE;
  if (env === "prod") {
    if (file !== undefined)
      throw new Refused(
        "prod reads its token only from the keychain; unset OA_HOSTED_TOKEN_FILE",
      );
    if (inCi(d.env)) throw new Refused("CI is staging only; prod refused");
  }
  let token: string;
  if (file !== undefined) {
    const st = d.stat(file);
    if (!st?.isFile)
      throw new Refused("OA_HOSTED_TOKEN_FILE is not a regular file");
    if ((st.mode & 0o777) !== 0o600)
      throw new Refused("OA_HOSTED_TOKEN_FILE must be mode 0600");
    if (st.uid !== d.uid)
      throw new Refused("OA_HOSTED_TOKEN_FILE must be owned by this user");
    token = new TextDecoder().decode(d.readFile(file)).trim();
  } else {
    if (inCi(d.env))
      throw new Refused("CI has no keychain; set OA_HOSTED_TOKEN_FILE");
    try {
      token = (
        await d.execFile(SECURITY, [
          "find-generic-password",
          "-w",
          "-s",
          keychainItem(env),
        ])
      ).trim();
    } catch {
      throw new Refused(`keychain item ${keychainItem(env)} not found`);
    }
  }
  if (!token || /\s/.test(token))
    throw new Refused("the token is empty or has whitespace in it");
  return token;
}

async function readTurnstile(d: Deps, env: Env): Promise<TurnstileKeys | null> {
  if (inCi(d.env)) return null;
  let raw: string;
  try {
    raw = (
      await d.execFile(SECURITY, [
        "find-generic-password",
        "-w",
        "-s",
        turnstileItem(env),
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
    input: `add-generic-password -U -a oa-hosted -s ${turnstileItem(env)} -w ${k.sitekey}:${k.secret}\n`,
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

  let cf: Cf;
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
    if (cmd === "create" || cmd === "update-vars")
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
      brokerEnabled,
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
  const recovery = ["rollback", "delete", "release-lease", "status"];
  try {
    await prov.verifyToken(recovery.includes(cmd) ? "warn" : "refuse");
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
    const r = await run(cmd, f, d, { cf, env, prov, emit });
    notes();
    if (r.id) after = r.id;
    code = r.ok ? 0 : 1;
    emit({ step: cmd, status: r.ok ? "ok" : "error", data: r.data });
  } catch (e) {
    notes();
    code = fail(cmd, e);
    // A create that failed after minting its id: the after row names it.
    if (cmd === "create" && after === "-")
      after =
        (await audit.bySlug(f.slug as string).catch(() => undefined))?.id ??
        "-";
  }
  try {
    await audit.auditAs(
      actor,
      after,
      `cli.${cmd}.${code === 0 ? "done" : "failed"}`,
      {
        cmd,
        exit: code,
      },
    );
    emit({ step: "audit", status: "ok", message: "after row written" });
  } catch (e) {
    return fail("audit", e);
  }
  return code;
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
    env: Env;
    prov: WfpProvisioner;
    emit: (l: Record<string, unknown>) => void;
  },
): Promise<{ ok: boolean; id?: string; data: unknown }> {
  const { cf, env, prov } = c;
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
      // TODO(Manager): the delete state machine that waits for the directory
      // broker's revoke before removing resources. Until its design lands,
      // this is provision's current delete().
      const r = await prov.delete(id, f.confirm as string);
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
      await probeR2Conditionals(cf, env);
      const floor = d.readFile(f.floor as string);
      const r = await publishFloor({ cf, env, floor });
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
        await probeR2Conditionals(cf, env);
        const out = [];
        for (const v of variants) {
          const base = join(dir, `oa-release-${env}-${v}-${version}`);
          if (!have.has(`oa-release-${env}-${v}-${version}.sig.json`))
            throw new Refused(`release ${tag}: ${v} has no .sig.json`);
          const r = await publishRelease({
            cf,
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
    stat: (p) => {
      try {
        const s = lstatSync(p);
        return { mode: s.mode, uid: s.uid, isFile: s.isFile() };
      } catch {
        return null;
      }
    },
    readFile: (p) => new Uint8Array(readFileSync(p)),
    tempDir: () => mkdtempSync(join(tmpdir(), "oa-hosted-")),
    listDir: (dir) => readdirSync(dir),
    removeTree: (dir) => rmSync(dir, { recursive: true, force: true }),
    cf: (o) => cfClient(o),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), realDeps());
}
