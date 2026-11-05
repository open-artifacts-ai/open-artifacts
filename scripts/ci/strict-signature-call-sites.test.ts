// #1488: the attach step and the floor assemble must verify fresh signatures
// with verifyCurrentSignature, never the retired-accepting verifySignature.
// While RELEASE_RETIRED_PUBKEYS is empty the two behave the same, so no
// behavioral test can notice a swap. This pins the call sites statically.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = ["scripts/ci/assemble-release.mjs", "scripts/ci/sign-floor.mjs"];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every import declaration, as { from, names: [{ imported, local }] }. */
function imports(src: string) {
  const out: { from: string; names: { imported: string; local: string }[] }[] =
    [];
  const re = /import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const names: { imported: string; local: string }[] = [];
    const clause = m[1];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        const [imported, local] = t.split(/\s+as\s+/).map((s) => s.trim());
        names.push({ imported, local: local ?? imported });
      }
    }
    const rest = clause
      .replace(/\{[\s\S]*\}/, "")
      .replace(/,/g, " ")
      .trim();
    for (const d of rest.split(/\s+/).filter(Boolean)) {
      // default or namespace import: a namespace could reach either function.
      names.push({
        imported: d.startsWith("*") ? "*" : "default",
        local: d.replace(/^\*\s*as\s*/, ""),
      });
    }
    out.push({ from: m[2], names });
  }
  return out;
}

describe("strict signature check at its call sites (#1488)", () => {
  for (const file of FILES) {
    const src = stripComments(readFileSync(join(root, file), "utf8"));
    const fromPubkeys = imports(src)
      .filter((i) => /(^|\/)release-pubkeys\.mjs$/.test(i.from))
      .flatMap((i) => i.names);

    it(`${file} imports verifyCurrentSignature and calls it`, () => {
      const cur = fromPubkeys.find(
        (n) => n.imported === "verifyCurrentSignature",
      );
      expect(
        cur,
        "verifyCurrentSignature must be imported from release-pubkeys.mjs",
      ).toBeDefined();
      expect(src).toMatch(new RegExp(`(^|[^\\w.$])${cur?.local}\\s*\\(`, "m"));
    });

    it(`${file} never imports or calls verifySignature`, () => {
      expect(fromPubkeys.map((n) => n.imported)).not.toContain(
        "verifySignature",
      );
      expect(fromPubkeys.map((n) => n.imported)).not.toContain("*");
      expect(fromPubkeys.map((n) => n.imported)).not.toContain("default");
      expect(src).not.toMatch(/\bverifySignature\b/);
    });
  }
});
