// The Sigstore public-good trust root, embedded: no TUF, no network. The file
// is refreshed by scripts/refresh-trusted-root.mjs and its expiry is watched by
// a test that fails 30 days before any key or CA runs out.
import { X509Certificate } from "node:crypto";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { type TrustMaterial, toTrustMaterial } from "@sigstore/verify";
import embedded from "./trusted-root.json" with { type: "json" };

export type RootJson = Record<string, unknown>;

export const EMBEDDED_ROOT: RootJson = embedded as RootJson;

export type Validity = { start?: Date; end?: Date };

type ProtoRoot = ReturnType<typeof TrustedRoot.fromJSON>;

function window(v: { start?: Date; end?: Date } | undefined): Validity {
  return { start: v?.start, end: v?.end };
}

export function parseRoot(json: RootJson): ProtoRoot {
  const { _source: _ignored, ...rest } = json;
  return TrustedRoot.fromJSON(rest);
}

export function toMaterial(json: RootJson): TrustMaterial {
  return toTrustMaterial(parseRoot(json));
}

const liveAt = (v: Validity, now: Date): boolean =>
  (!v.start || v.start <= now) && (!v.end || v.end > now);

/** Validity windows of every authority in a root, for the liveness check and the expiry test. */
export function authorityWindows(json: RootJson): {
  tlogs: Validity[];
  cas: Validity[];
  ctlogs: Validity[];
  caCerts: { windows: Validity[] }[];
} {
  const root = parseRoot(json);
  return {
    tlogs: root.tlogs.map((t) => window(t.publicKey?.validFor)),
    ctlogs: root.ctlogs.map((t) => window(t.publicKey?.validFor)),
    cas: root.certificateAuthorities.map((c) => window(c.validFor)),
    caCerts: root.certificateAuthorities.map((c) => ({
      windows: (c.certChain?.certificates ?? []).map((cert) => {
        const x = new X509Certificate(Buffer.from(cert.rawBytes));
        return { start: new Date(x.validFrom), end: new Date(x.validTo) };
      }),
    })),
  };
}

/**
 * True when the embedded root has, at `now`, a live transparency log, a live
 * certificate transparency log and a CA whose whole chain is within its dates.
 * False means this build is too old to prove anything: a distinct failure.
 */
export function rootIsLive(json: RootJson, now: Date): boolean {
  const w = authorityWindows(json);
  const caLive = w.cas.some(
    (c, i) =>
      liveAt(c, now) &&
      (w.caCerts[i]?.windows ?? []).every((x) => liveAt(x, now)),
  );
  return (
    w.tlogs.some((v) => liveAt(v, now)) &&
    w.ctlogs.some((v) => liveAt(v, now)) &&
    caLive
  );
}
