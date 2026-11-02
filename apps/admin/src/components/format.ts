/** "2026-10-31 14:05 UTC" from epoch ms. */
export const fmtTime = (ms: number | null | undefined): string =>
  ms == null
    ? "never"
    : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
