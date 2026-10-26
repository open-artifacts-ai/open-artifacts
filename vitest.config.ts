import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    // @oa/setup and @oa/hosted run their own suites via `pnpm -r test`.
    exclude: ["scripts/setup/**", "scripts/hosted/**", "**/node_modules/**"],
    // These are shell-script tests: most spawn bash, node or a stubbed gh per
    // case. Under load (a busy laptop, a parallel CI job) a spawn can pass
    // vitest's 5 s default even though the script is fine, so a busy machine
    // failed whole cases (prod-setup, hosted-set-signing-key). 30 s still
    // bounds a real hang.
    testTimeout: 30_000,
  },
});
