import { defineConfig } from "vitest/config";

/** Source checks that need Node (fs, the TypeScript compiler), not workerd. */
export default defineConfig({
  test: {
    globalSetup: ["../../scripts/test/tmp-root.ts"],
    setupFiles: ["../../scripts/test/agent-cli-guard.ts"],
    include: ["test/node/**/*.test.ts"],
    environment: "node",
  },
});
