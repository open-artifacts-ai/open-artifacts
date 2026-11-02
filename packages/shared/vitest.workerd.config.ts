import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// workerd tests (a real local Workflow binding); the node suite is
// vitest.config.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.workerd-test.jsonc" },
    }),
  ],
  test: { include: ["test-workerd/**/*.test.ts"] },
});
