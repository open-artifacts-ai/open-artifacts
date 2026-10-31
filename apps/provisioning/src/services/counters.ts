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

// ipKeyOf below is W5b's @oa/auth-core ipKeyOf (packages/auth-core/src/ip.ts
// on pl/provapi-w5b) verbatim, until W5b merges: then this copy is deleted
// and the callers import it from @oa/auth-core (4.7: one shared helper).

const V4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** The eight hextets of an IPv6 address, or null. An embedded IPv4 tail counts two. */
function hextets(ip: string): number[] | null {
  const s = ip.toLowerCase().replace(/%.*$/, "");
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as string;
      if (i === groups.length - 1 && V4.test(g)) {
        const [a, b, c, d] = g.split(".").map(Number) as [
          number,
          number,
          number,
          number,
        ];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (HEXTET.test(g)) out.push(Number.parseInt(g, 16));
      else return null;
    }
    return out;
  };
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/**
 * The rate key for one address: IPv4 as is; IPv6 truncated to `bits` (a
 * multiple of 16, default 64) as `a:b:c:d::/64`; IPv4-mapped IPv6 is its
 * IPv4. Anything unparseable is "unknown" (one shared bucket).
 */
export function ipKeyOf(raw: string, bits: 16 | 32 | 48 | 64 = 64): string {
  const ip = raw.trim();
  if (V4.test(ip)) return ip;
  const h = hextets(ip);
  if (!h) return "unknown";
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff)
    return [h[6] as number, h[7] as number]
      .flatMap((x) => [x >> 8, x & 0xff])
      .join(".");
  return `${h
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
    const key = `ss_create_${bits}:${await hmac16(env, ipKeyOf(ip, bits))}`;
    if (!(await charge(env, key, max, HOUR_MS))) ok = false;
  }
  return ok;
}
