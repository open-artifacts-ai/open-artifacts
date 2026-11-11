import { defineConfig } from "vitest/config";

/** Config and bundle checks that need Node (fs, wrangler), not workerd. */
export default defineConfig({
  test: {
    setupFiles: ["../../scripts/test/agent-cli-guard.ts"],
    include: ["test/node/**/*.test.ts"],
    environment: "node",
    // wrangler deploy --dry-run bundles the Worker: seconds, not ms.
    testTimeout: 60_000,
  },
});
