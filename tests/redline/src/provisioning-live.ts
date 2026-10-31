import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { boundFetch } from "./fetch-timeout.ts";
import {
  AUDIENCES,
  type AudienceKey,
  jwtSource,
  mask,
  OIDC_FILES,
  writeSecretFile,
} from "./oidc.ts";
import {
  bringUpgrade,
  type CredsOut,
  mintCreds,
  type ProvIo,
  provConfig,
  Run,
  revokeCreds,
  stagedVersion,
} from "./provisioning.ts";
import { newRecipient, openSealed, parseCreds } from "./seal.ts";
import { readSecretFile, secretFileName } from "./targets.ts";

// The live wiring of src/provisioning.ts: real fetch (bounded), the wall
// clock, and the OIDC JWT files in secretsDir. Used by the live suite
// (live/provisioning.test.ts) and the workflow's bring-up and revoke steps
// (scripts/provisioning.ts).

export interface RawTargets {
  secretsDir: string;
  a: { installId: string; app: string };
  b: { installId: string; app: string };
}

/** The ids and origins of rl-a and rl-b, and secretsDir, from REDLINE_TARGETS. */
export function rawTargets(json: string | undefined): RawTargets {
  if (!json) throw new Error("REDLINE_TARGETS is not set");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("REDLINE_TARGETS is not JSON");
  }
  const side = (k: "a" | "b") => {
    const v = raw[k] as { installId?: unknown; app?: unknown } | undefined;
    if (typeof v?.installId !== "string" || typeof v.app !== "string")
      throw new Error(
        `REDLINE_TARGETS: ${k}.installId and ${k}.app are required`,
      );
    return { installId: v.installId, app: new URL(v.app).origin };
  };
  if (typeof raw.secretsDir !== "string" || !raw.secretsDir)
    throw new Error("REDLINE_TARGETS: secretsDir is required");
  return { secretsDir: raw.secretsDir, a: side("a"), b: side("b") };
}

const out = (s: string) => process.stdout.write(s);

export { mask };

export function liveRun(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Run {
  const m = mask(env);
  const src = (k: AudienceKey) =>
    jwtSource(join(t.secretsDir, OIDC_FILES[k]), AUDIENCES[k], {
      env,
      onMint: m,
    });
  const patFile = join(t.secretsDir, secretFileName("a", "PAT"));
  const io: ProvIo = {
    fetch: boundFetch(globalThis.fetch),
    now: Date.now,
    wait: (ms) => delay(ms),
    jwt: src("provisioning"),
    stgInventoryJwt: src("stagingInventory"),
    rlAPat: existsSync(patFile)
      ? () => readSecretFile(patFile, "REDLINE_RL_A_PAT")
      : undefined,
  };
  return new Run(provConfig(env, t), io);
}

/** Mints one JWT per key into secretsDir (0600), masking each. */
export async function mintFiles(
  env: Record<string, string | undefined>,
  dir: string,
  keys: readonly AudienceKey[],
): Promise<void> {
  for (const k of keys) {
    // A fresh mint: jwtSource re-mints because the file is absent.
    const file = join(dir, OIDC_FILES[k]);
    if (existsSync(file)) throw new Error(`${OIDC_FILES[k]} already exists`);
    await jwtSource(file, AUDIENCES[k], { env, onMint: mask(env) })();
  }
}

/** The workflow's bring-up (P24, R26): upgrade rl-a and rl-b, then mint their creds. */
export async function bringUp(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Promise<void> {
  const run = liveRun(env, t);
  const m = mask(env);
  const r = await newRecipient();
  const open = async (sealed: string): Promise<CredsOut> => {
    const c = parseCreds(await openSealed(r, sealed));
    m(c.pat);
    m(c.hookKey);
    return c;
  };
  for (const [name, side] of [
    ["a", t.a],
    ["b", t.b],
  ] as const) {
    const slug = `rl-${name}`;
    const how = await bringUpgrade(run, side.installId, slug);
    out(`${slug}: ${how} (${run.c.version})\n`);
    const c = await mintCreds(run, side.installId, slug, {
      publicKey: r.publicKey,
      open,
    });
    writeSecretFile(join(t.secretsDir, secretFileName(name, "PAT")), c.pat);
    writeSecretFile(
      join(t.secretsDir, secretFileName(name, "HOOK_KEY")),
      c.hookKey,
    );
    out(`${slug}: R26 creds written\n`);
  }
}

/** The workflow's last step: R26 revoke on rl-a and rl-b; both run, any failure fails. */
export async function revokeAll(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Promise<number> {
  const run = liveRun(env, t);
  let failed = 0;
  for (const [name, side] of [
    ["a", t.a],
    ["b", t.b],
  ] as const) {
    const f = join(t.secretsDir, secretFileName(name, "PAT"));
    const pat = existsSync(f)
      ? readSecretFile(f, secretFileName(name, "PAT"))
      : undefined;
    try {
      await revokeCreds(run, side.installId, `rl-${name}`, side.app, pat);
      out(`rl-${name}: R26 revoked\n`);
    } catch (e) {
      failed++;
      out(`rl-${name}: revoke failed: ${(e as Error).message}\n`);
    }
  }
  return failed ? 1 : 0;
}

/**
 * The staging-first record: once rl-a's and rl-b's /healthz both report
 * REDLINE_RELEASE, writes it (X.Y.Z) to `file` for the
 * redline-staged-version artifact.
 */
export async function writeStagedVersion(
  env: Record<string, string | undefined>,
  t: RawTargets,
  file: string,
): Promise<void> {
  const v = await stagedVersion(liveRun(env, t));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${v}\n`);
  out(`rl-a and rl-b report ${v}\n`);
}
