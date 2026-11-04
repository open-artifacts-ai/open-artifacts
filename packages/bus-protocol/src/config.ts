import { z } from "zod";
import { NamespaceSchema } from "./namespace.js";

/**
 * The per-repo bus config. Its own name, not OpenBus's `.openbus.json`, so the
 * two clients can run side by side without one reading the other's file.
 */
export const CONFIG_FILE = ".oa-bus.json";

/**
 * Read from the directory where the session starts, or any parent. Both keys
 * are optional. `global` is accepted so a file copied from OpenBus parses, but
 * it grants nothing: the local client ignores it, with a warning, and takes
 * global only from the user's own allowlist (`<OA_BUS_HOME>/global.json`). A
 * repo anyone can write to must not widen what its agents see.
 */
export const BusConfigSchema = z.strictObject({
  namespace: NamespaceSchema.optional(),
  global: z.boolean().optional(),
});
export type BusConfig = z.infer<typeof BusConfigSchema>;

/**
 * Merges configs ordered nearest-first (the session directory, then its
 * parents). Per key, the nearest file that sets it wins.
 */
export function mergeConfigs(configs: BusConfig[]): BusConfig {
  const out: BusConfig = {};
  for (const c of configs) {
    if (out.namespace === undefined && c.namespace !== undefined)
      out.namespace = c.namespace;
    if (out.global === undefined && c.global !== undefined)
      out.global = c.global;
  }
  return out;
}
