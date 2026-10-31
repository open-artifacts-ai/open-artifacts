import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";

/** The local PLATFORM_DB with the platform-db migrations applied (idempotent). */
export async function platformDb(): Promise<D1Database> {
  const e = testEnv as unknown as {
    PLATFORM_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  await applyD1Migrations(e.PLATFORM_DB, e.TEST_MIGRATIONS);
  return e.PLATFORM_DB;
}
