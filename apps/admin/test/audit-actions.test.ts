import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { AUDIT_ACTIONS } from "../src/pages/Audit";

// R17 filters on one exact action, so an option nothing writes returns nothing
// for ever: it happened with the install.* names. This reads the writers.
const repo = resolve(__dirname, "../../..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
const scan = (dir: string, patterns: RegExp[]) => {
  const out = new Set<string>();
  for (const f of files(join(repo, dir))) {
    const text = readFileSync(f, "utf8");
    for (const re of patterns)
      for (const m of text.matchAll(re)) out.add(m[1] as string);
  }
  return out;
};
const NAME = "([a-z_]+\\.[a-z_]+)";

/** Every admin_audit action, and the two rows that end a job in hosted_audit. */
const written = () =>
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

it("every option is written, and every written action is an option", () => {
  const found = written();
  // The scan still sees the writers: an empty set would prove nothing.
  expect(found).toContain("token.revoke_all");
  expect(found).toContain("job.failed");
  expect([...found].sort()).toEqual([...AUDIT_ACTIONS].sort());
});
