import { fileURLToPath } from "node:url";

/**
 * The extension `oa-bus install` copies into Pi's and oh-my-pi's extensions
 * directories: one file, which tells the two apart at load. It is standalone:
 * they load it with nothing but node built-ins.
 */
export const PI_EXTENSION = fileURLToPath(
  new URL("../assets/oa-bus.ts", import.meta.url),
);
