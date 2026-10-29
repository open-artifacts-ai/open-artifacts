// H-DV tripwire: installs.owner_email is read only through ownerEmailOf
// (names.ts), so a purged '' is never used as an address. Every apps/*/src
// and packages/*/src file is scanned with comments blanked and strings kept
// (a read can hide in "owner_email" as a bracket key, a SELECT, or a
// template); every `owner_email` left must be one of the allowlisted lines.
// Conservative on purpose: anything new fails, and the fix is ownerEmailOf.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every apps/<x>/src and packages/<x>/src (there must be some of each). */
function srcDirs(): string[] {
  const out: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const n of readdirSync(join(ROOT, top))) {
      const d = join(top, n, "src");
      if (existsSync(join(ROOT, d))) out.push(d);
    }
  }
  return out;
}

const blankComments = (s: string) =>
  s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function files(dir: string): string[] {
  let out: string[] = [];
  for (const n of readdirSync(join(ROOT, dir))) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) out = out.concat(files(p));
    else if (/\.(?:ts|tsx|mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}

/** file: the code lines allowed to mention owner_email. */
const ALLOWED: Record<string, RegExp[]> = {
  // The InstallRow field (a type), and insertCreating's column list (a write).
  "packages/provision/src/platform.ts": [
    /^\s*owner_email: string \| null;$/,
    /^\s*sql: `INSERT INTO installs \(id, slug, app_host, content_host, owner_email, /,
  ],
  // The one reader.
  "packages/provision/src/names.ts": [
    /^\s*const v = row\.owner_email;$/,
    /^export function ownerEmailOf\(row: \{ owner_email\?: unknown \}\): string \| null \{$/,
  ],
  // The signups consumer's signup_secret insert (a write, not installs).
  "apps/provisioner/src/consumer.ts": [
    /^\s*`INSERT OR IGNORE INTO signup_secret \(signup_id, owner_email\)$/,
  ],
  // The purge (a write).
  "apps/scheduler/src/index.ts": [
    /^\s*"UPDATE installs SET owner_email = '', inputs_hash = '' WHERE state='deleted' AND updated_at < \?1 AND owner_email <> '' RETURNING id";$/,
  ],
};

const offenders = (f: string, text: string) =>
  blankComments(text)
    .split("\n")
    .flatMap((l, i) =>
      /owner_email/.test(l) && !(ALLOWED[f] ?? []).some((re) => re.test(l))
        ? [`${f}:${i + 1}: ${l.trim()}`]
        : [],
    );

describe("owner_email is read only through ownerEmailOf", () => {
  it("scans every apps/*/src and packages/*/src, including the platform ones", () => {
    const dirs = srcDirs();
    for (const d of [
      "packages/provision/src",
      "apps/scheduler/src",
      "apps/dispatch/src",
      "apps/auth-broker/src",
      "apps/directory-broker/src",
      "apps/inventory/src",
      "apps/server/src",
    ])
      expect(dirs).toContain(d);
    // scripts/hosted has no src of the apps/packages shape: scanned on its own.
    expect(existsSync(join(ROOT, "scripts/hosted/src"))).toBe(true);
  });

  it("no other code mentions owner_email", () => {
    const bad = [...srcDirs(), "scripts/hosted/src"]
      .flatMap(files)
      .flatMap((f) => offenders(f, readFileSync(join(ROOT, f), "utf8")));
    expect(bad).toEqual([]);
  });

  it("every allowlisted line still exists (a stale allowlist fails)", () => {
    for (const [f, res] of Object.entries(ALLOWED)) {
      const lines = blankComments(readFileSync(join(ROOT, f), "utf8")).split(
        "\n",
      );
      for (const re of res)
        expect(
          lines.some((l) => re.test(l)),
          `${f} ${re}`,
        ).toBe(true);
    }
  });

  it("the tripwire sees a bracket key, a SELECT in a string, a template and a destructuring", () => {
    for (const src of [
      'const e = row["owner_email"];',
      'db.prepare("SELECT owner_email FROM installs")',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test
      "const t = `${row.owner_email}`;",
      "const { owner_email } = row;",
    ])
      expect(offenders("x.ts", src)).toHaveLength(1);
    expect(offenders("x.ts", "// owner_email in a comment")).toEqual([]);
  });
});
