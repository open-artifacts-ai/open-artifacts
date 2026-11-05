import { execFile } from "node:child_process";
import { promisify } from "node:util";

// What a release's server schema is, for the cases that must know whether one
// release adds a D1 or Durable Object migration over another (P31). The same
// two sources the rollback schema guard compares: the D1 migration files and
// the Durable Object migration tags of the release's own tree.

export interface Schema {
  /** apps/server/migrations/*.sql file names. */
  d1: readonly string[];
  /** The "tag" of every entry in wrangler.template.jsonc's migrations. */
  doTags: readonly string[];
}

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATIONS_DIR = "apps/server/migrations";
const TEMPLATE = "apps/server/wrangler.template.jsonc";
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** Parses file names (paths or bare names) and the template's text. */
export function parseSchema(
  files: readonly string[],
  template: string,
): Schema {
  const d1 = files
    .map((f) => f.slice(f.lastIndexOf("/") + 1))
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();
  const at = template.indexOf('"migrations": [');
  const block = at < 0 ? "" : template.slice(at);
  const doTags = [...block.matchAll(/"tag"\s*:\s*"([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  return { d1, doTags };
}

/** What `tag` has that `target` lacks: the reasons a rollback to it is refused. */
export function schemaAhead(tag: Schema, target: Schema): string[] {
  return [
    ...tag.d1.filter((f) => !target.d1.includes(f)).map((f) => `D1 ${f}`),
    ...tag.doTags
      .filter((t) => !target.doTags.includes(t))
      .map((t) => `DO ${t}`),
  ];
}

const run = promisify(execFile);
const git = async (args: string[]): Promise<string> =>
  (await run("git", args, { maxBuffer: 1 << 20 })).stdout;

/**
 * The schema of release `version`, from its tag v<version> in this repository:
 * fetched at depth 1 when the checkout (the tag under test, one commit deep)
 * doesn't have it.
 */
export async function gitSchemaOf(version: string): Promise<Schema> {
  if (!VERSION.test(version)) throw new Error(`not a release version`);
  const ref = `refs/tags/v${version}`;
  try {
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    await git(["fetch", "--depth=1", "--no-tags", "origin", `${ref}:${ref}`]);
  }
  const names = await git([
    "ls-tree",
    "--name-only",
    ref,
    `${MIGRATIONS_DIR}/`,
  ]);
  const template = await git(["show", `${ref}:${TEMPLATE}`]);
  return parseSchema(names.split("\n").filter(Boolean), template);
}
