// Proof check for a downloaded release. Fully offline: the Sigstore chain
// (Fulcio CA, SCT, Rekor inclusion against the embedded log keys, certificate
// valid at the logged time) comes from @sigstore/verify and the embedded trusted
// root; this file adds the pins and ties the signed digest to the exact bytes.
import { createHash, timingSafeEqual } from "node:crypto";
import { bundleFromJSON } from "@sigstore/bundle";
import { toSignedEntity, Verifier } from "@sigstore/verify";
import { ReleaseError } from "./errors.ts";
import type { FetchedRelease } from "./fetch.ts";
import {
  compareVersions,
  isVersion,
  MIN_COMMIT_VERSION,
  PINS,
  type Pins,
} from "./pins.ts";
import { readTarball, type TarEntry } from "./tar.ts";
import {
  EMBEDDED_ROOT,
  type RootJson,
  rootIsLive,
  toMaterial,
} from "./trusted-root.ts";

// Fulcio certificate extensions (1.3.6.1.4.1.57264.1.<n>).
const OID_PREFIX = [1, 3, 6, 1, 4, 1, 57264, 1];
const OID = {
  buildSignerUri: 9,
  buildSignerDigest: 10,
  runnerEnvironment: 11,
  sourceRepositoryUri: 12,
  sourceRepositoryDigest: 13,
  sourceRepositoryRef: 14,
  sourceRepositoryId: 15,
  sourceOwnerUri: 16,
  sourceOwnerId: 17,
  buildConfigUri: 18,
  buildConfigDigest: 19,
  buildTrigger: 20,
  runInvocationUri: 21,
} as const;

/** The Node range @sigstore/verify 4.1.3 declares in its package.json `engines`. */
export const SIGSTORE_NODE_RANGE = "^22.22.2 || ^24.15.0 || >=26";

/** True when `version` (e.g. process.versions.node) is inside SIGSTORE_NODE_RANGE. */
export function nodeSupportsSigstore(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const atLeast = (a: number, b: number, c: number): boolean =>
    min > b || (min === b && pat >= c) ? maj === a : false;
  if (maj >= 26) return true;
  if (maj === 24) return atLeast(24, 15, 0);
  if (maj === 22) return atLeast(22, 22, 2);
  return false;
}

export type VerifyOptions = {
  /** Tests only: the Node version to gate on; defaults to the running one. */
  nodeVersion?: string;
  now?: Date;
  /** Tests only: a different trust root. */
  root?: RootJson;
  /** Tests only: the production caller never passes pins. */
  pins?: Pins;
};

export type VerifiedRelease = {
  version: string;
  sha512: string;
  commit: string;
  entries: TarEntry[];
  packageJson: Record<string, unknown>;
};

function fail(detail: string): never {
  throw new ReleaseError("proof_failed", detail);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A Fulcio v2 extension value is the DER of a UTF8String: tag 0x0c, short or
// long length, then the text.
function derUtf8(value: Uint8Array): string | undefined {
  const b = Buffer.from(value);
  if (b[0] !== 0x0c || b.length < 2) return undefined;
  let len = b[1] as number;
  let at = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2 || b.length < 2 + n) return undefined;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (b[2 + i] as number);
    at = 2 + n;
  }
  if (at + len !== b.length) return undefined;
  return b.subarray(at).toString("utf8");
}

function oidText(
  oids: { oid?: { id: number[] }; value: Uint8Array }[],
  n: number,
): string {
  const hits = oids.filter(
    (o) =>
      o.oid &&
      o.oid.id.length === OID_PREFIX.length + 1 &&
      OID_PREFIX.every((v, i) => o.oid?.id[i] === v) &&
      o.oid.id[OID_PREFIX.length] === n,
  );
  if (hits.length !== 1)
    return fail(`certificate extension .${n} missing or repeated`);
  const text = derUtf8((hits[0] as { value: Uint8Array }).value);
  if (text === undefined) return fail(`certificate extension .${n} unreadable`);
  return text;
}

// Both sides must be lowercase hex (as `sha512` and the statement are).
function sameHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Picks the single SLSA provenance bundle out of the registry's attestations document. */
function provenanceBundle(attestations: unknown, pins: Pins): unknown {
  if (!isObj(attestations) || !Array.isArray(attestations.attestations)) {
    throw new ReleaseError("no_attestation", "no attestations list");
  }
  const hits = attestations.attestations.filter(
    (a) => isObj(a) && a.predicateType === pins.predicateType,
  );
  if (hits.length !== 1)
    throw new ReleaseError("no_attestation", "no single provenance");
  const bundle = (hits[0] as Obj).bundle;
  if (!isObj(bundle))
    throw new ReleaseError("no_attestation", "provenance without bundle");
  return bundle;
}

type OidPair = { oid?: { id: number[] }; value: Uint8Array };

/** The Fulcio extensions against the pins; returns the certificate's source commit. */
export function checkCertificateOids(
  oids: OidPair[],
  pins: Pins,
  san: string,
): string {
  const eq = (n: number, want: string, label: string): void => {
    if (oidText(oids, n) !== want) fail(`${label} mismatch`);
  };
  eq(OID.sourceRepositoryId, pins.repoId, "repository id");
  eq(OID.sourceOwnerId, pins.ownerId, "owner id");
  eq(OID.sourceRepositoryUri, pins.repoUrl, "repository");
  eq(OID.sourceOwnerUri, pins.ownerUrl, "owner");
  eq(OID.sourceRepositoryRef, pins.ref, "ref");
  eq(OID.buildTrigger, pins.trigger, "trigger");
  eq(OID.buildConfigUri, san, "build config");
  eq(OID.runnerEnvironment, pins.runnerEnvironment, "runner");
  const certCommit = oidText(oids, OID.sourceRepositoryDigest);
  if (!/^[0-9a-f]{40}$/.test(certCommit)) fail("certificate commit malformed");
  eq(OID.buildSignerUri, san, "build signer");
  eq(OID.buildSignerDigest, certCommit, "build signer digest");
  eq(OID.buildConfigDigest, certCommit, "build config digest");
  if (
    !oidText(oids, OID.runInvocationUri).startsWith(
      `${pins.repoUrl}/actions/runs/`,
    )
  ) {
    fail("run invocation mismatch");
  }
  return certCommit;
}

/** What the verified package.json must say about itself. */
export function checkManifest(
  pkg: Obj,
  pins: Pins,
  version: string,
  certCommit: string,
): void {
  if (pkg.name !== pins.packageName)
    throw new ReleaseError("wrong_package", "name differs");
  if (pkg.version !== version)
    throw new ReleaseError("wrong_package", "version differs");
  // Only the commit is read; any `tag` field is ignored.
  const meta = isObj(pkg.oaBus) ? pkg.oaBus : undefined;
  const mustCarry = compareVersions(version, MIN_COMMIT_VERSION) >= 0;
  const commit = meta?.commit;
  if (commit === undefined) {
    if (mustCarry) throw new ReleaseError("wrong_package", "no oaBus commit");
    return;
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new ReleaseError("wrong_package", "oaBus commit malformed");
  }
  if (commit !== certCommit) {
    throw new ReleaseError(
      "wrong_package",
      "commit differs from the certificate",
    );
  }
}

export function verifyRelease(
  rel: FetchedRelease,
  opts: VerifyOptions = {},
): VerifiedRelease {
  const pins = opts.pins ?? (PINS as Pins);
  const now = opts.now ?? new Date();
  const root = opts.root ?? EMBEDDED_ROOT;
  const version = rel.version;
  if (!isVersion(version)) throw new ReleaseError("bad_version", "not x.y.z");
  // No proof attempt on a Node the Sigstore library does not support.
  if (!nodeSupportsSigstore(opts.nodeVersion ?? process.versions.node)) {
    throw new ReleaseError(
      "node_too_old",
      `needs Node ${SIGSTORE_NODE_RANGE}; update by hand`,
    );
  }

  // The digest we compare is computed here, over the very buffer that is
  // unpacked below; the streamed one from fetch must agree.
  const sha512 = createHash("sha512").update(rel.tarball).digest("hex");
  if (rel.sha512 !== sha512) fail("streamed digest differs from the bytes");

  if (!rootIsLive(root, now)) {
    throw new ReleaseError(
      "stale_trust_root",
      "this build's Sigstore roots have expired; update by hand",
    );
  }

  const bundleJson = provenanceBundle(rel.attestations, pins);
  let bundle: ReturnType<typeof bundleFromJSON>;
  try {
    bundle = bundleFromJSON(bundleJson);
  } catch {
    return fail("bundle does not parse");
  }
  const content = bundle.verificationMaterial.content.$case;
  if (content !== "certificate" && content !== "x509CertificateChain") {
    return fail("bundle is not certificate-signed");
  }
  if (bundle.verificationMaterial.tlogEntries.length < 1)
    fail("no transparency log entry");
  if (bundle.content.$case !== "dsseEnvelope") fail("not a DSSE envelope");
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== pins.payloadType)
    fail("unexpected payload type");

  const san = `${pins.repoUrl}/${pins.workflowPath}@${pins.ref}`;
  let signer: ReturnType<Verifier["verify"]>;
  try {
    signer = new Verifier(toMaterial(root), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
      timestampThreshold: 1,
    }).verify(toSignedEntity(bundle), {
      subjectAlternativeName: san,
      extensions: { issuer: pins.oidcIssuer },
    });
  } catch (err) {
    return fail(`sigstore: ${(err as { code?: string }).code ?? "error"}`);
  }
  const id = signer.identity;
  if (!id || id.subjectAlternativeName !== san) fail("identity mismatch");
  if (id.extensions?.issuer !== pins.oidcIssuer) fail("issuer mismatch");
  const certCommit = checkCertificateOids(id.oids ?? [], pins, san);

  // The statement, from the envelope whose signature just verified.
  let statement: Obj;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(envelope.payload).toString("utf8"),
    );
    if (!isObj(parsed)) return fail("statement not an object");
    statement = parsed;
  } catch {
    return fail("statement not JSON");
  }
  if (statement._type !== pins.statementType) fail("statement type");
  if (statement.predicateType !== pins.predicateType) fail("predicate type");
  const subjects = statement.subject;
  if (!Array.isArray(subjects) || subjects.length !== 1 || !isObj(subjects[0]))
    fail("subject count");
  const subject = (subjects as Obj[])[0] as Obj;
  if (subject.name !== `${pins.purlName}@${version}`)
    fail("subject names another package or version");
  const digest = subject.digest;
  if (
    !isObj(digest) ||
    typeof digest.sha512 !== "string" ||
    !sameHex(digest.sha512, sha512)
  ) {
    fail("signed digest does not cover these bytes");
  }
  const predicate = statement.predicate;
  const def = isObj(predicate) ? predicate.buildDefinition : undefined;
  if (!isObj(def)) return fail("no build definition");
  const ext = isObj(def.externalParameters) ? def.externalParameters : {};
  const wf = isObj(ext.workflow) ? ext.workflow : {};
  if (
    wf.ref !== pins.ref ||
    wf.repository !== pins.repoUrl ||
    wf.path !== pins.workflowPath
  ) {
    fail("workflow parameters mismatch");
  }
  const intl = isObj(def.internalParameters) ? def.internalParameters : {};
  const gh = isObj(intl.github) ? intl.github : {};
  if (
    gh.repository_id !== pins.repoId ||
    gh.repository_owner_id !== pins.ownerId ||
    gh.event_name !== pins.trigger
  ) {
    fail("github parameters mismatch");
  }
  const deps = def.resolvedDependencies;
  const dep =
    Array.isArray(deps) && isObj(deps[0]) && isObj(deps[0].digest)
      ? deps[0].digest
      : {};
  if (dep.gitCommit !== certCommit)
    fail("statement commit differs from the certificate");
  const run =
    isObj(predicate) && isObj(predicate.runDetails) ? predicate.runDetails : {};
  const builder = isObj(run.builder) ? run.builder : {};
  if (builder.id !== pins.builderId) fail("not a GitHub-hosted runner");

  // The bytes are now authentic. Read them strictly, from the same buffer.
  const entries = readTarball(rel.tarball);
  const pkgEntry = entries.find((e) => e.path === "package/package.json");
  if (!pkgEntry) throw new ReleaseError("wrong_package", "no package.json");
  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgEntry.data.toString("utf8"));
  } catch {
    throw new ReleaseError("wrong_package", "package.json not JSON");
  }
  if (!isObj(pkg))
    throw new ReleaseError("wrong_package", "package.json not an object");
  checkManifest(pkg, pins, version, certCommit);
  return { version, sha512, commit: certCommit, entries, packageJson: pkg };
}
