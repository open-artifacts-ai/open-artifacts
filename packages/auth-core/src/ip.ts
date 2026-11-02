// The per-IP rate key (design v7 4.7), one helper for the Provisioning API,
// the broker and the D1 counters: IPv4 is the full address, IPv6 is
// truncated to its /64 (one subscriber's allocation), so rotating within a
// /64 does not buy a fresh bucket.

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

/** The request's rate key from `cf-connecting-ip` (Cloudflare overwrites a client's own value). */
export const ipKey = (req: Request): string =>
  ipKeyOf(req.headers.get("cf-connecting-ip") ?? "");
