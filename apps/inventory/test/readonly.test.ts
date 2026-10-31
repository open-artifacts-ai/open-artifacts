import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODCLEAN_SQL } from "../src/prodclean.ts";

const dir = new URL("../src/", import.meta.url);
const sources = readdirSync(dir).map(
  (f) => [f, readFileSync(new URL(f, dir), "utf8")] as const,
);

describe("read-only by construction", () => {
  it("src never calls a KV write", () => {
    for (const [f, src] of sources)
      expect(src, f).not.toMatch(/\.put\(|\.delete\(/);
  });

  it("the only D1 write is the prodclean_reports insert, in prodclean.ts", () => {
    expect(PRODCLEAN_SQL).toMatch(/^INSERT INTO prodclean_reports \(/);
    for (const [f, src] of sources) {
      const verbs = [
        ...src.matchAll(
          /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|UPSERT)\b/g,
        ),
      ].map((m) => m[0]);
      // D1's exec takes literal SQL; RegExp#exec does not.
      const runs = [...src.matchAll(/\.(run|batch)\(|\.(exec)\(\s*["'`]/g)].map(
        (m) => m[1] ?? m[2],
      );
      if (f === "prodclean.ts") {
        expect(verbs, f).toEqual(["INSERT"]);
        expect(runs, f).toEqual(["run"]);
      } else {
        expect(verbs, f).toEqual([]);
        expect(runs, f).toEqual([]);
      }
    }
  });
});
