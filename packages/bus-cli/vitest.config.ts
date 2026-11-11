import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@oa/shared/harness-skills": fileURLToPath(
        new URL("../shared/src/harness-skills.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/sentinel.ts", "../../scripts/test/agent-cli-guard.ts"],
  },
});
