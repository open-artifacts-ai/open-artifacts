import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The real platform schema, so every route's SQL runs against the real tables.
const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "../platform-db/migrations"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/node/**"] },
});
