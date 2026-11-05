import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // provision's source, so a test can mock its gates and share its fake
    // Cloudflare (one module instance; the CLI imports the same code).
    alias: {
      "@oa/provision": fileURLToPath(
        new URL("../../packages/provision/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
