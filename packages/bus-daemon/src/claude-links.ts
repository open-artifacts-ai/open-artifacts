import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { LINK_HASHES_MAX } from "./agents.ts";
import { readOwnFile } from "./own-file.ts";

/**
 * #2050: the proof hashes of live Claude sessions, kept across a daemon
 * restart. Claude never runs its headersHelper again, so a restarted daemon
 * could not replay `link_bind`. Hashes only (SHA-256 of a proof, never the
 * proof), keyed by pid + process start so a reused pid gets nothing. The file
 * is the daemon's: 0600 in its home, written whole through a rename.
 */
export const CLAUDE_LINKS_MAX = 64;

const EntrySchema = z.strictObject({
  pid: z.number().int().positive(),
  procStart: z.string().min(1).max(100),
  hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
});
export type ClaudeLink = z.infer<typeof EntrySchema>;

const FileSchema = z.strictObject({
  v: z.literal(1),
  links: z.array(z.unknown()),
});

/** The entries in `file`; none when missing, unsafe, unparseable or off schema. Never throws. */
export function readClaudeLinks(
  file: string,
  uid: number | undefined = process.getuid?.(),
  log: (m: string) => void = () => {},
): ClaudeLink[] {
  try {
    const f = readOwnFile(file, uid);
    if (f.state === "unsafe") log(`ignoring ${file}: ${f.why}`);
    if (f.state !== "ok") return [];
    const top = FileSchema.safeParse(JSON.parse(f.text));
    if (!top.success) {
      log(`ignoring ${file}: not the expected shape`);
      return [];
    }
    const out: ClaudeLink[] = [];
    for (const raw of top.data.links) {
      if (out.length >= CLAUDE_LINKS_MAX) break;
      const one = EntrySchema.safeParse(raw);
      if (one.success)
        out.push({
          ...one.data,
          hashes: one.data.hashes.slice(-LINK_HASHES_MAX),
        });
    }
    return out;
  } catch (e) {
    log(`ignoring ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Replaces the file atomically, mode 0600. */
export function writeClaudeLinks(file: string, links: ClaudeLink[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ v: 1, links: links.slice(0, CLAUDE_LINKS_MAX) }),
    { mode: 0o600 },
  );
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
