#!/usr/bin/env node
// A 1 h staging admin session for an agent (#1053), as the staging test
// admin: `node scripts/ops/staging-test-admin.ts`. It makes an X25519 key
// pair in memory, dispatches staging-test-admin.yml with the public half,
// waits for the run, reads the sealed sid from its log and opens it here. The
// sid goes only into a new 0600 Playwright storage-state file (its path is
// the one line printed); the private key never leaves this process. Minting
// revokes the previous test admin session. Needs `gh`, signed in.
import { execFile as execFileCb } from "node:child_process";
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const REPO = "open-artifacts-ai/open-artifacts";
const WORKFLOW = "staging-test-admin.yml";
export const ADMIN_HOST = "admin.open-artifacts-staging.app";
export const COOKIE = "__Host-oa-admin";
const SEALED_RE = /test-admin-sealed: (oa-seal-v1\.[A-Za-z0-9_.-]+)/;
const EXPIRES_RE = /test-admin-expires-at: (\d+)/;

/**
 * Opens an oa-seal-v1 value (apps/provisioning/src/auth/seal.ts, R28) with
 * the caller's X25519 private key: ECDH, HKDF-SHA256 over (epk || own public
 * key) with R28's info (oa-test-admin-session-v1), AES-256-GCM. node:crypto, so the agent
 * side is an independent implementation; test/node/seal-interop.test.ts in
 * apps/provisioning checks the two agree.
 */
export function openSealedNode(
  priv: KeyObject,
  sealed: string,
  info = "oa-test-admin-session-v1",
): string {
  const [p, e, i, c, ...rest] = sealed.split(".");
  if (p !== "oa-seal-v1" || !e || !i || !c || rest.length)
    throw new Error("not an oa-seal-v1 value");
  const epk = Buffer.from(e, "base64url");
  const mine = Buffer.from(
    createPublicKey(priv).export({ format: "jwk" }).x as string,
    "base64url",
  );
  const shared = diffieHellman({
    privateKey: priv,
    publicKey: createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: e },
      format: "jwk",
    }),
  });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([epk, mine]), info, 32),
  );
  const ct = Buffer.from(c, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(i, "base64url"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([
    d.update(ct.subarray(0, ct.length - 16)),
    d.final(),
  ]).toString("utf8");
}

/** The sealed sid and expiry from the run's log text, or null. */
export function parseLog(
  log: string,
): { sealed: string; expiresAt: number } | null {
  const s = SEALED_RE.exec(log)?.[1];
  const e = EXPIRES_RE.exec(log)?.[1];
  return s && e ? { sealed: s, expiresAt: Number(e) } : null;
}

/** Playwright's storageState for the admin host's session cookie. */
export const storageState = (sid: string, expiresAt: number) => ({
  cookies: [
    {
      name: COOKIE,
      value: sid,
      domain: ADMIN_HOST,
      path: "/",
      expires: Math.floor(expiresAt / 1000),
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ],
  origins: [],
});

const gh = async (...args: string[]) =>
  (await execFile("gh", args, { maxBuffer: 16 << 20 })).stdout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }).x as string;
  const since = new Date(Date.now() - 5_000).toISOString();
  await gh(
    "workflow",
    "run",
    WORKFLOW,
    "-R",
    REPO,
    "--ref",
    "main",
    "-f",
    `recipient_key=${pub}`,
  );
  // The run this dispatch made: the newest workflow_dispatch run since then.
  let id = "";
  for (let i = 0; i < 30 && !id; i++) {
    await sleep(2_000);
    id = (
      await gh(
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
  await gh("run", "watch", id, "-R", REPO, "--exit-status");
  const got = parseLog(await gh("run", "view", id, "-R", REPO, "--log"));
  if (!got) throw new Error(`run ${id}: no sealed session in its log`);
  const sid = openSealedNode(privateKey, got.sealed);
  const dir = mkdtempSync(join(tmpdir(), "oa-test-admin-"));
  const file = join(dir, "storage-state.json");
  writeFileSync(file, JSON.stringify(storageState(sid, got.expiresAt)), {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  console.log(
    JSON.stringify({ storageState: file, expiresAt: got.expiresAt, run: id }),
  );
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
