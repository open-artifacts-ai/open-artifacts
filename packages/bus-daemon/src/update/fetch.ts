import { createHash } from "node:crypto";
import { ReleaseError } from "./errors.ts";
import { isVersion, LIMITS, PINS } from "./pins.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type FetchedRelease = {
  version: string;
  tarball: Buffer;
  /** sha512 of `tarball`, hex, computed while streaming. */
  sha512: string;
  /** The parsed attestations document, untrusted until verified. */
  attestations: unknown;
};

export function tarballUrl(version: string): string {
  if (!isVersion(version)) throw new ReleaseError("bad_version", "not x.y.z");
  return `${PINS.registry}/${PINS.packageName}/-/${PINS.tarballName}-${version}.tgz`;
}

export function attestationsUrl(version: string): string {
  if (!isVersion(version)) throw new ReleaseError("bad_version", "not x.y.z");
  return `${PINS.registry}/-/npm/v1/attestations/${encodeURIComponent(PINS.packageName)}@${version}`;
}

// GET one URL on the fixed host: https only, redirects only to the same host
// over https (each hop re-checked), body streamed under a byte cap.
async function get(
  url: string,
  cap: number,
  doFetch: FetchLike,
  wantHash: boolean,
): Promise<{ status: number; body: Buffer; sha512: string }> {
  let current = url;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    const u = new URL(current);
    if (
      u.protocol !== "https:" ||
      u.host !== PINS.registryHost ||
      u.username ||
      u.password
    ) {
      throw new ReleaseError(
        "bad_redirect",
        "not the fixed registry over https",
      );
    }
    let res: Response;
    try {
      res = await doFetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(LIMITS.timeoutMs),
        headers: { accept: "*/*", "accept-encoding": "identity" },
      });
    } catch {
      throw new ReleaseError("fetch_failed", "request failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc)
        throw new ReleaseError("bad_redirect", "redirect without location");
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new ReleaseError("bad_redirect", "unparseable location");
      }
      current = next.href;
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: Buffer.alloc(0), sha512: "" };
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > cap) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError("too_large", "declared size over the cap");
    }
    const hash = wantHash ? createHash("sha512") : null;
    const chunks: Buffer[] = [];
    let total = 0;
    if (!res.body) throw new ReleaseError("fetch_failed", "no body");
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => {});
          throw new ReleaseError("too_large", "body over the cap");
        }
        const buf = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        hash?.update(buf);
        chunks.push(buf);
      }
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      throw new ReleaseError("fetch_failed", "body read failed");
    }
    return {
      status: 200,
      body: Buffer.concat(chunks, total),
      sha512: hash ? hash.digest("hex") : "",
    };
  }
  throw new ReleaseError("bad_redirect", "too many redirects");
}

/** The two registry GETs, and nothing else. */
export async function fetchRelease(
  version: string,
  doFetch: FetchLike = globalThis.fetch,
): Promise<FetchedRelease> {
  const aUrl = attestationsUrl(version);
  const tUrl = tarballUrl(version);
  const att = await get(aUrl, LIMITS.maxAttestationBytes, doFetch, false);
  if (att.status === 404)
    throw new ReleaseError("no_attestation", "registry has none");
  if (att.status !== 200)
    throw new ReleaseError("fetch_failed", `attestations HTTP ${att.status}`);
  let attestations: unknown;
  try {
    attestations = JSON.parse(att.body.toString("utf8"));
  } catch {
    throw new ReleaseError("no_attestation", "not JSON");
  }
  const tgz = await get(tUrl, LIMITS.maxTarballBytes, doFetch, true);
  if (tgz.status !== 200)
    throw new ReleaseError("fetch_failed", `tarball HTTP ${tgz.status}`);
  return { version, tarball: tgz.body, sha512: tgz.sha512, attestations };
}
