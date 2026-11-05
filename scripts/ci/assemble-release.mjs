// @ts-check
// hosted-attach (T3b): rebuilds the signed release files from the artifact
// and hosted-sign's outputs, for `gh release upload`. The sign job may only
// use checkout and download-artifact, so it hands over the signature and
// the sha256 of the tar and the record; this rebuilds both from the same
// verified bytes, refuses unless they hash the same, and verifies each
// signature against the pinned key (L11). No key here. node:* imports only.
// Usage: node scripts/ci/assemble-release.mjs --dir <artifact> --env <env>
//   --version <v> --manifest-sha256 <h> --bundle-sha256 <h> --commit <sha>
//   --lockfile pnpm-lock.yaml --out <dir>
//   --release <sig>:<tar sha256>:<record sha256>
//   [--redline <sig>:<tar sha256>:<record sha256>]
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fileSha256,
  parseArgs,
  prepare,
  readArtifact,
  recordPayload,
  runMain,
  sigJson,
} from "./release-artifact.mjs";
import { verifySignature } from "./release-pubkeys.mjs";

const NAME = "assemble-release";
const REQUIRED = [
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
  const a = parseArgs(process.argv.slice(2), [
    ...REQUIRED,
    "release",
    "redline",
  ]);
  for (const k of REQUIRED) if (!a[k]) throw new Error(`--${k} is required`);
  const env = a.env;
  if (env !== "staging" && env !== "prod")
    throw new Error("--env must be staging or prod");
  const art = await readArtifact(resolve(String(a.dir)));
  const prepared = prepare(art, {
    env,
    version: String(a.version),
    manifestSha256: String(a["manifest-sha256"]),
    bundleSha256: String(a["bundle-sha256"]),
    commit: String(a.commit),
    lockfileSha256: await fileSha256(resolve(String(a.lockfile))),
  });
  const variants = new Set(prepared.map((p) => p.variant));
  for (const v of /** @type {const} */ (["release", "redline"]))
    if (a[v] !== undefined && !variants.has(v))
      throw new Error(`--${v} is not signed for ${env}`);
  const files = prepared.map((p) => {
    const m = /^([A-Za-z0-9_-]{86}):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(
      a[p.variant] ?? "",
    );
    if (!m)
      throw new Error(
        `--${p.variant} needs <signature>:<tar sha256>:<record sha256>`,
      );
    const signature = String(m[1]);
    if (m[2] !== p.tarSha256)
      throw new Error(`the ${p.variant} tar is not the one hosted-sign signed`);
    if (m[3] !== p.recordSha256)
      throw new Error(
        `the ${p.variant} record is not the one hosted-sign signed`,
      );
    // L11: verified against the pinned key before anything is written
    // (refused outright while the pin is still the placeholder).
    verifySignature(env, recordPayload(env, p.recordString), signature);
    return { p, signature };
  });
  const out = resolve(String(a.out));
  await mkdir(out, { recursive: true });
  for (const { p, signature } of files) {
    await writeFile(join(out, `${p.base}.tar`), p.tar, { flag: "wx" });
    await writeFile(join(out, `${p.base}.sig.json`), sigJson(p, signature), {
      flag: "wx",
    });
    console.log(`${NAME}: ${p.base}.tar and .sig.json`);
  }
}

await runMain(NAME, main);
