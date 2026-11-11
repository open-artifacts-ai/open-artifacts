import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { AgentRefSchema, LIMITS, WireNamespaceSchema } from "@oa/bus-protocol";
import { z } from "zod";
import { readOwnFile } from "./own-file.ts";

/**
 * #2029: the Codex threads this daemon has proved, kept past a daemon restart
 * so mail the hub holds for one (an away agent) can be tied back to its thread.
 * Nothing here admits a thread: a row only names which thread to wake, and the
 * woken thread still proves itself with its own tool call.
 */
export const AWAY_IDLE_MS = 24 * 3_600_000;
export const AWAY_MAX = 64;

export const CodexAwaySchema = z.strictObject({
  ref: AgentRefSchema,
  name: z.string().min(1).max(200),
  namespace: WireNamespaceSchema,
  /** When the thread was last live (ms), to the hour. */
  lastLive: z.number().int().nonnegative(),
});
export type CodexAway = z.infer<typeof CodexAwaySchema>;

const FileSchema = z.strictObject({
  v: z.literal(1),
  rows: z.array(z.unknown()),
});

/** Rows idle past the lapse dropped, the newest AWAY_MAX kept. */
export function trimAway(rows: CodexAway[], now: number): CodexAway[] {
  return rows
    .filter((r) => now - r.lastLive <= AWAY_IDLE_MS)
    .sort((a, b) => b.lastLive - a.lastLive)
    .slice(0, Math.min(AWAY_MAX, LIMITS.maxAgentsPerMachine));
}

/** The rows in `file`; none when it is missing, unsafe or unparseable. Never throws. */
export function readCodexAway(
  file: string,
  now: number,
  uid: number | undefined = process.getuid?.(),
): CodexAway[] {
  try {
    const f = readOwnFile(file, uid);
    if (f.state !== "ok") return [];
    const top = FileSchema.safeParse(JSON.parse(f.text));
    if (!top.success) return [];
    const seen = new Set<string>();
    const out: CodexAway[] = [];
    for (const raw of top.data.rows) {
      const one = CodexAwaySchema.safeParse(raw);
      if (!one.success || seen.has(one.data.ref)) continue;
      seen.add(one.data.ref);
      out.push(one.data);
    }
    return trimAway(out, now);
  } catch {
    return [];
  }
}

/** Replaces the file atomically, mode 0600. */
export function writeCodexAway(file: string, rows: CodexAway[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, rows }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
