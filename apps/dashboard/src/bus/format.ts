// #1293: dates on the bus pages, in the viewer's time zone.

const time = (d: Date) =>
  d.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "Oct 21" (", 2025" when not this year). */
export function shortDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

/** "today at 9:41 AM", else "Nov 2 at 6:10 PM". */
export function dayTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = sameDay(d, new Date(now)) ? "today" : shortDate(iso, now);
  return `${day} at ${time(d)}`;
}
