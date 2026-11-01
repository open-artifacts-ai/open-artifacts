/** vitest's per-test budget for the jsdom project (vite.config.ts). */
export const TEST_TIMEOUT_MS = 15_000;

/**
 * Deadline for a test's first wait on a freshly mounted page. The load is
 * CPU-bound: about 0.2 s alone, 30 times that under a loaded full suite (#1004),
 * past setup.ts's 5 s asyncUtilTimeout. It stays under TEST_TIMEOUT_MS so a
 * page that never loads reports its own failure.
 */
export const FIRST_LOAD_MS = TEST_TIMEOUT_MS - 3_000;
