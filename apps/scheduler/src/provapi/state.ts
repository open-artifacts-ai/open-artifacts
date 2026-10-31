// platform_state (0006): one epoch-ms value per key, shared by every tick.
// Each write is one statement, so overlapping ticks never interleave.

const GET = "SELECT value FROM platform_state WHERE key = ?1";
// Monotonic: an older or replayed write never lowers a newer value.
const RAISE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = MAX(platform_state.value, excluded.value), updated_at = excluded.updated_at";
const SET =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
// Inserted, or moved to ?2 only while the stored value is at or before ?3.
const CLAIM =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE platform_state.value <= ?3 RETURNING value";
// Puts a claim back: only while it is still ours (value = ?2).
const RESTORE =
  "UPDATE platform_state SET value = ?3, updated_at = ?2 WHERE key = ?1 AND value = ?2";
const UNSET = "DELETE FROM platform_state WHERE key = ?1 AND value = ?2";

export async function getState(
  db: D1Database,
  key: string,
): Promise<number | null> {
  const r = await db.prepare(GET).bind(key).first<{ value: unknown }>();
  return typeof r?.value === "number" ? r.value : null;
}

/** Sets key to value, lower or higher. */
export async function setState(
  db: D1Database,
  key: string,
  value: number,
  now: number,
): Promise<void> {
  await db.prepare(SET).bind(key, value, now).run();
}

/** Sets key to MAX(stored, value). */
export async function raiseState(
  db: D1Database,
  key: string,
  value: number,
  now: number = value,
): Promise<void> {
  await db.prepare(RAISE).bind(key, value, now).run();
}

/**
 * Claims key at `value` when it is unset or its value is <= cutoff. True for
 * exactly one of several overlapping claims.
 */
export async function claimState(
  db: D1Database,
  key: string,
  value: number,
  cutoff: number,
): Promise<boolean> {
  return (await db.prepare(CLAIM).bind(key, value, cutoff).first()) !== null;
}

/** Gives back a claim made at `claimed`: to `prev`, or unset when null. */
export async function unclaimState(
  db: D1Database,
  key: string,
  claimed: number,
  prev: number | null,
): Promise<void> {
  if (prev === null) await db.prepare(UNSET).bind(key, claimed).run();
  else await db.prepare(RESTORE).bind(key, claimed, prev).run();
}
