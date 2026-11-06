import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The scheduler's canary smoke against the real server Worker (#1343). This
// test lives with the scheduler (hosted) and borrows the server's Worker,
// schema and test setup, so the public server never depends on the scheduler.
const server = path.join(import.meta.dirname, "../server");
const migrations = await readD1Migrations(path.join(server, "migrations"));

export default defineConfig({
  define: { __OA_TEST_HOOKS_ALLOWED__: "true" },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../server/wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ["test/fleet-smoke/**/*.test.ts"],
    testTimeout: 20_000,
    setupFiles: [path.join(server, "test/setup.ts")],
  },
});
