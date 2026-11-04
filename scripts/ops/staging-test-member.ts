#!/usr/bin/env node
// Member sign-in for an agent on the staging install rl-agents:
// `node scripts/ops/staging-test-member.ts [--revoke]`.
// See HELP below and docs/ops/hosted.md, "Staging test member for agents".
import { execFile as execFileCb } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/** R26's HKDF info (apps/provisioner/src/seal.ts SEAL_INFO.redlineCreds). */
export const SEAL_INFO = "oa-redline-creds-v1";
/** apps/server/src/auth/session.ts MAX_AGE_S: a session cookie lives 7 days. */
export const SESSION_MAX_AGE_MS = 7 * 86_400_000;
/** The one install role this asks for. Never admin or owner. */
export const ROLE = "member";

export const HELP = `Usage: node scripts/ops/staging-test-member.ts [--revoke]

Signs an agent in to the staging install rl-agents as ${EMAIL}, role
member, with no credential any person hands over. It makes an X25519 key pair in memory, dispatches ${WORKFLOW}
on main and waits. That job's OIDC JWT calls R26 on rl-agents, which
rotates the install's TEST_HOOK_KEY, mints a new PAT and revokes the earlier
ones; the result comes back sealed to this process's key. The hook key is
used here, in memory, for POST /__test/session, and only the session goes
into a new 0600 Playwright storage-state file. The one line printed is JSON
with that file's path. The PAT and the hook key are never written or printed.

Each mint rotates the hook key and revokes the earlier PATs, so it cuts off
the credentials of every earlier mint, another agent's included. A session
already written to a storage-state file is not cut off: it lasts until its
cookie expires (7 days). Delete those files when you are done.

  --revoke             dispatch with revoke: true instead: rotate the hook
                       key to one nobody holds and revoke the PATs; writes
                       nothing
  --help               this text

Staging and rl-agents only. Needs gh, signed in.`;

export type Args = { revoke: boolean; help: boolean };

/** The command line, or an Error saying what is wrong. */
export function parseArgs(argv: readonly string[]): Args | Error {
  const out: Args = { revoke: false, help: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--revoke") out.revoke = true;
    else return new Error(`unknown argument: ${a}`);
  }
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

/** R26's opened payload: only the hook key is used. */
export function hookKeyOf(plain: string): string {
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    throw new Error("the sealed credentials are not JSON");
  }
  const k = (v as { hookKey?: unknown } | null)?.hookKey;
  if (typeof k !== "string" || k === "")
    throw new Error("the sealed credentials have no hook key");
  return k;
}

/** POST /__test/session on rl-agents: the session cookie value. */
export async function testSession(
  f: typeof fetch,
  hookKey: string,
): Promise<string> {
  const res = await f(`https://${APP_HOST}/__test/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hookKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: EMAIL, role: ROLE }),
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

export type Deps = {
  gh: (...args: string[]) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  tmp: string;
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
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }).x as string;
  const run = await dispatchAndWait(d, [
    `recipient_key=${pub}`,
    "revoke=false",
  ]);
  const got = parseMintLog(run.log);
  if (!got) throw new Error(`run ${run.id}: no sealed credentials in its log`);
  const hookKey = hookKeyOf(openSealedNode(privateKey, got.sealed, SEAL_INFO));
  const cookie = await testSession(d.fetch, hookKey);
  const expiresAt = d.now() + SESSION_MAX_AGE_MS;
  const file = writeState(storageState(cookie, expiresAt), d.tmp);
  d.log(JSON.stringify({ storageState: file, expiresAt, run: run.id }));
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
    log: (l) => console.log(l),
  }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
