import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/test/agent-cli-guard.ts"],
    include: ["test/**/*.test.ts"],
  },
});
