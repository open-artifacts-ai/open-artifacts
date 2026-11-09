import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { readOwnFile } from "./own-file.ts";

/**
 * #1748: what a restarted daemon needs to take back a Codex session it had
 * attested. Codex has no session file to rediscover, so the daemon keeps its
 * own record of each live thread. The file is the daemon's: its 0700 home,
 * mode 0600, written whole through a rename. It is trusted only as far as it
 * goes: the process start and the thread's lock are proven again on restore.
 */
export const CodexAgentSchema = z.strictObject({
  ref: z.string().min(1).max(200),
  pid: z.number().int().positive(),
  /** The process start as `ps` printed it when pinned. */
  procStart: z.string().min(1).max(100),
  proposedName: z.string().min(1).max(200),
  sentName: z.string().max(200).optional(),
  busName: z.string().min(1).max(200),
  namespace: z.string().min(1).max(500),
  global: z.boolean(),
  cwd: z.string().min(1).max(4096),
});
export type CodexAgent = z.infer<typeof CodexAgentSchema>;

const FileSchema = z.strictObject({
  v: z.literal(1),
  agents: z.array(z.unknown()).max(1000),
});

/**
 * The records in `file`, or none when it is missing, unsafe (a symlink,
 * another owner, writable by others), unparseable or not this schema. One bad
 * record loses only itself. Never throws.
 */
export function readCodexAgents(
  file: string,
  uid: number | undefined = process.getuid?.(),
): CodexAgent[] {
  try {
    const f = readOwnFile(file, uid);
    if (f.state !== "ok") return [];
    const top = FileSchema.safeParse(JSON.parse(f.text));
    if (!top.success) return [];
    const seen = new Set<string>();
    const out: CodexAgent[] = [];
    for (const raw of top.data.agents) {
      const one = CodexAgentSchema.safeParse(raw);
      if (!one.success || seen.has(one.data.ref)) continue;
      seen.add(one.data.ref);
      out.push(one.data);
    }
    return out;
  } catch {
    return [];
  }
}

/** Replaces the file atomically with `agents`, mode 0600. */
export function writeCodexAgents(file: string, agents: CodexAgent[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, agents }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
