import { defineConfig } from "vitest/config";
import { LIVE_TEST_TIMEOUT_MS } from "./src/fetch-timeout.ts";

// The live red-line suite: two installs from REDLINE_TARGETS. Every case is
// reported with a proof level (src/report.ts); REDLINE_GATE=1 fails the run
// unless every case is "pass".
export default defineConfig({
  test: {
    include: ["live/**/*.test.ts"],
    fileParallelism: false,
    // A paced hook() (src/http.ts) can wait up to a minute inside a test or a
    // setup hook.
    testTimeout: LIVE_TEST_TIMEOUT_MS,
    hookTimeout: LIVE_TEST_TIMEOUT_MS,
    // Bounds every fetch (src/fetch-timeout.ts): a stalled request fails its
    // case instead of holding the run.
    setupFiles: ["./live/setup.ts"],
    // verbose prints each failure as it happens (a run cut short still shows
    // them); ./src/reporter.ts writes the REDLINE_REPORT file.
    reporters: ["verbose", "./src/reporter.ts"],
  },
});
