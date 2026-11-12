// Copy for the Team to Business thaw notices (#2150, OA Product's wording on
// the issue). One place, so the final wording changes here only.
const people = (n: number) =>
  n === 1
    ? "1 person whose role you changed on Team will go back to the role their group gives them."
    : `${n} people whose roles you changed on Team will go back to the role their group gives them.`;

export const THAW_COPY = {
  /** Upgrade confirm, shown only when n > 0. */
  confirmTitle: "Upgrade to Business",
  confirmBody: (n: number) =>
    `Directory sync turns back on. ${people(n)} People you removed stay removed, and people you added stay.`,
  confirmYes: "Upgrade",
  confirmNo: "Cancel",
  /** One-time banner after the thaw reverted anything: at most 2 names, then "and N other(s)". */
  banner: (names: string[], total: number) => {
    const shown = names.slice(0, 2);
    const rest = total - shown.length;
    const who =
      rest > 0
        ? `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`
        : shown.join(" and ");
    const verb = total === 1 ? "is" : "are";
    return `Directory sync is back on. ${who} ${verb} back on the role their group gives them.`;
  },
} as const;
