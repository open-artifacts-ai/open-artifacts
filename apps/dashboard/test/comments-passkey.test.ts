import { describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import {
  coolingTime,
  decodeRequestOptions,
  passkeyFailure,
  passkeyLine,
} from "../src/viewer/comments/passkey";

const dom = (name: string) => Object.assign(new Error(name), { name });

describe("passkeyFailure", () => {
  it("maps browser errors", () => {
    expect(passkeyFailure(dom("NotAllowedError")).kind).toBe("cancelled");
    expect(passkeyFailure(dom("TypeError")).kind).toBe("other");
    expect(passkeyFailure(dom("InvalidStateError")).kind).toBe("cancelled");
    expect(passkeyFailure(dom("ConstraintError")).kind).toBe("cancelled");
    expect(
      passkeyLine(
        passkeyFailure(new ApiClientError("passkey_required", "x", 403)),
      )?.text,
    ).toBe("This now needs your passkey. Pick again.");
  });
  it("maps server codes", () => {
    const e = (code: ApiClientError["code"], d?: unknown) =>
      new ApiClientError(code, "x", 409, d);
    expect(passkeyFailure(e("no_passkey")).kind).toBe("no_passkey");
    expect(passkeyFailure(e("passkey_failed")).kind).toBe("failed");
    expect(passkeyFailure(e("challenge_expired")).kind).toBe("expired");
    expect(
      passkeyFailure(
        e("passkey_cooling", { usableAt: "2026-11-13T00:00:00Z" }),
      ),
    ).toEqual({ kind: "cooling", usableAt: "2026-11-13T00:00:00Z" });
    expect(passkeyFailure(e("conflict")).kind).toBe("other");
  });
});

describe("passkeyLine and coolingTime", () => {
  it("has the Design copy", () => {
    expect(passkeyLine({ kind: "cancelled" })).toEqual({
      text: "Nothing was approved.",
      danger: false,
    });
    expect(passkeyLine({ kind: "failed" })?.text).toBe(
      "Passkey check failed. Nothing was approved.",
    );
    expect(passkeyLine({ kind: "too_many" })?.text).toBe(
      "Too many tries. Wait a moment.",
    );
    expect(passkeyLine({ kind: "no_passkey" })).toBeNull();
    expect(passkeyLine({ kind: "other" })).toBeNull();
  });
  it("maps already_answered and 429", () => {
    expect(
      passkeyFailure(new ApiClientError("already_answered", "x", 409)).kind,
    ).toBe("answered");
    expect(
      passkeyFailure(new ApiClientError("rate_limited", "x", 429)).kind,
    ).toBe("too_many");
  });
  it("shows a weekday under 7 days and a date after", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    const soon = coolingTime("2026-11-13T10:00:00Z", now);
    expect(soon?.text).toMatch(/^[A-Za-z]+\.? \d{2}:\d{2}$/);
    expect(soon?.title.length).toBeGreaterThan(soon?.text.length ?? 0);
    expect(coolingTime("2026-12-30T10:00:00Z", now)?.text).not.toMatch(/:/);
    expect(coolingTime(null)).toBeNull();
  });
  it("uses no em dashes", () => {
    for (const k of ["cancelled", "failed", "expired", "too_many"] as const)
      expect(passkeyLine({ kind: k })?.text).not.toContain("\u2014");
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
