#!/usr/bin/env node
// The migration lock for a platform D1 that has been deployed: once the lock is
// frozen, every migration file is pinned by sha256 and a pinned file may never
// change (a change is a new migration). Before the first deploy the lock is not
// frozen and the deploy wrapper refuses, so the first deploy is what freezes it.
//
//   node scripts/ops/check-migration-lock.mjs <migrations dir> <lock file>
//
// Exit 0: frozen, every *.sql pinned, every pin matches. Exit 1 otherwise, with
// the reason on stderr (file names only, never contents).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The problems with `lock` against the files in `dir` (empty when it holds).
 * @param {string} dir
 * @param {{ frozen?: unknown, pins?: Record<string, unknown> } | null | undefined} lock
 * @returns {string[]}
 */
export function lockProblems(dir, lock) {
  const out = [];
  if (!lock || typeof lock !== "object" || lock.frozen !== true) {
    out.push(
      "the migration lock is not frozen: pin every migration and set frozen to true before the first deploy",
    );
    return out;
  }
  const pins = lock.pins && typeof lock.pins === "object" ? lock.pins : {};
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const want = pins[f];
    if (typeof want !== "string") {
      out.push(`${f} is not pinned`);
      continue;
    }
    const got = createHash("sha256")
      .update(readFileSync(join(dir, f)))
      .digest("hex");
    if (got !== want)
      out.push(
        `${f} changed after it was deployed: add a new migration instead`,
      );
  }
  for (const f of Object.keys(pins))
    if (!files.includes(f)) out.push(`${f} is pinned but missing`);
  return out;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const [dir, lockFile] = process.argv.slice(2);
  if (!dir || !lockFile) {
    console.error(
      "usage: check-migration-lock.mjs <migrations dir> <lock file>",
    );
    process.exit(2);
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    console.error("the migration lock is missing or not JSON");
    process.exit(1);
  }
  const problems = lockProblems(dir, lock);
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
