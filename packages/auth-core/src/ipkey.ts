// The client key for per-IP limits and counters (design v7 4.7): an IPv4
// address whole, an IPv6 address by its /64 (one subscriber usually holds a
// whole /64, so a per-address key costs an attacker nothing). One helper for
// the Provisioning API, the auth broker and the D1 counters.

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

function v4(s: string): string | null {
  const m = V4.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts.join(".") : null;
}

/** The eight hextets of an IPv6 address, or null. */
function v6(s: string): number[] | null {
  let t = s.toLowerCase();
  const zone = t.indexOf("%");
  if (zone >= 0) t = t.slice(0, zone);
  // A trailing dotted quad is two hextets.
  const lastColon = t.lastIndexOf(":");
  const tail = t.slice(lastColon + 1);
  if (tail.includes(".")) {
    const q = v4(tail);
    if (!q) return null;
    const [a, b, c, d] = q.split(".").map(Number) as [number, number, number, number];
    t = `${t.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const side = (h: string | undefined) => (h ? h.split(":") : []);
  const head = side(halves[0]);
  const rest = side(halves[1]);
  if (![...head, ...rest].every((h) => HEXTET.test(h))) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  return [
    ...head,
    ...Array<string>(halves.length === 1 ? 0 : fill).fill("0"),
    ...rest,
  ].map((h) => Number.parseInt(h, 16));
}

/** ipKey for a raw address; "unknown" for anything unparseable. */
export function ipKeyOf(ip: string | null | undefined): string {
  const s = (ip ?? "").trim();
  if (!s) return "unknown";
  const four = v4(s);
  if (four) return four;
  const h = v6(s);
  if (!h) return "unknown";
  // IPv4-mapped (::ffff:a.b.c.d) is the IPv4 address.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const [c, d] = [h[6] as number, h[7] as number];
    return `${c >> 8}.${c & 0xff}.${d >> 8}.${d & 0xff}`;
  }
  return `${h
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/** ipKey(req): the cf-connecting-ip address by ipKeyOf. */
export const ipKey = (req: Request): string =>
  ipKeyOf(req.headers.get("cf-connecting-ip"));
