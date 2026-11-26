import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bus } from "./bus.ts";
import { realConnect } from "./link.ts";
import { resolveStateDir } from "./state-dir.ts";

/**
 * The plugin's own installed folder: the one holding openclaw.plugin.json,
 * found from this file's location (the bundle sits beside it; the sources one
 * level below), never from the working directory.
 */
export function pluginDir(
  here: string = fileURLToPath(import.meta.url),
): string {
  const d = dirname(here);
  return existsSync(join(d, "openclaw.plugin.json")) ? d : dirname(d);
}

const SLOT = Symbol.for("open-artifacts.bus-adapter-openclaw");

/**
 * One Bus per process, however many times OpenClaw loads or registers this
 * plugin: the slot lives on globalThis, not in module state.
 */
export function processBus(): Bus {
  const g = globalThis as { [SLOT]?: Bus };
  g[SLOT] ??= new Bus({
    connect: realConnect(),
    stateDir: () => resolveStateDir(),
  });
  return g[SLOT];
}
