// @ts-check
// hosted-floor (T3b H1): signs the env's release floor (releases/floor.json)
// with the env's release key, the only place that key exists. Plain .mjs run
// on Node 22 (setup-node from .nvmrc, no strip-types); node:* imports
// only (and the local .mjs it imports, likewise): the job installs nothing.
// The key arrives on stdin only:
//   printf '%s' "$RELEASE_SIGNING_KEY" | node scripts/ci/sign-floor.mjs \
//     --env staging|prod --seq <n> --min-version <semver> \
//     --revoked "<semver>,<semver>" --out <dir>
// Writes <out>/floor-<env>-<seq>.sig.json and prints only GITHUB_OUTPUT
// lines (floor_signature, floor_record_sha256).
// With --assemble --signature <sig> --record-sha256 <h> (no key, the upload
// job): rebuilds the record from the same inputs, requires its sha256 and
// the signature (against the pinned key, once it is real), and writes the
// identical file. publishFloor takes the file; it is never a release asset.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  parseArgs,
  readKeyFromStdin,
  runMain,
  sha256Hex,
} from "./release-artifact.mjs";
import { checkSigningKey, verifySignature } from "./release-pubkeys.mjs";

/** @typedef {import("./release-pubkeys.mjs").Env} Env */

const NAME = "sign-floor";
const ARGS = ["env", "seq", "min-version", "revoked", "out"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * The floor record from validated inputs, as its canonical string.
 * @param {Record<string, string>} a
 * @returns {{ env: Env; seq: number; record: string }}
 */
function floorRecord(a) {
  const env = a.env;
  if (env !== "staging" && env !== "prod")
    throw new Error("--env must be staging or prod");
  const seqText = a.seq ?? "";
  if (!/^[1-9]\d{0,14}$/.test(seqText))
    throw new Error("--seq must be a positive integer");
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) throw new Error("--seq is too large");
  const minVersion = a["min-version"] ?? "";
  if (!SEMVER.test(minVersion))
    throw new Error("--min-version must be a release version");
  const rv = a.revoked ?? "";
  const revoked = rv === "" ? [] : rv.split(",");
  for (const v of revoked)
    if (!SEMVER.test(v))
      throw new Error(
        `--revoked has a non-version entry ${JSON.stringify(v).slice(0, 40)}`,
      );
  if (new Set(revoked).size !== revoked.length)
    throw new Error("--revoked repeats a version");
  return { env, seq, record: canonicalJson({ env, seq, minVersion, revoked }) };
}

/** @param {Env} env @param {string} record */
const payloadOf = (env, record) =>
  Buffer.from(`oa-release-floor-v1\n${env}\n${record}`);

async function main() {
  const argv = process.argv.slice(2);
  const assemble = argv.includes("--assemble");
  const a = parseArgs(
    argv.filter((x) => x !== "--assemble"),
    assemble ? [...ARGS, "signature", "record-sha256"] : ARGS,
  );
  for (const k of ARGS)
    if (a[k] === undefined) throw new Error(`--${k} is required`);
  const f = floorRecord(a);
  const payload = payloadOf(f.env, f.record);
  /** @type {string} */
  let signature;
  if (assemble) {
    if (a["record-sha256"] !== sha256Hex(f.record))
      throw new Error("the floor record is not the one hosted-floor signed");
    signature = a.signature ?? "";
    verifySignature(f.env, payload, signature);
  } else {
    const pem = await readKeyFromStdin();
    /** @type {import("node:crypto").KeyObject} */
    let key;
    try {
      key = createPrivateKey({ key: pem, format: "pem" });
    } catch {
      throw new Error("the key on stdin is not a PEM private key");
    }
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("the signing key is not Ed25519");
    const pub = createPublicKey(key);
    checkSigningKey(f.env, String(pub.export({ format: "jwk" }).x));
    signature = sign(null, payload, key).toString("base64url");
    if (!verify(null, payload, pub, Buffer.from(signature, "base64url")))
      throw new Error("the signature does not verify");
  }
  const out = resolve(String(a.out));
  await mkdir(out, { recursive: true });
  const name = `floor-${f.env}-${f.seq}.sig.json`;
  await writeFile(
    join(out, name),
    JSON.stringify({ record: f.record, signature }),
    { flag: "wx" },
  );
  process.stderr.write(`${NAME}: wrote ${name}\n`);
  if (!assemble)
    process.stdout.write(
      `floor_signature=${signature}\nfloor_record_sha256=${sha256Hex(f.record)}\n`,
    );
}

await runMain(NAME, main);
