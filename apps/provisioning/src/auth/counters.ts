// D1 fixed-window counters (design v7 4.7, `rate_counters`): one atomic
// upsert, RETURNING the window's count.

export const HOUR_MS = 3600_000;

/** Refused sign-ins (4.7): per email HMAC 20/hour, per ipKey HMAC 30/hour. */
export const SIGNIN_REFUSALS = {
  email: { limit: 20, windowMs: HOUR_MS },
  ip: { limit: 30, windowMs: HOUR_MS },
} as const;

const windowOf = (now: number, windowMs: number) => now - (now % windowMs);

/** Adds one to `key`'s current window; the count after it. */
export async function bump(
  db: D1Database,
  key: string,
  windowMs: number,
  now: number,
): Promise<number> {
  const n = await db
    .prepare(
      `INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowOf(now, windowMs))
    .first<number>("count");
  return n ?? 0;
}

/** `key`'s count in the current window (0 when none). */
export async function peek(
  db: D1Database,
  key: string,
  windowMs: number,
  now: number,
): Promise<number> {
  const n = await db
    .prepare(
      "SELECT count FROM rate_counters WHERE key = ? AND window_start = ?",
    )
    .bind(key, windowOf(now, windowMs))
    .first<number>("count");
  return n ?? 0;
}
