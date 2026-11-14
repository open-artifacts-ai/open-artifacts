// Copy for the Team to Business thaw notice (#2150, OA Product's wording on
// the issue). One place, so the final wording changes here only.
export const THAW_COPY = {
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
