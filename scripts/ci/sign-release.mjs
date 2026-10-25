// @ts-check
// hosted-sign (T3b): signs the hosted release artifact for one env. Plain
// .mjs run on Node 22 (setup-node from .nvmrc, no strip-types); node:*
// imports only (and the local .mjs it imports, likewise): the job installs
// nothing. The Ed25519 key (PKCS8 PEM) arrives on stdin only, never in argv,
// a file or a log:
//   printf '%s' "$RELEASE_SIGNING_KEY" | node scripts/ci/sign-release.mjs \
//     --dir <artifact> --env staging|prod --version <v> --manifest-sha256 <h> \
//     --bundle-sha256 <h> --commit <hosted-guard sha> \
//     --lockfile pnpm-lock.yaml --out <dir>
// Re-hashes every file against manifest.json, requires hosted-check's two
// hashes, both variants built from the guard's commit with the checked-out
// lockfile, no /__test/ route in release and the configs' defines, then
// signs each variant (staging: release and redline; prod: release) and writes
// oa-release-<env>-<variant>-<version>.tar and .sig.json. Prints only
// GITHUB_OUTPUT lines (<env>_<variant>_signature, _tar_sha256,
// _record_sha256) on stdout; errors go to stderr; exits 0 or 1.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fileSha256,
  parseArgs,
  prepare,
  readArtifact,
  readStdinText,
  recordPayload,
  runMain,
  sigJson,
} from "./release-artifact.mjs";
import { checkSigningKey, skipUnsigned } from "./release-pubkeys.mjs";

const NAME = "sign-release";
const ARGS = [
  "dir",
  "env",
  "version",
  "manifest-sha256",
  "bundle-sha256",
  "commit",
  "lockfile",
  "out",
];

async function main() {
  const a = parseArgs(process.argv.slice(2), ARGS);
  for (const k of ARGS) if (!a[k]) throw new Error(`--${k} is required`);
  const env = a.env;
  if (env !== "staging" && env !== "prod")
    throw new Error("--env must be staging or prod");
  const pem = await readStdinText();
  // Before the key ceremony (placeholder pinned key) there is no key yet:
  // skip with a notice and <env>_signed=false, so the attach job skips too.
  // Once this env's key is pinned, a missing key fails like any other.
  if (skipUnsigned(env, pem)) {
    process.stderr.write(
      `::notice::${NAME}: no signing key and RELEASE_PUBKEY.${env} is still the placeholder; not signing ${env} (the key ceremony has not run)\n`,
    );
    process.stdout.write(`${env}_signed=false\n`);
    return;
  }
  if (pem.trim() === "") throw new Error("no signing key on stdin");
  /** @type {import("node:crypto").KeyObject} */
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    // Never echo the input.
    throw new Error("the key on stdin is not a PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("the signing key is not Ed25519");
  const pub = createPublicKey(key);
  // L11: a wrong or swapped Environment secret is refused here, not at
  // publish, and so is any key while this env's pin is still the placeholder.
  checkSigningKey(env, String(pub.export({ format: "jwk" }).x));
  const art = await readArtifact(resolve(String(a.dir)));
  const prepared = prepare(art, {
    env,
    version: String(a.version),
    manifestSha256: String(a["manifest-sha256"]),
    bundleSha256: String(a["bundle-sha256"]),
    commit: String(a.commit),
    lockfileSha256: await fileSha256(resolve(String(a.lockfile))),
  });
  const signed = prepared.map((p) => {
    const payload = recordPayload(p.env, p.recordString);
    const signature = sign(null, payload, key).toString("base64url");
    if (!verify(null, payload, pub, Buffer.from(signature, "base64url")))
      throw new Error("the signature does not verify");
    return { p, signature };
  });
  // Nothing is written unless every variant signed.
  const out = resolve(String(a.out));
  await mkdir(out, { recursive: true });
  /** @type {string[]} */
  const lines = [];
  for (const { p, signature } of signed) {
    await writeFile(join(out, `${p.base}.tar`), p.tar, { flag: "wx" });
    await writeFile(join(out, `${p.base}.sig.json`), sigJson(p, signature), {
      flag: "wx",
    });
    const o = `${p.env}_${p.variant}`;
    lines.push(
      `${o}_signature=${signature}`,
      `${o}_tar_sha256=${p.tarSha256}`,
      `${o}_record_sha256=${p.recordSha256}`,
    );
    process.stderr.write(`${NAME}: signed ${p.base} (tar ${p.tarSha256})\n`);
  }
  lines.push(`${env}_signed=true`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

await runMain(NAME, main);
