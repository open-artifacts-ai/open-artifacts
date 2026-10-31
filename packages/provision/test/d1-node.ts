// A D1Database over a node:sqlite database, for node suites that run code
// written against the platform D1 binding (settleFailed, the provisioner's
// Workflows) on the real schema. batch is one transaction, as D1's is.
// Known differences from D1: no meta beyond changes and last_row_id, and
// errors carry SQLite's own text (D1 prefixes D1_ERROR).
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;
export type NodeD1Statement = {
  readonly sql: string;
  readonly params: SQLInputValue[];
  bind(...values: unknown[]): NodeD1Statement;
  first<T = Row>(col?: string): Promise<T | null>;
  all<T = Row>(): Promise<{
    results: T[];
    success: true;
    meta: { changes: number; last_row_id: number };
  }>;
  run<T = Row>(): Promise<{
    results: T[];
    success: true;
    meta: { changes: number; last_row_id: number };
  }>;
  raw<T = unknown[]>(): Promise<T[]>;
};

const value = (v: unknown): SQLInputValue => {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined is not bound");
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as SQLInputValue;
};

function exec(db: DatabaseSync, sql: string, params: SQLInputValue[]) {
  const st = db.prepare(sql);
  if (st.columns().length > 0) {
    const before = db.prepare("SELECT total_changes() AS n").get() as {
      n: number;
    };
    const rows = st.all(...params) as Row[];
    const after = db.prepare("SELECT total_changes() AS n").get() as {
      n: number;
    };
    return { rows, changes: after.n - before.n, last: 0 };
  }
  const r = st.run(...params);
  return {
    rows: [] as Row[],
    changes: Number(r.changes),
    last: Number(r.lastInsertRowid),
  };
}

function statement(
  db: DatabaseSync,
  sql: string,
  params: SQLInputValue[],
  hooks: NodeD1Hooks,
): NodeD1Statement {
  const out = () => {
    hooks.onExec?.(sql, params);
    const r = exec(db, sql, params);
    return {
      results: r.rows,
      success: true as const,
      meta: { changes: r.changes, last_row_id: r.last },
    };
  };
  return {
    sql,
    params,
    bind: (...values) =>
      statement(db, sql, values.map(value), hooks) as NodeD1Statement,
    first: async <T>(col?: string) => {
      const [row] = out().results;
      if (!row) return null;
      return (col === undefined ? row : row[col]) as T;
    },
    all: async <T>() =>
      out() as never as ReturnType<typeof out> & {
        results: T[];
      },
    run: async <T>() =>
      out() as never as ReturnType<typeof out> & {
        results: T[];
      },
    raw: async <T>() =>
      out().results.map((r) => Object.values(r)) as unknown as T[],
  };
}

export interface NodeD1Hooks {
  /** Called before each statement runs (a test can throw to fail it). */
  onExec?: (sql: string, params: SQLInputValue[]) => void;
  /** Called before each batch runs. */
  onBatch?: (stmts: NodeD1Statement[]) => void;
}

/** The binding: prepare, batch (one transaction) and exec. */
export function nodeD1(db: DatabaseSync, hooks: NodeD1Hooks = {}) {
  const d1 = {
    prepare: (sql: string) => statement(db, sql, [], hooks),
    batch: async (stmts: unknown[]) => {
      const list = stmts as NodeD1Statement[];
      hooks.onBatch?.(list);
      db.exec("BEGIN");
      try {
        const out = list.map((s) => {
          hooks.onExec?.(s.sql, s.params);
          const r = exec(db, s.sql, s.params);
          return {
            results: r.rows,
            success: true as const,
            meta: { changes: r.changes, last_row_id: r.last },
          };
        });
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  return d1 as typeof d1 & D1DatabaseLike;
}

/** Structural, so node suites need no workers-types. */
export interface D1DatabaseLike {
  prepare(sql: string): NodeD1Statement;
  batch(stmts: unknown[]): Promise<unknown[]>;
}
