import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A temp `queue_1.sqlite` with the codex-cli 0.166 schema (the parts the reader uses). */
export function queueDb(
  home: string,
  o: {
    rows?: { thread: string; text?: string; raw?: string }[];
    revision?: Record<string, number>;
    noItemsTable?: boolean;
    badRevision?: boolean;
  } = {},
): void {
  const db = new DatabaseSync(join(home, "queue_1.sqlite"));
  try {
    db.exec(
      "create table queued_thread_revisions(revision, thread_id text unique)",
    );
    if (!o.noItemsTable)
      db.exec(
        "create table queued_items(id integer primary key, thread_id text, payload_json text, queue_order integer, created_at_ms integer, updated_at_ms integer)",
      );
    for (const [t, r] of Object.entries(o.revision ?? {}))
      db.prepare(
        "insert into queued_thread_revisions(revision, thread_id) values (?, ?)",
      ).run(o.badRevision ? "x" : r, t);
    if (o.badRevision)
      db.prepare(
        "insert into queued_thread_revisions(revision, thread_id) values (?, ?)",
      ).run("x", THREAD_FOR_BAD);
    for (const [i, row] of (o.rows ?? []).entries())
      db.prepare(
        "insert into queued_items(thread_id, payload_json, queue_order, created_at_ms, updated_at_ms) values (?, ?, ?, 0, 0)",
      ).run(
        row.thread,
        row.raw ??
          JSON.stringify({
            UserInput: { content: [{ type: "text", text: row.text }] },
          }),
        i,
      );
  } finally {
    db.close();
  }
}

const THREAD_FOR_BAD = "019a0000-0000-7000-8000-000000000001";
