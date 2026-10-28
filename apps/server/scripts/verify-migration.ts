// Checks migration 0017_image_format (the format CHECK rebuild) on a D1
// database, through `wrangler d1 execute <db> --remote --json`. Needs only
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
//
//   node --experimental-strip-types apps/server/scripts/verify-migration.ts capture --db <d1 name> --out <file>
//   (apply the migration)
//   node --experimental-strip-types apps/server/scripts/verify-migration.ts verify --db <d1 name> --in <file>
//
// Exit 0: captured, or everything matches. 1: a mismatch (verify) or a
// database that can't be migrated safely (capture). 2: usage or a wrangler
// failure. Reasons go to stderr and name tables, counts and objects only,
// never row data. The checks themselves are in verify-migration-core.ts.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Capture,
  CheckError,
  capture,
  parseCapture,
  type Query,
  serialize,
  verify,
} from "./verify-migration-core.ts";

const USAGE = `usage:
  verify-migration.ts capture --db <d1 name> --out <file>
  verify-migration.ts verify --db <d1 name> --in <file>`;

export type Args =
  | { cmd: "capture"; db: string; file: string }
  | { cmd: "verify"; db: string; file: string };

export function parseArgs(argv: string[]): Args | null {
  const [cmd, ...rest] = argv;
  if (cmd !== "capture" && cmd !== "verify") return null;
  const want = cmd === "capture" ? "--out" : "--in";
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] as string;
    const v = rest[i + 1];
    if ((k !== "--db" && k !== want) || v === undefined || opts.has(k))
      return null;
    opts.set(k, v);
  }
  const db = opts.get("--db");
  const file = opts.get(want);
  if (!db || !file) return null;
  return { cmd, db, file };
}

/** The local wrangler (apps/server's devDependency), else the one on PATH. */
function wranglerBin(): string {
  const local = path.join(
    import.meta.dirname,
    "..",
    "node_modules",
    ".bin",
    "wrangler",
  );
  return existsSync(local) ? local : "wrangler";
}

/** wrangler's --json output: an array of { results } per statement. */
export function parseWranglerJson(stdout: string): Record<string, unknown>[] {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("wrangler printed no JSON");
  const out = JSON.parse(stdout.slice(start)) as {
    results?: Record<string, unknown>[];
    success?: boolean;
  }[];
  const last = out[out.length - 1];
  if (!last || last.success === false) throw new Error("query failed");
  return last.results ?? [];
}

/** One statement through `wrangler d1 execute --remote --json`. */
export function wranglerQuery(db: string): Query {
  const bin = wranglerBin();
  return (sql) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        ["d1", "execute", db, "--remote", "--json", "--command", sql],
        // Outside the repo, so no wrangler config picks another database.
        { cwd: tmpdir(), maxBuffer: 512 * 1024 * 1024, env: process.env },
        (err, stdout) => {
          if (err) {
            // wrangler's own message may quote the statement, never rows.
            reject(new Error(`wrangler d1 execute failed (exit ${err.code})`));
            return;
          }
          try {
            resolve(parseWranglerJson(stdout));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
}

export async function main(
  argv: string[],
  q: (db: string) => Query = wranglerQuery,
  io: { err: (s: string) => void; out: (s: string) => void } = {
    err: (s) => process.stderr.write(`${s}\n`),
    out: (s) => process.stdout.write(`${s}\n`),
  },
): Promise<number> {
  const a = parseArgs(argv);
  if (!a) {
    io.err(USAGE);
    return 2;
  }
  try {
    if (a.cmd === "capture") {
      const c = await capture(q(a.db));
      writeFileSync(a.file, serialize(c));
      io.out(
        `captured ${c.tables.length} tables and ${c.schema.length} schema objects to ${a.file}`,
      );
      return 0;
    }
    let before: Capture;
    try {
      before = parseCapture(readFileSync(a.file, "utf8"));
    } catch (e) {
      io.err(
        `cannot read ${a.file}: ${e instanceof CheckError ? e.message : "not a capture file"}`,
      );
      return 2;
    }
    const r = await verify(q(a.db), before);
    for (const n of r.notes) io.out(n);
    for (const f of r.failures) io.err(`MISMATCH ${f}`);
    io.out(r.ok ? "verify: ok" : `verify: ${r.failures.length} mismatches`);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof CheckError) {
      io.err(e.message);
      return 1;
    }
    io.err(e instanceof Error ? e.message : "failed");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  process.exitCode = await main(process.argv.slice(2));
