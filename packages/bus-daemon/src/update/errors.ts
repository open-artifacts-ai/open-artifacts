// A closed set of reasons, so a report never carries free text from the wire.
export type ReleaseErrorCode =
  | "bad_version"
  | "fetch_failed"
  | "too_large"
  | "bad_redirect"
  | "no_attestation"
  | "bad_tar"
  | "proof_failed"
  | "stale_trust_root"
  | "node_too_old"
  | "wrong_package";

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  constructor(code: ReleaseErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReleaseError";
    this.code = code;
  }
}
