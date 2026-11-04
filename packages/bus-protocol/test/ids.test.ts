import { describe, expect, it } from "vitest";
import {
  formatUserCode,
  isDeviceSecret,
  isId,
  isMachineToken,
  isUserCode,
  newDeviceSecret,
  newId,
  newMachineToken,
  newMsgId,
  newUserCode,
  normalizeUserCode,
} from "../src/ids.ts";

describe("ids", () => {
  it("mints 16 base58 chars and validates them", () => {
    const id = newId();
    expect(id).toHaveLength(16);
    expect(isId(id)).toBe(true);
    expect(isId(`0OIl${id.slice(4)}`)).toBe(false);
    expect(isId(id.slice(1))).toBe(false);
  });
  it("mints oa_machine_ plus 32 base58 chars", () => {
    const t = newMachineToken();
    expect(t).toMatch(/^oa_machine_[1-9A-HJ-NP-Za-km-z]{32}$/);
    expect(isMachineToken(t)).toBe(true);
    expect(isMachineToken(t.replace("oa_machine_", "oa_pat_"))).toBe(false);
    expect(isMachineToken(`${t}x`)).toBe(false);
    // An OpenBus token is a different credential: never accepted here.
    expect(isMachineToken(t.replace("oa_machine_", "ob_machine_"))).toBe(false);
    expect(isMachineToken(t.slice(0, -1))).toBe(false);
  });
  it("mints a 16-char msg id", () => {
    expect(newMsgId()).toHaveLength(16);
    expect(isId(newMsgId())).toBe(true);
  });
  it("mints a 43-char device secret", () => {
    const s = newDeviceSecret();
    expect(s).toHaveLength(43);
    expect(isDeviceSecret(s)).toBe(true);
    expect(isDeviceSecret(s.slice(1))).toBe(false);
  });
  it("mints an 8-char user code from A-Z2-9, shown XXXX-XXXX", () => {
    const raw = newUserCode();
    expect(raw).toMatch(/^[A-Z2-9]{8}$/);
    expect(formatUserCode(raw)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(isUserCode(formatUserCode(raw))).toBe(true);
  });
  it("normalizes typed user codes", () => {
    expect(normalizeUserCode(" ab2c-d3e4 ")).toBe("AB2CD3E4");
    expect(normalizeUserCode("AB2C D3E4")).toBe("AB2CD3E4");
    expect(normalizeUserCode("AB2CD3E")).toBeNull();
    expect(normalizeUserCode("AB2CD3E0")).toBeNull(); // 0 is not in the alphabet
  });
  it("rejects non-ASCII input that Unicode case-folding would alias", () => {
    expect(normalizeUserCode("ABßCD3E")).toBeNull();
    expect(normalizeUserCode("ſBCD2345")).toBeNull();
    expect(normalizeUserCode("ﬀBCD234")).toBeNull();
    expect(normalizeUserCode("AB\u3000CD3E4X")).toBeNull();
  });
  it("accepts only the generation alphabet (no I, O)", () => {
    expect(isUserCode("IOIO-IOIO")).toBe(false);
    expect(normalizeUserCode("IOIOIOIO")).toBeNull();
    for (let i = 0; i < 50; i++)
      expect(isUserCode(formatUserCode(newUserCode()))).toBe(true);
  });
  it("accepts a raw code from newUserCode as a user code", () => {
    for (let i = 0; i < 50; i++) expect(isUserCode(newUserCode())).toBe(true);
    expect(isUserCode("AB2C-D3E4")).toBe(true);
  });
  it("formatUserCode throws on anything but a raw code", () => {
    expect(() => formatUserCode("ABC")).toThrow();
    expect(() => formatUserCode("AB2CD3E4XYZ")).toThrow();
    expect(() => formatUserCode("AB2C-D3E4")).toThrow();
    expect(formatUserCode("AB2CD3E4")).toBe("AB2C-D3E4");
  });
  it("validators reject non-strings that stringify to a valid value", () => {
    const id = newId();
    const t = newMachineToken();
    const d = newDeviceSecret();
    const coerce = (v: string) => ({ toString: () => v });
    for (const [fn, v] of [
      [isId, id],
      [isMachineToken, t],
      [isDeviceSecret, d],
      [isUserCode, formatUserCode(newUserCode())],
    ] as const) {
      expect(fn([v])).toBe(false);
      expect(fn(coerce(v))).toBe(false);
      expect(fn(v)).toBe(true);
    }
    expect(isId(null)).toBe(false);
    expect(isId(undefined)).toBe(false);
  });
});
