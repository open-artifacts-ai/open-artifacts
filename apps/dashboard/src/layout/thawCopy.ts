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
  /** One-time banner after the thaw reverted anything. */
  banner: (n: number) =>
    n === 1
      ? "Directory sync is back on: 1 role change you made on Team was replaced by your groups."
      : `Directory sync is back on: ${n} role changes you made on Team were replaced by your groups.`,
  link: "See what changed",
} as const;
