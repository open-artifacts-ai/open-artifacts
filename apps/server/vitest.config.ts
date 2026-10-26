import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations"),
);

export default defineConfig({
  // Test builds allow the /__test/* hooks (P2 T14; @oa/shared TEST_HOOKS_ALLOWED).
  // Release builds never define it, so hooks can't be enabled by env alone.
  define: { __OA_TEST_HOOKS_ALLOWED__: "true" },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Correctness, not speed: the matrix suites (list.spaces) run past the 5 s
    // default on a loaded machine. Budgets live in the cpu configs.
    testTimeout: 20_000,
    // Wall-clock budgets run alone (vitest.cpu.config.ts), never under suite
    // load; code-cpu runs in Node (vitest.codecpu.config.ts).
    exclude: [
      "test/**/*.cpu.test.ts",
      "test/code-cpu/**",
      "test/node/**",
      // Node-only xt helpers (fs); run by vitest.xt.config.ts.
      "test/xt/*.node.test.ts",
      // The authz matrix runs in its own required CI job (vitest.authz.config.ts).
      "test/authz.surface-matrix.test.ts",
      "test/authz/**",
      "**/node_modules/**",
    ],
    setupFiles: ["./test/setup.ts"],
  },
});
