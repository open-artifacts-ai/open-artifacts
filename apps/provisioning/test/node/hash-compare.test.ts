import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 4.1, 9A.3.3: token and session hashes are compared in constant time
// (sameString), never with === or !==.

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(app, p), "utf8");
const HASH = String.raw`(?:token_hash|session_hash|id_hash)`;
const BARE = new RegExp(
  String.raw`${HASH}\s*[!=]==|[!=]==\s*[\w.?]*\b${HASH}\b`,
);

describe("hash compares (static)", () => {
  it("tokens.ts compares token and session hashes with sameString only", () => {
    const src = read("src/services/tokens.ts");
    expect(src).not.toMatch(BARE);
    expect(src.match(/sameString\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("the pattern catches a bare compare", () => {
    expect("a.id_hash !== row.session_hash").toMatch(BARE);
    expect("row.token_hash === h").toMatch(BARE);
    expect("h === row.token_hash").toMatch(BARE);
    expect("sameString(row.token_hash, h)").not.toMatch(BARE);
  });

  it("sameString is a full-length XOR compare, no early exit", () => {
    const src = read("src/auth/crypto.ts");
    const fn = src.slice(src.indexOf("export function sameString"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/Math\.max\(x\.length, y\.length\)/);
    expect(body).not.toMatch(/return false|break/);
  });
});
