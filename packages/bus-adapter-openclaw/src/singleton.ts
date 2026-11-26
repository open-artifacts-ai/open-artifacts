import { Bus } from "./bus.ts";
import { realConnect } from "./link.ts";
import { resolveStateDir } from "./state-dir.ts";

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
