import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../scripts/test/tmp-root.ts"],
    setupFiles: ["../../scripts/test/agent-cli-guard.ts"],
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
