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
