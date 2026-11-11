import { fileURLToPath } from "node:url";

/**
 * The Hermes plugin directory `oa-bus install` copies to
 * ~/.hermes/plugins/oa-bus: Python standard library only, loaded by Hermes.
 */
export const HERMES_PLUGIN = fileURLToPath(
  new URL("../assets/oa_bus", import.meta.url),
);
