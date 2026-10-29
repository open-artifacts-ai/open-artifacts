import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The tier store's tables as oa-<p>-billing creates them (#849's
// apps/billing/migrations/0001_init.sql, copied verbatim into
// test/migrations), so every query runs against the real column names.
const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "test/migrations"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
