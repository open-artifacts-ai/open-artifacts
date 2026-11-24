import { join } from "node:path";
import { z } from "zod";
import { readOwnFile } from "./own-file.ts";

/**
 * #3043: whether this install opted out of the habits the bus pushes at
 * session start. install writes it into install.json (`habits.optedOut`); a
 * missing, unreadable or off-schema file means on, so a broken file never
 * silences the rules.
 */
const FileSchema = z.object({
  habits: z.object({ optedOut: z.boolean().optional() }).optional(),
});

export function habitsOff(
  busHome: string,
  uid: number | undefined = process.getuid?.(),
  log: (m: string) => void = () => {},
): boolean {
  try {
    const f = readOwnFile(join(busHome, "install.json"), uid);
    if (f.state === "unsafe")
      log(`ignoring ${join(busHome, "install.json")}: ${f.why}`);
    if (f.state !== "ok") return false;
    const parsed = FileSchema.safeParse(JSON.parse(f.text));
    return parsed.success && parsed.data.habits?.optedOut === true;
  } catch (e) {
    log(
      `ignoring ${join(busHome, "install.json")}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
