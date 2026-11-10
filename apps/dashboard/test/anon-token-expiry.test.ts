import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANON_ID_KEY,
  loadAnonToken,
  resetAnonMemory,
  saveAnonToken,
} from "../src/viewer/anonId";

const ID = "A".repeat(22);
const SIG = "B".repeat(43);
const tok = (ageS: number) =>
  `${ID}.${Math.floor(Date.now() / 1000 - ageS).toString(36)}.${SIG}`;
const DAY = 86_400;

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAnonMemory();
});

describe("loadAnonToken expiry", () => {
  it("returns a current token", () => {
    const t = tok(29 * DAY);
    saveAnonToken(t);
    expect(loadAnonToken()).toBe(t);
  });

  it("treats an expired token as missing, so the mint goes through the lock", () => {
    saveAnonToken(tok(31 * DAY));
    expect(loadAnonToken()).toBeNull();
    localStorage.setItem(ANON_ID_KEY, tok(31 * DAY));
    expect(loadAnonToken()).toBeNull();
  });

  it("keeps a v1 token (the server decides)", () => {
    const v1 = `${ID}.${SIG}`;
    saveAnonToken(v1);
    expect(loadAnonToken()).toBe(v1);
  });
});
