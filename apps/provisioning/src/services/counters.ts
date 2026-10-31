import { hmac16 } from "../audit.js";
import type { Env } from "../env.js";

// D1 fixed-window counters (4.7, `rate_counters`): one atomic upsert
// RETURNING count per charge. Keys hold an HMAC, never a raw IP (4.9).

export const HOUR_MS = 60 * 60_000;

/** Charges `key` in its window; true while the count is within `max`. */
export async function charge(
  env: Env,
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const r = await env.PLATFORM_DB.prepare(
    `INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
RETURNING count`,
  )
    .bind(key, now - (now % windowMs))
    .first<{ count: number }>();
  return (r?.count ?? Number.POSITIVE_INFINITY) <= max;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function v6Groups(ip: string): number[] | null {
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(":") : []);
  const head = part(halves[0] ?? "");
  const tail = halves.length === 2 ? part(halves[1] ?? "") : [];
  // An embedded IPv4 tail counts as two groups.
  const last = tail.length ? tail : head;
  const v4 = last.at(-1)?.includes(".") ? last.pop() : undefined;
  const extra: string[] = [];
  if (v4) {
    const o = v4.split(".").map(Number);
    if (o.length !== 4 || o.some((x) => !(x >= 0 && x <= 255))) return null;
    extra.push(
      (((o[0] as number) << 8) | (o[1] as number)).toString(16),
      (((o[2] as number) << 8) | (o[3] as number)).toString(16),
    );
  }
  const given = [...head, ...tail, ...extra];
  const fill = halves.length === 2 ? 8 - given.length : 0;
  if (fill < 0 || (halves.length === 1 && given.length !== 8)) return null;
  const all = [
    ...head,
    ...Array(fill).fill("0"),
    ...tail,
    ...extra,
  ] as string[];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g)))
    return null;
  return all.map((g) => Number.parseInt(g, 16));
}

/**
 * The address a per-prefix counter keys on: IPv4 whole, IPv6 truncated to
 * `bits` (64 or 48). W5b's shared `ipKey` (4.7) is the /64 form of this.
 */
export function ipPrefix(ip: string, bits: 48 | 64): string {
  if (!ip.includes(":")) return ip;
  const g = v6Groups(ip);
  if (!g) return ip;
  return `${g
    .slice(0, bits / 16)
    .map((x) => x.toString(16))
    .join(":")}::/${bits}`;
}

/** Self-serve creates per /64 and per /48 (4.7): 3 and 10 an hour. */
export const SELF_SERVE_CREATE_LIMITS = [
  { bits: 64, max: 3 },
  { bits: 48, max: 10 },
] as const;

/** Charges every self-serve create limit; false once any is over. */
export async function chargeSelfServeCreate(
  env: Env,
  ip: string,
): Promise<boolean> {
  let ok = true;
  for (const { bits, max } of SELF_SERVE_CREATE_LIMITS) {
    const key = `ss_create_${bits}:${await hmac16(env, ipPrefix(ip, bits))}`;
    if (!(await charge(env, key, max, HOUR_MS))) ok = false;
  }
  return ok;
}
