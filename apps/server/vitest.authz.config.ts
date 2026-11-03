import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations"),
);

/**
 * The authz surface matrix alone (P3 T16), for its own CI job: the main
 * config's pool, bindings, migrations and setup, only the matrix (and any
 * test/authz/ test files). The main config excludes them; this is their only
 * run.
 *
 * #1137: plus a second install's own storage, for the foreign-credential
 * callers (test/authz/foreign.ts). FOREIGN_DB and FOREIGN_OAUTH_KV are
 * install A's D1 and OAuth store; the Worker under test (install B) has its
 * own DB and OAUTH_KV and never names these. Only this config binds them.
 */
export default defineConfig({
  ...base,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        d1Databases: { FOREIGN_DB: "oa-test-foreign-install" },
        kvNamespaces: { FOREIGN_OAUTH_KV: "oa-kv-test-foreign-install" },
      },
    }),
  ],
  test: {
    ...base.test,
    include: ["test/authz.surface-matrix.test.ts", "test/authz/**/*.test.ts"],
    exclude: (base.test?.exclude ?? []).filter(
      (p) => p !== "test/authz.surface-matrix.test.ts" && p !== "test/authz/**",
    ),
  },
});
