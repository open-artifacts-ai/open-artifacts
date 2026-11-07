import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isId, newId, TUNABLES } from "../src/index.js";

const src = (f: string) =>
  readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const idRe = (s: string) => /const ID_RE = (\/.*\/);/.exec(s)?.[1];

describe("tunables", () => {
  it("tunables.ts copies ids.ts's ID_RE exactly", () => {
    expect(idRe(src("tunables.ts"))).toBeDefined();
    expect(idRe(src("tunables.ts"))).toBe(idRe(src("ids.ts")));
  });
  it("PUBLIC_HOME id check matches isId", () => {
    const base = newId();
    for (const v of [
      newId(),
      base.slice(0, 15),
      `${base}x`,
      "short",
      "0OIl0OIl0OIl0OIl",
      "",
    ]) {
      expect(TUNABLES.PUBLIC_HOME?.check(v) === undefined || v === "").toBe(
        isId(v) || v === "",
      );
    }
  });
  it("the free-plan caps: positive integers up to 2^53-1", () => {
    for (const n of [
      "FREE_STORAGE_BYTES",
      "FREE_DATA_DOCS",
      "FREE_DATA_DAILY_WRITES",
    ]) {
      const check = TUNABLES[n]?.check;
      expect(check, n).toBeDefined();
      for (const ok of ["1", String(2 ** 53 - 1)])
        expect(check?.(ok), `${n}=${ok}`).toBeUndefined();
      for (const bad of ["0", "-1", "1.5", String(2 ** 53), "1e3", " 1", "x"])
        expect(check?.(bad), `${n}=${bad}`).toBeTypeOf("string");
    }
  });
});
