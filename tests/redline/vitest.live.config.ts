import { defineConfig } from "vitest/config";

// The live red-line suite: two installs from REDLINE_TARGETS. Every case is
// reported with a proof level (src/report.ts); REDLINE_GATE=1 fails the run
// unless every case is "pass".
export default defineConfig({
  test: {
    include: ["live/**/*.test.ts"],
    fileParallelism: false,
    // A paced hook() (src/http.ts) can wait up to a minute inside a test or a
    // setup hook.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ["default", "./src/reporter.ts"],
  },
});
