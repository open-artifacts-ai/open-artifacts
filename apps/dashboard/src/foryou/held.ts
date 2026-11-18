/** #2577: the words of the held-request notice (Design v8), as plain functions. */
import { type AllowResult, LISTEN_ALL_DAYS, LISTEN_PAGE_MS } from "@oa/shared";

const DAY = 24 * 3600_000;

/** The held request an inbox item is about ("request:<id>"). */
export const heldRequestId = (x: { kind: string; id: string }) =>
  x.kind === "request" && x.id.startsWith("request:") ? x.id.slice(8) : null;

/** "Dev" from "Dev Patel". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "15 December", with "next year" when it falls in another year. */
export function endDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return d.getFullYear() === new Date(now).getFullYear()
    ? day
    : d.getFullYear() === new Date(now).getFullYear() + 1
      ? `${day} next year`
      : `${day} ${d.getFullYear()}`;
}

/** The end-date choices of "Allow on all pages" and "Allow in the space". */
export const UNTIL_CHOICES = LISTEN_ALL_DAYS.map((days) => ({
  days,
  label: days === 365 ? "1 year" : `${days} days`,
}));

export const untilOf = (days: number, now = Date.now()) => now + days * DAY;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export type Level = "once" | "page" | "space" | "all";

/** What the person is told after an allow (the card is gone, so this is a toast). */
export function allowedText(o: {
  level: Level;
  sent: number;
  asker: string;
  agent: string;
  page: string;
  space?: string;
  until: number;
  now?: number;
}): string {
  const who = firstName(o.asker);
  const by = endDate(o.until, o.now);
  const got = `${o.agent} got ${who}'s ${plural(o.sent, "request", "requests")}.`;
  switch (o.level) {
    case "once":
      return `${got} ${who}'s next one will ask you again.`;
    case "page":
      return `${got} ${who}'s later ones on "${o.page}" go straight to ${o.agent} until ${by}.`;
    case "space":
      return `${got} ${who}'s later ones on pages in the "${o.space}" space go straight to your agents until ${by}. Change it in Settings, Connections.`;
    case "all":
      return `${who}'s requests reach your agents on every page they work on, until ${by}. Change it in Settings, Connections.`;
  }
}

/** The extra lines when not everything went through. */
export function leftoverText(r: Pick<AllowResult, "changed" | "waiting">) {
  const out: string[] = [];
  if (r.changed > 0)
    out.push(
      `${plural(r.changed, "request", "requests")} changed while you looked, so ${r.changed === 1 ? "it is" : "they are"} held again at the new words.`,
    );
  if (r.waiting > 0) out.push(`${r.waiting} still waiting (hourly limit).`);
  return out.join(" ");
}

export const PAGE_UNTIL_MS = LISTEN_PAGE_MS;
