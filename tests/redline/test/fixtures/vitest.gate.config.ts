import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: `${import.meta.dirname}/../..`,
    include: ["test/fixtures/gate.fixture.ts"],
    reporters: ["default", "./src/reporter.ts"],
  },
});
