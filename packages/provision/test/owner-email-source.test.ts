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
  // signup_secret.owner_email, not installs': read once to create the install;
  // the row is deleted when the create is done, never purged to ''.
  "apps/provisioner/src/workflow.ts": [
    /^\s*"SELECT owner_email AS email FROM signup_secret WHERE signup_id = \?";$/,
  ],
  // The purge (a write).
  "apps/scheduler/src/index.ts": [
    /^\s*"UPDATE installs SET owner_email = '', inputs_hash = '' WHERE state='deleted' AND updated_at < \?1 AND owner_email <> '' RETURNING id";$/,
  ],
  // signup_secret.owner_email, not installs': the row is deleted once the
  // create is done, never purged to ''.
  "apps/provisioning/src/model.ts": [
    // The pending signup's email, read when the installs row has none.
    /^\s*"SELECT owner_email FROM signup_secret WHERE signup_id = \?1",$/,
    // `s` is that signup_secret column (installs' goes through ownerEmailOf).
    /^\s*const s = secret\?\.results\[0\]\?\.owner_email;$/,
  ],
  // R2's q matches the owner email in SQL for a pii caller, never reading
  // it out: a purged '' never contains a non-empty q, and signup_secret's
  // is never purged.
  "apps/provisioning/src/routes/reads.ts": [
    /^\s*"i\.owner_email",$/,
    /^\s*"\(SELECT ss\.owner_email FROM signup_secret ss WHERE ss\.signup_id = st\.signup_id\)",$/,
  ],
  "apps/provisioning/src/routes/create.ts": [
    // The create's write of the signup's email.
    /^\s*"INSERT INTO signup_secret \(signup_id, owner_email\) VALUES \(\?1, \?2\)",$/,
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
