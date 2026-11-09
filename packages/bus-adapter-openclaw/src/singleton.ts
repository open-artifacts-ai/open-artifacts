import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bus, DEFAULT_MCP_SERVERS } from "./bus.ts";
import { realConnect } from "./link.ts";
import { resolveStateDir } from "./state-dir.ts";

export const HABITS_MARKER = "habits.on";

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

/** A cheap stat per prompt: is the marker there as a plain file. */
export const markerOn =
  (dir: string, name = HABITS_MARKER) =>
  (): boolean => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  };

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
    habitsOn: markerOn(pluginDir()),
    // An install that names the instance's MCP entry otherwise says so here (#1822).
    mcpServers: () => [
      ...DEFAULT_MCP_SERVERS,
      ...(process.env.OA_BUS_MCP_SERVER ? [process.env.OA_BUS_MCP_SERVER] : []),
    ],
  });
  return g[SLOT];
}
