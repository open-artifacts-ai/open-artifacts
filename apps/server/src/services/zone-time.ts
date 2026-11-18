// A person's wall clock in an IANA zone: the pure helpers the inbox's time
// rules share ("While you were away" here; "Later" has the same pair).
export type Parts = { y: number; mo: number; d: number; h: number; mi: number };

/** The wall clock in `zone` at the instant `ms`. */
export function wall(ms: number, zone: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms)))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return {
    y: p.year as number,
    mo: p.month as number,
    d: p.day as number,
    h: (p.hour as number) % 24,
    mi: p.minute as number,
  };
}

/** The instant at which `zone`'s wall clock reads y-mo-d h:mi (DST-safe: two passes). */
export function instantAt(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi = 0,
): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const w = wall(guess, zone);
    const shown = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return guess;
}
