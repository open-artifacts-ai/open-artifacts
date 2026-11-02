import { type D1Like, json } from "./http.ts";

// The platform schema the D1 routes read (#1041). Prod's oa-p-platform has
// none until platform-db deploys (staging-first gated), and a missing table
// would otherwise be the generic 500. A verified caller gets this fixed 503
// instead, so the red-line guard can tell "prod not created yet" from a fault.

export const REQUIRED_TABLES = [
  "installs",
  "install_lifecycle",
  "platform_state",
] as const;

export const SCHEMA_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(", ")})`;

export const schemaMissing = () => json({ error: "schema_missing" }, 503);

/**
 * True once every required table exists. Only a present schema is cached
 * (once per isolate): a missing one is read again on the next request, so
 * the Worker recovers when the migrations land. A failing read throws, and
 * the caller answers its usual 500.
 */
export function schemaCheck(): (db: D1Like) => Promise<boolean> {
  let ready = false;
  return async (db) => {
    if (ready) return true;
    const { results } = await db
      .prepare(SCHEMA_SQL)
      .bind(...REQUIRED_TABLES)
      .all();
    const have = new Set(
      (results ?? []).map((r) => (r as { name?: unknown }).name),
    );
    ready = REQUIRED_TABLES.every((t) => have.has(t));
    return ready;
  };
}
