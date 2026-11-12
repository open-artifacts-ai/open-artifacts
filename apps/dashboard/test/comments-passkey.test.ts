import { describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import {
  canRetry,
  decodeRequestOptions,
  passkeyCopy,
  passkeyFailure,
} from "../src/viewer/comments/passkey";

const dom = (name: string) => Object.assign(new Error(name), { name });

describe("passkeyFailure", () => {
  it("maps browser errors", () => {
    expect(passkeyFailure(dom("NotAllowedError")).kind).toBe("cancelled");
    expect(passkeyFailure(dom("TypeError")).kind).toBe("other");
  });
  it("maps server codes", () => {
    const e = (code: ApiClientError["code"], d?: unknown) =>
      new ApiClientError(code, "x", 409, d);
    expect(passkeyFailure(e("no_passkey")).kind).toBe("no_passkey");
    expect(passkeyFailure(e("passkey_failed")).kind).toBe("failed");
    expect(passkeyFailure(e("challenge_expired")).kind).toBe("expired");
    expect(
      passkeyFailure(e("passkey_cooling", { until: "2026-11-13T00:00:00Z" })),
    ).toEqual({ kind: "cooling", until: "2026-11-13T00:00:00Z" });
    expect(passkeyFailure(e("conflict")).kind).toBe("other");
  });
});

describe("passkeyCopy", () => {
  it("has copy for passkey states and none for others", () => {
    expect(passkeyCopy({ kind: "no_passkey" })).toMatch(/Add a passkey/);
    expect(
      passkeyCopy({ kind: "cooling", until: "2026-11-13T00:00:00Z" }),
    ).toMatch(/can approve from/);
    expect(passkeyCopy({ kind: "other" })).toBeNull();
    for (const k of ["cancelled", "failed", "expired"] as const)
      expect(canRetry({ kind: k })).toBe(true);
    expect(canRetry({ kind: "no_passkey" })).toBe(false);
  });
  it("uses no em dashes", () => {
    for (const k of ["cancelled", "failed", "expired", "no_passkey"] as const)
      expect(passkeyCopy({ kind: k })).not.toContain("—");
  });
});

describe("decodeRequestOptions", () => {
  it("decodes base64url without parseRequestOptionsFromJSON", () => {
    const pk = globalThis as unknown as { PublicKeyCredential?: unknown };
    const saved = pk.PublicKeyCredential;
    pk.PublicKeyCredential = class {};
    try {
      const o = decodeRequestOptions({
        challenge: "AQID_w",
        allowCredentials: [{ id: "BAU", type: "public-key" }],
      });
      expect([...new Uint8Array(o.challenge as ArrayBuffer)]).toEqual([
        1, 2, 3, 255,
      ]);
      expect([
        ...new Uint8Array(o.allowCredentials?.[0]?.id as ArrayBuffer),
      ]).toEqual([4, 5]);
    } finally {
      pk.PublicKeyCredential = saved;
    }
  });
});
