import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";

type TestEnv = { PLATFORM_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const t = testEnv as unknown as TestEnv;

let ready: Promise<void> | undefined;
/**
 * The local PLATFORM_DB with every platform-db migration applied, and the
 * session and token tables emptied (admin_audit is append-only and never
 * written here: tests record audit through SigninDeps).
 */
export async function platformDb(): Promise<D1Database> {
  ready ??= applyD1Migrations(t.PLATFORM_DB, t.TEST_MIGRATIONS);
  await ready;
  await t.PLATFORM_DB.batch(
    ["sessions", "agent_tokens", "rate_counters"].map((x) =>
      t.PLATFORM_DB.prepare(`DELETE FROM ${x}`),
    ),
  );
  return t.PLATFORM_DB;
}
