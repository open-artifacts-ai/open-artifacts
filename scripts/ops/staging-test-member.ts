#!/usr/bin/env node
// Member or admin sign-in for an agent on the staging install rl-agents:
// `node scripts/ops/staging-test-member.ts [--role member|admin] [--mcp] [--revoke]`.
// See HELP below and docs/ops/hosted.md, "Staging test member for agents".
import { execFile as execFileCb } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openSealedNode } from "./staging-test-admin.ts";

const execFile = promisify(execFileCb);
const REPO = "open-artifacts-ai/open-artifacts";
export const WORKFLOW = "staging-test-member.yml";
/** The one install this signs in to; the workflow checks R2 says the same. */
export const APP_HOST = "rl-agents.open-artifacts-staging.app";
export const COOKIE = "__Host-oa_session";
export const EMAIL = "agent-member@oa-redline-a.fyi";
/**
 * The admin's own address: the server never changes an existing user's
 * role, so the member can't be made admin.
 */
export const ADMIN_EMAIL = "agent-admin@oa-redline-a.fyi";
export const MCP_URL = `https://${APP_HOST}/mcp`;
/** Where --mcp writes, outside any git work tree. */
export const MCP_BASE = join(homedir(), ".oa-redline", "rl-agents");
/** R26's HKDF info (apps/provisioner/src/seal.ts SEAL_INFO.redlineCreds). */
export const SEAL_INFO = "oa-redline-creds-v1";
/** apps/server/src/auth/session.ts MAX_AGE_S: a session cookie lives 7 days. */
export const SESSION_MAX_AGE_MS = 7 * 86_400_000;
/** The install roles this asks for. Never owner. */
export const ROLES = ["member", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const emailFor = (role: Role): string =>
  role === "admin" ? ADMIN_EMAIL : EMAIL;

export const HELP = `Usage: node scripts/ops/staging-test-member.ts [--role member|admin]
       node scripts/ops/staging-test-member.ts --role admin --mcp
       node scripts/ops/staging-test-member.ts --revoke

Signs an agent in to the staging install rl-agents as ${EMAIL}
(role member) or ${ADMIN_EMAIL} (role admin), with no
credential any person hands over. It makes an X25519 key pair in memory, dispatches ${WORKFLOW}
on main and waits. That job's OIDC JWT calls R26 on rl-agents, which
rotates the install's TEST_HOOK_KEY, mints a new PAT and revokes the earlier
ones; the result comes back sealed to this process's key. The hook key is
used here, in memory, for POST /__test/session, and only the session goes
into a new 0600 Playwright storage-state file. The one line printed is JSON
with that file's path. The hook key is never written or printed; the PAT is
written only by --mcp, and never printed.

Each mint rotates the hook key and revokes the earlier redline-* PATs on
rl-agents, so it cuts off the credentials of every earlier mint, another
agent's included: anyone's next mint disconnects an MCP agent using an older
config. A session already written to a storage-state file is not cut off: it
lasts until its cookie expires (7 days). Delete the storage-state files and
MCP configs when you are done.

  --role member|admin  the session's role (default member); owner is refused
  --mcp                with --role admin only, since the PAT is the red-line
                       admin test user's: also write an MCP client config
                       for ${MCP_URL} holding the PAT
                       (Authorization: Bearer), as a new 0600 file under
                       ~/.oa-redline/rl-agents/ (0700). Before the mint it
                       refuses a place inside a git work tree it can find
                       (a .git above it); a bare repo whose work tree is
                       home (git --git-dir ~/.dotfiles) is not detected
  --revoke             dispatch with revoke: true instead: rotate the hook
                       key to one nobody holds and revoke the PATs; writes
                       nothing
  --help               this text

Staging and rl-agents only. Needs gh, signed in.`;

export type Args = { revoke: boolean; help: boolean; role: Role; mcp: boolean };

/** The command line, or an Error saying what is wrong. */
export function parseArgs(argv: readonly string[]): Args | Error {
  const out: Args = { revoke: false, help: false, role: "member", mcp: false };
  let roleSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--revoke") out.revoke = true;
    else if (a === "--mcp") out.mcp = true;
    else if (a === "--role" || a.startsWith("--role=")) {
      const v = a === "--role" ? argv[++i] : a.slice("--role=".length);
      if (roleSet) return new Error("--role given twice");
      if (!(ROLES as readonly string[]).includes(v ?? ""))
        return new Error(`--role is member or admin, not ${v ?? "nothing"}`);
      out.role = v as Role;
      roleSet = true;
    } else return new Error(`unknown argument: ${a}`);
  }
  if (out.revoke && (roleSet || out.mcp))
    return new Error("--revoke takes no --role or --mcp");
  if (out.mcp && out.role !== "admin")
    return new Error(
      "--mcp needs --role admin: the PAT is admin whatever the role",
    );
  return out;
}

export type MintLog = { sealed: string; job: string };

/**
 * The sealed credentials and job id from a mint run's log, or null. The app
 * host in the log must be APP_HOST: the hook key goes nowhere else.
 */
export function parseMintLog(log: string): MintLog | null {
  const sealed = markerValue(log, "sealed", "oa-seal-v1\\.[A-Za-z0-9_.-]+");
  const job = markerValue(log, "job", JOB);
  const host = markerValue(log, "app-host", "[a-z0-9.-]+");
  if (!sealed || !job || host !== APP_HOST) return null;
  return { sealed, job };
}

/** True when a revoke run's log says it revoked rl-agents. */
export const parseRevokeLog = (log: string): boolean =>
  markerValue(log, "revoked", "[a-z0-9-]+") === "rl-agents" &&
  markerValue(log, "job", JOB) !== null;

const JOB = "[A-Za-z0-9_-]+";

/**
 * The value printed after `test-member-<marker>: `, or null. gh's log also
 * holds the step's script, where each marker is followed by a shell variable
 * (`echo "test-member-app-host: $host"`); only a marker at the start of a
 * word whose whole value matches `value` counts. Two different values: null.
 */
function markerValue(
  log: string,
  marker: string,
  value: string,
): string | null {
  const re = new RegExp(
    `(?:^|\\s)test-member-${marker}: (${value})(?=\\s|$)`,
    "gm",
  );
  const found = new Set(Array.from(log.matchAll(re), (m) => m[1]));
  return found.size === 1 ? [...found][0] : null;
}

/** R26's opened payload: the hook key, and the PAT (null when absent). */
export function credsOf(plain: string): {
  hookKey: string;
  pat: string | null;
} {
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    // Never the parser's message: it can quote the payload.
    throw new Error("the sealed credentials are not JSON");
  }
  const o = v as { hookKey?: unknown; pat?: unknown } | null;
  const k = o?.hookKey;
  if (typeof k !== "string" || k === "")
    throw new Error("the sealed credentials have no hook key");
  const p = o?.pat;
  return { hookKey: k, pat: typeof p === "string" && p !== "" ? p : null };
}

/** POST /__test/session on rl-agents: the session cookie value. */
export async function testSession(
  f: typeof fetch,
  hookKey: string,
  role: Role,
): Promise<string> {
  const res = await f(`https://${APP_HOST}/__test/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hookKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: emailFor(role), role }),
    redirect: "error",
  });
  // Never the body: a refusal names only a reason, but keep the log plain.
  if (res.status !== 200)
    throw new Error(`rl-agents /__test/session: HTTP ${res.status}`);
  const cookie = (
    (await res.json().catch(() => null)) as {
      cookie?: unknown;
    } | null
  )?.cookie;
  if (typeof cookie !== "string" || cookie === "")
    throw new Error("rl-agents /__test/session: no cookie");
  return cookie;
}

/** Playwright's storageState for rl-agents' session cookie. */
export const storageState = (cookie: string, expiresAt: number) => ({
  cookies: [
    {
      name: COOKIE,
      value: cookie,
      domain: APP_HOST,
      path: "/",
      expires: Math.floor(expiresAt / 1000),
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [],
});

/** Writes the state to a new 0600 file in a new 0700 directory; its path. */
export function writeState(state: unknown, base = tmpdir()): string {
  const dir = mkdtempSync(join(base, "oa-test-member-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "storage-state.json");
  writeFileSync(file, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return file;
}

/** An MCP client config (the mcpServers shape) for rl-agents with the PAT. */
export const mcpConfig = (pat: string) => ({
  mcpServers: {
    "oa-rl-agents": {
      type: "http",
      url: MCP_URL,
      headers: { Authorization: `Bearer ${pat}` },
    },
  },
});

/**
 * The git work tree holding `real` (a real path), or null: any ancestor with
 * a `.git` entry, a directory for a checkout or a file for a worktree.
 */
export function gitWorkTreeOf(real: string): string | null {
  for (let p = real; ; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) return p;
    if (dirname(p) === p) return null;
  }
}

/** `p`'s real path, through its nearest existing ancestor. */
function realPathOf(p: string): string {
  const rest: string[] = [];
  let q = p;
  while (!existsSync(q)) {
    if (dirname(q) === q) break;
    rest.unshift(basename(q));
    q = dirname(q);
  }
  return join(realpathSync(q), ...rest);
}

/** Throws when `base` is, or would be, inside a git work tree. */
export function assertOutsideGit(base: string): void {
  const tree = gitWorkTreeOf(realPathOf(base));
  if (tree)
    throw new Error(
      `--mcp refuses ${base}: it is inside the git work tree ${tree}`,
    );
}

/**
 * Makes `base` ready for MCP configs, before any mint: refuses it inside a
 * git work tree, makes it (and any parents it makes) 0700, then re-checks
 * the real path, that it is a directory, and sets it 0700. Its real path.
 */
export function prepareMcpDir(base: string): string {
  assertOutsideGit(base);
  let real: string;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    real = realpathSync(base);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new Error(`--mcp cannot use ${base}: ${String(code ?? e)}`);
  }
  assertOutsideGit(real);
  if (!statSync(real).isDirectory())
    throw new Error(`--mcp cannot use ${base}: not a directory`);
  chmodSync(real, 0o700);
  return real;
}

/** The config as a new 0600 file `name` in a prepared `dir`; its path. */
export function writeMcpFile(
  dir: string,
  name: string,
  config: unknown,
): string {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return file;
}

/** prepareMcpDir then writeMcpFile; the file's path. */
export const writeMcpConfig = (
  config: unknown,
  base: string,
  name: string,
): string => writeMcpFile(prepareMcpDir(base), name, config);

export type Deps = {
  gh: (...args: string[]) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  tmp: string;
  /** Where --mcp writes; MCP_BASE outside tests. */
  mcpBase: string;
  log: (line: string) => void;
};

/** Dispatches, finds this dispatch's run, waits; the run's log. */
async function dispatchAndWait(
  d: Deps,
  fields: string[],
): Promise<{
  id: string;
  log: string;
}> {
  const since = new Date(d.now() - 5_000).toISOString();
  await d.gh(
    "workflow",
    "run",
    WORKFLOW,
    "-R",
    REPO,
    "--ref",
    "main",
    ...fields.flatMap((f) => ["-f", f]),
  );
  // The run this dispatch made: the newest workflow_dispatch run since then.
  let id = "";
  for (let i = 0; i < 30 && !id; i++) {
    await d.sleep(2_000);
    id = (
      await d.gh(
        "run",
        "list",
        "-R",
        REPO,
        "-w",
        WORKFLOW,
        "-e",
        "workflow_dispatch",
        "-L",
        "1",
        "--created",
        `>=${since}`,
        "--json",
        "databaseId",
        "-q",
        ".[0].databaseId // empty",
      )
    ).trim();
  }
  if (!id) throw new Error("the dispatched run did not appear");
  // A run id names files; only digits.
  if (!/^\d+$/.test(id))
    throw new Error("the dispatched run's id is not a number");
  await d.gh("run", "watch", id, "-R", REPO, "--exit-status");
  return { id, log: await d.gh("run", "view", id, "-R", REPO, "--log") };
}

export async function main(argv: readonly string[], d: Deps): Promise<number> {
  const args = parseArgs(argv);
  if (args instanceof Error) {
    d.log(`${args.message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    d.log(HELP);
    return 0;
  }
  if (args.revoke) {
    const run = await dispatchAndWait(d, ["revoke=true"]);
    if (!parseRevokeLog(run.log))
      throw new Error(`run ${run.id}: no revoke in its log`);
    d.log(JSON.stringify({ revoked: "rl-agents", run: run.id }));
    return 0;
  }
  // All directory setup before the mint, which revokes everyone's earlier
  // PATs; after it, the only file step is the config's own wx write.
  const mcpDir = args.mcp ? prepareMcpDir(d.mcpBase) : null;
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }).x as string;
  const run = await dispatchAndWait(d, [
    `recipient_key=${pub}`,
    "revoke=false",
  ]);
  const got = parseMintLog(run.log);
  if (!got) throw new Error(`run ${run.id}: no sealed credentials in its log`);
  const { hookKey, pat } = credsOf(
    openSealedNode(privateKey, got.sealed, SEAL_INFO),
  );
  if (args.mcp && !pat) throw new Error("the sealed credentials have no PAT");
  const cookie = await testSession(d.fetch, hookKey, args.role);
  const expiresAt = d.now() + SESSION_MAX_AGE_MS;
  const file = writeState(storageState(cookie, expiresAt), d.tmp);
  const out: Record<string, unknown> = {
    storageState: file,
    expiresAt,
    run: run.id,
  };
  if (mcpDir && pat) {
    if (!/^\d+$/.test(run.id)) throw new Error("the run id is not a number");
    try {
      out.mcpConfig = writeMcpFile(
        mcpDir,
        `mcp-${run.id}-${d.now()}.json`,
        mcpConfig(pat),
      );
    } catch (e) {
      // Don't orphan the session: remove the state this run just wrote.
      rmSync(dirname(file), { recursive: true, force: true });
      const code = (e as { code?: unknown }).code;
      throw new Error(
        `--mcp could not write its config (${String(code ?? "error")}); the storage state was deleted`,
      );
    }
  }
  d.log(JSON.stringify(out));
  return 0;
}

const gh = async (...args: string[]) =>
  (await execFile("gh", args, { maxBuffer: 16 << 20 })).stdout;

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main(process.argv.slice(2), {
    gh,
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    tmp: tmpdir(),
    mcpBase: MCP_BASE,
    log: (l) => console.log(l),
  }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
