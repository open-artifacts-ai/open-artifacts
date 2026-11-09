import { fileURLToPath } from "node:url";

/**
 * The built plugin folder (`pnpm build` writes it) that `oa-bus install` will
 * hand to `openclaw plugins install`: index.js, openclaw.plugin.json and a
 * package.json, self-contained.
 */
export const OPENCLAW_PLUGIN = fileURLToPath(
  new URL("../dist", import.meta.url),
);
