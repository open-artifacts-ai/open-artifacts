/** A date as billing screens show it: "Nov 23, 2026", always in UTC. */
export const formatDate = (iso: string | number | Date | null) =>
  iso === null
    ? null
    : new Date(iso).toLocaleDateString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });

/** A date as a status pill shows it: "Nov 24", always in UTC. */
export const formatShortDate = (iso: string | number | Date) =>
  new Date(iso).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
