import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATES } from "../src/lib/release";

// D7 adversarial review. Runs against the built site: `pnpm test` builds first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const read = (p: string) => readFileSync(join(dist, p), "utf8");
const llms = read("llms.txt");

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return htmlFiles(p);
    return p.endsWith(".html") ? [p] : [];
  });

describe("D7 adversarial", () => {
  // §6.4 + review brief: revoking access doesn't kill an already-minted signed
  // content URL; it stays valid until its 10-minute expiry. Must be documented.
  it("security docs say a signed URL outlives a revoke until it expires", () => {
    const security = read("docs/security.md");
    expect(security).toMatch(/revok|unshar/i);
    expect(security).toMatch(
      /(revok|unshar|remov)[^.]*\b(until|up to)\b[^.]*(10 minutes|expire)/i,
    );
  });

  // The install and upgrade use the latest stable GitHub release, whatever
  // tag prefix release-please uses (see llms.test.ts for the pipeline).
  it("the latest-release lookup doesn't depend on the tag format", () => {
    expect(llms).toContain("/releases/latest");
    expect(llms).not.toContain("ls-remote");
  });

  // Internal TODO comments ship in every published HTML page. Only the
  // release-gate markers (see markers.test.ts) may appear.
  it("no internal TODO comments in the built HTML", () => {
    const allowed = new Set(
      Object.values(GATES).map((g) => `<!-- ${g.todo} -->`),
    );
    for (const f of htmlFiles(dist)) {
      const todos = readFileSync(f, "utf8").match(/<!--\s*TODO[\s\S]*?-->/g);
      for (const todo of todos ?? []) expect(allowed, f).toContain(todo);
    }
  });
});
