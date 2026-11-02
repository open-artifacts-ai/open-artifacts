import { defineConfig } from "vitest/config";

/** Config and source checks that need Node (fs), not workerd. */
export default defineConfig({
  test: { include: ["test/node/**/*.test.ts"], environment: "node" },
});
