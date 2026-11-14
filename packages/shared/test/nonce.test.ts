import { describe, expect, it } from "vitest";
import {
  NONCE_RE,
  parseArtifactMessage,
  withShellNonce,
} from "../src/index.js";

const N = "AbCdEfGhIjKlMnOpQrSt_-";

describe("withShellNonce", () => {
  it("adds #oa= or &oa= to the fragment", () => {
    expect(withShellNonce("https://c.test/a?x=1", N)).toBe(
      `https://c.test/a?x=1#oa=${N}`,
    );
    expect(withShellNonce("https://c.test/a#s", N)).toBe(
      `https://c.test/a#s&oa=${N}`,
    );
    expect(withShellNonce("https://c.test/a#", N)).toBe(
      `https://c.test/a#oa=${N}`,
    );
  });

  it("NONCE_RE is 22 base64url characters", () => {
    expect(NONCE_RE.test(N)).toBe(true);
    expect(NONCE_RE.test(`${N}x`)).toBe(false);
    expect(NONCE_RE.test("AbCdEfGhIjKlMnOpQrSt+/")).toBe(false);
  });
});

describe("ArtifactToShell nonce", () => {
  it("is optional on every message", () => {
    for (const m of [
      { oa: 1, type: "hello", protocol: 1, kind: "html" },
      { oa: 1, type: "call", id: "c", method: "viewer.get", params: {} },
      { oa: 1, type: "resize", height: 1 },
      { oa: 1, type: "pdf.text", version: 1, text: "x" },
    ]) {
      expect(parseArtifactMessage(m)).toEqual(m);
      expect(parseArtifactMessage({ ...m, nonce: N })).toEqual({
        ...m,
        nonce: N,
      });
    }
  });

  it("rejects a non-string or oversized nonce", () => {
    const hello = { oa: 1, type: "hello", protocol: 1, kind: "html" };
    expect(parseArtifactMessage({ ...hello, nonce: 1 })).toBeNull();
    expect(
      parseArtifactMessage({ ...hello, nonce: "x".repeat(65) }),
    ).toBeNull();
  });
});

describe("parseArtifactMessage with unknown top-level keys (#2408)", () => {
  const pin = { oa: 1, type: "comment.pin", pin: { x: 0.5, y: 0.5 } };
  it("drops the unknown key, not the message", () => {
    expect(parseArtifactMessage({ ...pin, later: { a: 1 } })).toEqual(pin);
    expect(parseArtifactMessage({ ...pin, a: 1, b: 2 })).toEqual(pin);
  });
  it("keeps known optional fields", () => {
    const at = { ...pin, at: { x: 1, y: 2 } };
    expect(parseArtifactMessage({ ...at, later: 1 })).toEqual(at);
  });
  it("still refuses a bad value, a nested unknown key and an unknown type", () => {
    expect(
      parseArtifactMessage({ ...pin, pin: { x: 2, y: 0 }, later: 1 }),
    ).toBeNull();
    expect(
      parseArtifactMessage({
        ...pin,
        pin: { x: 0, y: 0, text: "t" },
        later: 1,
      }),
    ).toBeNull();
    expect(parseArtifactMessage({ oa: 1, type: "nope", later: 1 })).toBeNull();
  });
});
