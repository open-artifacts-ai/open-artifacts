import { z } from "zod";
import { NamespaceSchema } from "./namespace.ts";

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
/**
 * An instance a repo suggests (#2793): one https address, host and port only.
 * No path, user name, query or fragment. A hint the user answers; never a default.
 */
export const InstanceHintSchema = z.string().refine((raw) => {
  if (/[?#@\\\s]/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.pathname === "/" || u.pathname === "") &&
      u.host !== ""
    );
  } catch {
    return false;
  }
}, "an instance must be one https address: host and port only");

export const BusConfigSchema = z.strictObject({
  namespace: NamespaceSchema.optional(),
  global: z.boolean().optional(),
  instance: InstanceHintSchema.optional(),
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
    if (out.instance === undefined && c.instance !== undefined)
      out.instance = c.instance;
  }
  return out;
}
