import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["../test/tmp-root.ts"],
    setupFiles: ["test/setup.ts", "../test/agent-cli-guard.ts"],
  },
});
