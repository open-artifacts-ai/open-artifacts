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
 *
 * Only "present" is read: absence proves nothing (a turn deletes the row, and
 * a suspended `codex queue` child may still commit one).
 */
export type QueueRead = {
  /** An item of this thread starts with `${head}\n\n`. */
  present: boolean;
};

/**
 * Node before 22.13 has node:sqlite only behind a flag, and `readOnly` can be
 * ignored there: not trusted to leave Codex's store alone, so unknown.
 */
export function sqliteReadOnlyHolds(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** Whether Codex's queue holds the item, or undefined when that cannot be read. */
export function readQueue(
  home: string,
  thread: string,
  head: string,
): QueueRead | undefined {
  try {
    if (!sqliteReadOnlyHolds(process.versions.node)) return undefined;
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) return undefined;
    // Read only, not immutable: the WAL is read too.
    const db = new sqlite.DatabaseSync(join(home, "queue_1.sqlite"), {
      readOnly: true,
    });
    try {
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
          // Unparseable: it could be ours, so nothing can be said.
          return undefined;
        }
        const text = (
          payload as {
            UserInput?: { content?: { text?: unknown }[] };
          } | null
        )?.UserInput?.content?.[0]?.text;
        if (typeof text === "string") {
          if (startsWithHead(text, head)) present = true;
        } else if (row.payload_json.includes(head)) {
          // Another shape that names our item: unknown, never absent.
          return undefined;
        }
      }
      return { present };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
