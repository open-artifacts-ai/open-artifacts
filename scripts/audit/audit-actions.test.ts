import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  actionPhrase,
} from "../../apps/admin/src/pages/audit-actions";

// This lives in the root suite, not in apps/admin, on purpose (#1353): it reads
// five packages' sources with fs, which leaves no import for pnpm's
// affected-only PR selection to follow, so inside a package it never ran on the
// changes it checks. The root suite runs on every pull request. It imports
// admin's plain-data audit-actions.ts, not the page, so the root tsconfig can
// typecheck it. Moving it back under a package brings that gap back. It is on
// scripts/ci/private-paths.txt, because every path it reads is private (#1056).
// R17 filters on one exact action, so an option nothing writes returns nothing
// for ever: it happened with the install.* names. This reads the writers.
const repo = resolve(__dirname, "../..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
/**
 * Every captured group of every match, across the dir's .ts files. Loud, not
 * empty (#1250): a scanned directory that moved, or one that no longer yields
 * anything, throws, so a path change can't quietly hide every writer in it.
 */
const scan = (dir: string, patterns: RegExp[]) => {
  const root = join(repo, dir);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`audit-actions: ${dir} is not a directory; did it move?`);
  const out = new Set<string>();
  for (const f of files(root)) {
    const text = readFileSync(f, "utf8");
    for (const re of patterns)
      for (const m of text.matchAll(re))
        for (const g of m.slice(1)) if (g) out.add(g);
  }
  if (out.size === 0)
    throw new Error(
      `audit-actions: nothing in ${dir} matches ${patterns.join(" ")}; did its writers move?`,
    );
  return out;
};
const NAME = "([a-z_]+\\.[a-z_]+)";

/** Every admin_audit action, and the two rows that end a job in hosted_audit. */
const apiWritten = () =>
  new Set([
    ...scan("apps/provisioning/src", [
      new RegExp(`\\baction: "${NAME}"`, "g"),
      new RegExp(`action \\?\\? "${NAME}"`, "g"),
      new RegExp(`=== "oauth" \\? "${NAME}"`, "g"),
      new RegExp(`\\? "oauth\\.grant" : "${NAME}"`, "g"),
      new RegExp(`AUDIT_INSERT\\}[^\`]*?'${NAME}'`, "g"),
    ]),
    ...scan("apps/provisioner/src", [/^\s+"(job\.[a-z]+)",$/gm]),
  ]);

/** The kinds pause and unpause take (their HOSTS row is `<kind>.hosts`). */
const hostKinds = () =>
  scan("apps/provisioner/src", [/\.(?:un)?pause\([^;]*?kind: "([a-z_]+)"/g]);
/** The operations a lock is claimed for, plus those kinds (setMode claims as its kind). */
const lockOps = () =>
  new Set([
    ...scan("packages/provision/src", [
      /this\.claim\([^;]*?"([a-z_-]+)",?\s*\)/g,
    ]),
    ...hostKinds(),
  ]);

/** hosted_audit's step rows: the provisioner package, its jobs and the scheduler. */
const stepsWritten = () => {
  const out = new Set([
    ...scan("packages/provision/src", [
      new RegExp(`logged\\(\\s*"${NAME}"`, "g"),
      new RegExp(`\\.audit\\(\\s*[^,]+,\\s*"${NAME}"`, "g"),
      new RegExp(
        `\\.audit\\(\\s*[^,]+,\\s*[a-z]+ \\? "${NAME}" : "${NAME}"`,
        "g",
      ),
      new RegExp(`INSERT INTO hosted_audit[^"]*?'${NAME}'`, "g"),
    ]),
    ...scan("apps/provisioner/src", [
      new RegExp(`auditStatement\\(\\s*[^,]+,\\s*[^,]+,\\s*"${NAME}"`, "g"),
    ]),
    // The provisioner's named actions (OAUTH_MODE_LIVE_ACTION and the like).
    ...scan("packages/provisioning-contract/src", [
      new RegExp(`export const [A-Z_]+_ACTION = "${NAME}"`, "g"),
    ]),
    ...scan("apps/scheduler/src", [
      new RegExp(`INSERT INTO hosted_audit[^\`]*?'${NAME}'`, "g"),
    ]),
  ]);
  const wfp = readFileSync(join(repo, "packages/provision/src/wfp.ts"), "utf8");
  // Templated: `${h.op}.lost_lease`, `${h.op}.aborted`, `${k.kind}.hosts`.
  for (const t of ["lost_lease", "aborted"])
    if (wfp.includes(`\`\${h.op}.${t}\``))
      for (const op of lockOps()) out.add(`${op}.${t}`);
  if (wfp.includes("`${k.kind}.hosts`"))
    for (const k of hostKinds()) out.add(`${k}.hosts`);
  return out;
};

/** audit_refusals' rows: `<bucket>.refused`, or rate_limited (R17's union). */
const refusalsWritten = () => {
  const call = "(?:refuse|countRefusal|count)\\(\\s*env,\\s*";
  const out = new Set(
    [
      ...scan("apps/provisioning/src", [
        new RegExp(`${call}"([a-z_]+)",`, "g"),
      ]),
    ].map((b) => `${b}.refused`),
  );
  for (const a of scan("apps/provisioning/src", [
    new RegExp(`${call}[^,]+,\\s*"(rate_limited)"`, "g"),
  ]))
    out.add(a);
  return out;
};

const written = () =>
  new Set([...apiWritten(), ...stepsWritten(), ...refusalsWritten()]);

it("every option is written", () => {
  const found = written();
  // The scans still see the writers: an empty set would prove nothing.
  expect(found).toContain("token.revoke_all");
  expect(found).toContain("upgrade.held");
  expect(found).toContain("fleet.halted");
  expect(found).toContain("prod_dirty.snapshot");
  expect(found).toContain("auth.refused");
  expect(found).toContain("rate_limited");
  expect(AUDIT_ACTIONS.filter((a) => !found.has(a))).toEqual([]);
});

it("every action the API writes is an option", () => {
  const api = apiWritten();
  expect(api).toContain("job.failed");
  expect([...api].filter((a) => !AUDIT_ACTIONS.includes(a))).toEqual([]);
});

it("every step and refusal row has a label, never its raw name", () => {
  const rows = [...stepsWritten(), ...refusalsWritten()];
  // The composed actions, from their enumerated prefixes.
  expect(rows).toContain("owner_token.lost_lease");
  expect(rows).toContain("upgrade.aborted");
  for (const kind of ["suspend", "resume", "delete", "restore"])
    expect(rows).toContain(`${kind}.hosts`);
  expect(rows).toContain("suspend.hosts");
  expect(rows).toContain("create.start");
  expect(rows.filter((a) => actionPhrase(a) === a)).toEqual([]);
});

it("offers no option twice", () => {
  expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
});
