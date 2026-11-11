import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Absolute: the token harness reruns tests with a temporary --root.
    setupFiles: [
      fileURLToPath(new URL("./test/setup.ts", import.meta.url)),
      fileURLToPath(
        new URL("../../scripts/test/agent-cli-guard.ts", import.meta.url),
      ),
    ],
  },
});
