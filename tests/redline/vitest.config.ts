import { defineConfig } from "vitest/config";

// Unit tests of the harness (a local fake server) and the local-pair smoke
// (skipped unless REDLINE_LOCAL_SMOKE=1). The live suite is vitest.live.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
