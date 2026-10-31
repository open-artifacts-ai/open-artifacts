import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = new URL("../../", import.meta.url);
const shim = (f: string) =>
  fileURLToPath(new URL(`test/node/shims/${f}`, import.meta.url));

/**
 * Config and bundle checks that need Node (fs, wrangler), and the Workflow
 * suites on fake-cf (node:sqlite), with cloudflare:* shimmed and
 * @oa/provision from source (the gates mock applies to it).
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: shim("cloudflare-workers.ts"),
      },
      {
        find: /^cloudflare:workflows$/,
        replacement: shim("cloudflare-workflows.ts"),
      },
      {
        find: /^@oa\/provision$/,
        replacement: fileURLToPath(
          new URL("packages/provision/src/index.ts", ROOT),
        ),
      },
    ],
  },
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",
    // wrangler deploy --dry-run bundles the Worker: seconds, not ms.
    testTimeout: 60_000,
  },
});
