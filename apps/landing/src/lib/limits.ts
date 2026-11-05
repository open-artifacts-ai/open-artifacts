import { LIMITS } from "@oa/shared";

// Docs quote limits as {LIMIT_*} placeholders, filled from @oa/shared's
// LIMITS at build time, so a changed limit can't leave a stale number.

/**
 * Bytes as the docs write them, exactly: "2 MB", "1.5 MB", "512 KB", and
 * "1,088 KB" for a size MB can't show in two decimals (1 MB + 64 KB).
 */
export function formatBytes(n: number): string {
  const MB = 1024 * 1024;
  const mb = n / MB;
  if (n >= MB && Number.isInteger(mb * 100)) return `${mb} MB`;
  return `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;
}

/** Seconds as the docs write them: "10 minutes", "1 hour", "45 seconds". */
export function formatSeconds(s: number): string {
  const [n, unit] =
    s % 3600 === 0
      ? [s / 3600, "hour"]
      : s % 60 === 0
        ? [s / 60, "minute"]
        : [s, "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export const LIMIT_PLACEHOLDERS: Record<string, string> = {
  "{LIMIT_INLINE}": formatBytes(LIMITS.inlineBytes),
  "{LIMIT_FILE}": formatBytes(LIMITS.fileBytes),
  "{LIMIT_PUBLISH}": formatBytes(LIMITS.publishBytes),
  "{LIMIT_DATA_DOC_FREE}": formatBytes(LIMITS.dataDocBytesFree),
  "{LIMIT_DATA_DOC_PAID}": formatBytes(LIMITS.dataDocBytesPaid),
  "{LIMIT_MCP_BODY_FREE}": formatBytes(LIMITS.mcpBodyBytesFree),
  "{LIMIT_MCP_BODY_PAID}": formatBytes(LIMITS.mcpBodyBytesPaid),
  "{LIMIT_ARTIFACT_DATA}": formatBytes(LIMITS.artifactDataBytes),
  "{LIMIT_QUERY_COLLECTION}": formatBytes(LIMITS.queryCollectionBytes),
  "{LIMIT_VIEWER_WRITES}": `${LIMITS.viewerWritesPerMin} per minute`,
  "{LIMIT_ANON_WRITES}": `${LIMITS.anonWritesPerMinPerIp} per minute`,
  "{LIMIT_SIGNED_URL_TTL}": formatSeconds(LIMITS.signedUrlTtlSec),
  "{LIMIT_SOFT_DELETE}": plural(LIMITS.softDeleteDays, "day"),
  "{LIMIT_UPLOAD_URL_TTL}": formatSeconds(LIMITS.uploadUrlTtlSec),
  "{LIMIT_UPLOAD_TTL}": plural(LIMITS.uploadTtlHours, "hour"),
  "{LIMIT_INDEX_LAG}": formatSeconds(LIMITS.indexDebounceMs / 1000),
  "{LIMIT_INDEX_TEXT}": formatBytes(LIMITS.indexTextBytes),
};
