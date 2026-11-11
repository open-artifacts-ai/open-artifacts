import { join } from "node:path";
import { startsWithHead } from "./codex-taken.ts";

/**
 * Codex's own queue store, read only (codex-cli 0.166): `queue_1.sqlite` in
 * CODEX_HOME, WAL mode. The format is undocumented and versioned, so this is
 * the one place that knows it; anything unexpected reads as unknown, never as
 * absent.
 *
 * - `queued_items(id, thread_id, payload_json, …)`: the item's text is at
 *   `payload_json.UserInput.content[0].text`. A row is deleted when a turn
 *   takes it.
 * - `queued_thread_revisions(revision, thread_id)`: bumped on every insert,
 *   update and delete for the thread.
 */
export type QueueRead = {
  /** An item of this thread starts with `${head}\n\n`. */
  present: boolean;
  /** The thread's revision (null: the thread was never touched). */
  revision: number | null;
};

/** Whether Codex's queue holds the item, or undefined when that cannot be read. */
export function readQueue(
  home: string,
  thread: string,
  head: string,
): QueueRead | undefined {
  try {
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) return undefined;
    // Read only, not immutable: the WAL is read too.
    const db = new sqlite.DatabaseSync(join(home, "queue_1.sqlite"), {
      readOnly: true,
    });
    try {
      const rev = db
        .prepare(
          "SELECT revision FROM queued_thread_revisions WHERE thread_id = ?",
        )
        .get(thread) as { revision?: unknown } | undefined;
      if (rev !== undefined && typeof rev.revision !== "number")
        return undefined;
      const rows = db
        .prepare("SELECT payload_json FROM queued_items WHERE thread_id = ?")
        .all(thread) as { payload_json?: unknown }[];
      let present = false;
      for (const row of rows) {
        if (typeof row.payload_json !== "string") return undefined;
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          continue; // not ours to read; another item's payload
        }
        const text = (
          payload as {
            UserInput?: { content?: { text?: unknown }[] };
          } | null
        )?.UserInput?.content?.[0]?.text;
        if (typeof text === "string" && startsWithHead(text, head))
          present = true;
      }
      return {
        present,
        revision: typeof rev?.revision === "number" ? rev.revision : null,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
