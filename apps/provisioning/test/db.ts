import { db, migrate } from "./fakes.js";

/**
 * The local PLATFORM_DB with every platform-db migration applied (once, by
 * fakes.ts), and the session and token tables emptied (admin_audit is
 * append-only and never written here: tests record audit through SigninDeps).
 */
export async function platformDb(): Promise<D1Database> {
  await migrate();
  await db.batch(
    ["sessions", "agent_tokens", "rate_counters"].map((x) =>
      db.prepare(`DELETE FROM ${x}`),
    ),
  );
  return db;
}
