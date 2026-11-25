import { renameSync, rmSync, writeFileSync } from "node:fs";
import { AgentRefSchema } from "@oa/bus-protocol";
import { z } from "zod";
import { readOwnFile } from "./own-file.ts";

/**
 * #3028: the refs this daemon has announced to a hub, kept across a restart.
 *
 * A session's liveness is the session file, and the daemon's records live in
 * memory only: a daemon that restarts after a session ended has no record to
 * close and so never tells the hub, whose row stays live for good. It then
 * still shows in `oa-bus status` and still holds the session's name, so a
 * later `/rename` to that name is refused and mail to it goes nowhere.
 *
 * So the announced refs are written here, and a restarted daemon reports the
 * saved ones it cannot see as live as closed (they ride the `sessions` frame
 * the link sends at hello, which already ends closed refs). The hub closes the
 * row and holds the name for its mailbox window (`away`), which is what lets a
 * rename take it back (#1742). Refs only: no name, body, proof or token ever
 * reaches this file. Bounded, oldest dropped first.
 */
export const ANNOUNCED_MAX = 256;

const EntrySchema = z.strictObject({
  ref: AgentRefSchema,
  /** The harness kind, so a restored close keeps its row's kind (status, roster). */
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** #2793: the instance (lane) it was registered on; absent means main. */
  instance: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
});
export type AnnouncedRef = z.infer<typeof EntrySchema>;

const FileSchema = z.strictObject({
  v: z.literal(1),
  refs: z.array(z.unknown()),
});

/** The entries in `file`; none when missing, unsafe, unparseable or off schema. Never throws. */
export function readAnnounced(
  file: string,
  uid: number | undefined = process.getuid?.(),
  log: (m: string) => void = () => {},
): AnnouncedRef[] {
  try {
    const f = readOwnFile(file, uid);
    if (f.state === "unsafe") log(`ignoring ${file}: ${f.why}`);
    if (f.state !== "ok") return [];
    const top = FileSchema.safeParse(JSON.parse(f.text));
    if (!top.success) {
      log(`ignoring ${file}: not the expected shape`);
      return [];
    }
    const out: AnnouncedRef[] = [];
    for (const raw of top.data.refs) {
      if (out.length >= ANNOUNCED_MAX) break;
      const one = EntrySchema.safeParse(raw);
      if (one.success) out.push(one.data);
    }
    return out;
  } catch (e) {
    log(`ignoring ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Replaces the file atomically, mode 0600; the tmp is created fresh, never followed. */
export function writeAnnounced(file: string, refs: AnnouncedRef[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  // A stale or planted tmp (a symlink included) is removed, not written through.
  rmSync(tmp, { force: true });
  try {
    writeFileSync(
      tmp,
      JSON.stringify({ v: 1, refs: refs.slice(-ANNOUNCED_MAX) }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
