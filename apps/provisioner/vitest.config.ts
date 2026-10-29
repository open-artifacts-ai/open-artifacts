import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// workerd has no checkout to read: the release fixtures' server files and the
// platform schema are read here, in Node, and handed in as bindings.
const ROOT = new URL("../../", import.meta.url);
const sqlFiles = (dir: string) =>
  readdirSync(new URL(dir, ROOT))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(new URL(`${dir}${name}`, ROOT), "utf8"),
    }));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          FIXTURE_TEMPLATE: readFileSync(
            new URL("apps/server/wrangler.template.jsonc", ROOT),
            "utf8",
          ),
          FIXTURE_SERVER_MIGRATIONS: sqlFiles("apps/server/migrations/"),
          FIXTURE_PLATFORM_SQL: sqlFiles("apps/platform-db/migrations/")
            .map((f) => f.text)
            .join("\n"),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
