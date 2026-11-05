import { defineConfig } from "vitest/config";

// Unit tests of the import checker against an in-process fake install (no network).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
