// Refreshes src/update/trusted-root.json from Sigstore's public-good TUF
// repository (GET only): timestamp -> snapshot -> targets -> the consistent-
// snapshot file named by its sha256. The length and sha256 listed in the
// targets metadata are checked. TUF signatures are NOT checked here: a person
// reviews the diff of the committed file, which is the real gate.
// Usage: node scripts/refresh-trusted-root.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const base = "https://tuf-repo-cdn.sigstore.dev";
const get = async (path) => {
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const json = async (path) => JSON.parse((await get(path)).toString("utf8"));

const ts = await json("timestamp.json");
const snap = await json(
  `${ts.signed.meta["snapshot.json"].version}.snapshot.json`,
);
const targets = await json(
  `${snap.signed.meta["targets.json"].version}.targets.json`,
);
const info = targets.signed.targets["trusted_root.json"];
const sha256 = info.hashes.sha256;
const body = await get(`targets/${sha256}.trusted_root.json`);
if (body.length !== info.length)
  throw new Error("trusted_root.json: length mismatch");
if (createHash("sha256").update(body).digest("hex") !== sha256) {
  throw new Error("trusted_root.json: sha256 mismatch");
}
const root = JSON.parse(body.toString("utf8"));
root._source = {
  note: "Sigstore public-good trusted_root.json from the TUF repository; refresh with scripts/refresh-trusted-root.mjs and review the diff.",
  repository: base,
  targetsVersion: snap.signed.meta["targets.json"].version,
  sha256,
};
writeFileSync(
  join(import.meta.dirname, "../src/update/trusted-root.json"),
  `${JSON.stringify(root, null, 2)}\n`,
);
console.log(`trusted-root.json written (sha256 ${sha256})`);
