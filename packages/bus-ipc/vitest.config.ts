import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["../../scripts/test/tmp-root.ts"],
    setupFiles: [
      "./test-setup/home-sentinel.ts",
      "../../scripts/test/agent-cli-guard.ts",
    ],
  },
});
