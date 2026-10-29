import type { SqlEngine } from "../../../packages/provision/test/fake-cf-sql.js";

/** A fake-cf SqlEngine over a Miniflare D1 binding. */
export function d1Engine(db: D1Database): SqlEngine {
  const out = (r: D1Result<Record<string, unknown>>) => ({
    rows: r.results,
    changes: r.meta.changes,
  });
  return {
    exec: async (sql, params) =>
      out(
        await db
          .prepare(sql)
          .bind(...params)
          .all(),
      ),
    // D1 refuses BEGIN; its own batch is the transaction.
    batch: async (stmts) =>
      (
        await db.batch<Record<string, unknown>>(
          stmts.map((q) => db.prepare(q.sql).bind(...q.params)),
        )
      ).map(out),
  };
}

/**
 * fake-cf's `sql` option: each D1 the fake makes (the seeded platform DB, then
 * each install's) takes the next unused binding. Miniflare D1s are fixed by
 * the wrangler config, so running out is a test setup error.
 */
export function d1Engines(dbs: D1Database[]): (dbName: string) => SqlEngine {
  let next = 0;
  return (dbName) => {
    const db = dbs[next++];
    if (!db) throw new Error(`no free Miniflare D1 for ${dbName}`);
    return d1Engine(db);
  };
}
