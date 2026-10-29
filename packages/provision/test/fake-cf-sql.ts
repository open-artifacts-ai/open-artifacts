// The SQL under fake-cf's D1s. The default is node:sqlite (the node suites);
// the workerd suite (apps/provisioner) passes Miniflare D1s instead, since
// workerd cannot construct a node:sqlite database.
import { DatabaseSync } from "node:sqlite";

/** One statement, D1 style: its rows and the rows it changed. */
export interface SqlEngine {
  exec(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; changes: number }>;
  /**
   * The statements as one transaction (all or none). Optional: without it,
   * fake-cf wraps the statements in BEGIN and COMMIT through exec.
   */
  batch?(
    stmts: { sql: string; params: unknown[] }[],
  ): Promise<{ rows: Record<string, unknown>[]; changes: number }[]>;
}

/**
 * An in-memory node:sqlite D1. Every call runs synchronously before its
 * promise settles, so the node suites see the same interleaving as before.
 */
export class NodeSqlEngine implements SqlEngine {
  readonly db = new DatabaseSync(":memory:");

  run(sql: string, params: unknown[]) {
    const total = () =>
      Number(
        (this.db.prepare("SELECT total_changes() AS c").get() as { c: number })
          .c,
      );
    const before = total();
    // biome-ignore lint/suspicious/noExplicitAny: D1 params are arbitrary JSON
    const rows = this.db.prepare(sql).all(...(params as any[])) as Record<
      string,
      unknown
    >[];
    // Real D1 counts rows a trigger writes too (measured on staging: a
    // one-row UPDATE of installs reports 2, from installs_row_version), so
    // the fake reports total_changes(), not SQLite's changes().
    return { rows, changes: total() - before };
  }

  async exec(sql: string, params: unknown[]) {
    return this.run(sql, params);
  }

  async batch(stmts: { sql: string; params: unknown[] }[]) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((q) => this.run(q.sql, q.params));
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
