import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * #3043: whether this install opted out of the habits the bus pushes at
 * session start. install writes it into install.json (`habits.optedOut`); a
 * missing, unreadable or off-schema file means on, so a broken file never
 * silences the rules.
 *
 * Both sides read it here, so the daemon's answer and the adapter's
 * instructions cannot disagree: one module, one rule. The file is only read
 * when it is safely ours — never through a symlink, owned by this user, and
 * not writable by others.
 */
const FileSchema = z.object({
  habits: z.object({ optedOut: z.boolean().optional() }).optional(),
});

const installFile = (busHome: string): string => join(busHome, "install.json");

export function habitsOff(busHome: string): boolean {
  const file = installFile(busHome);
  let text: string;
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return false;
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !st.isFile() ||
      (uid !== undefined && st.uid !== uid) ||
      (st.mode & 0o022) !== 0
    )
      return false;
    text = readFileSync(fd, "utf8");
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.habits?.optedOut === true;
  } catch {
    return false;
  }
}
