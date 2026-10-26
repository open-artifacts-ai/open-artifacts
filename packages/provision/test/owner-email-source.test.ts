// H-DV tripwire: installs.owner_email is read only through ownerEmailOf
// (names.ts), so a purged '' is never used as an address. Comments and
// string literals (SQL) are blanked first; every remaining `owner_email`
// token must be one of the allowlisted sites. Conservative on purpose: a
// new read fails here, and the fix is to call ownerEmailOf.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRS = [
  "packages/provision/src",
  "apps/scheduler/src",
  "scripts/hosted/src",
  "apps/dispatch/src",
  "apps/auth-broker/src",
  "apps/directory-broker/src",
  "apps/inventory/src",
];

const blank = (s: string) =>
  s.replace(
    // Template literals are kept: a read can hide in ${...}.
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    (m) => m.replace(/[^\n]/g, " "),
  );

function files(dir: string): string[] {
  const abs = join(ROOT, dir);
  let out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  for (const n of names) {
    const p = join(abs, n);
    if (statSync(p).isDirectory()) out = out.concat(files(relative(ROOT, p)));
    else if (/\.(?:ts|mjs|js)$/.test(n)) out.push(relative(ROOT, p));
  }
  return out;
}

/** file: the code lines (after blanking) allowed to mention owner_email. */
const ALLOWED: Record<string, RegExp[]> = {
  // The InstallRow field declaration (a type, not a read).
  "packages/provision/src/platform.ts": [
    /^\s*owner_email: string \| null;$/,
    // insertCreating's column list (a write).
    /^\s*sql: `INSERT INTO installs \(id, slug, app_host, content_host, owner_email, /,
  ],
  // The one reader.
  "packages/provision/src/names.ts": [
    /^\s*const v = row\.owner_email;$/,
    /^export function ownerEmailOf\(row: \{ owner_email\?: unknown \}\): string \| null \{$/,
  ],
};

describe("owner_email is read only through ownerEmailOf", () => {
  it("no other code mentions owner_email", () => {
    const bad: string[] = [];
    for (const f of DIRS.flatMap(files)) {
      const lines = blank(readFileSync(join(ROOT, f), "utf8")).split("\n");
      lines.forEach((l, i) => {
        if (!/\bowner_email\b/.test(l)) return;
        if ((ALLOWED[f] ?? []).some((re) => re.test(l))) return;
        bad.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("the tripwire sees a raw read", () => {
    const l = blank(
      "const e = row.owner_email ?? '';\nconst q = \"SELECT owner_email\";",
    );
    expect(l.split("\n")[0]).toMatch(/\bowner_email\b/);
    expect(l.split("\n")[1]).not.toMatch(/\bowner_email\b/);
  });
});
