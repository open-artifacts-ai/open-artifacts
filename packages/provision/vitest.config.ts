import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // wfp-create's asset memory test calls gc().
    execArgv: ["--expose-gc"],
  },
});
