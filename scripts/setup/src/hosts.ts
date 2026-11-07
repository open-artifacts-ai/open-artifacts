import { normalizeHost } from "../../../packages/shared/src/hosts.ts";

export { normalizeHost };

/**
 * Why the server could not serve this APP_HOST/CONTENT_HOST pair, or null.
 * It answers those two hosts only (no any-host fallback), compared with
 * normalizeHost, so an empty host, an unrendered placeholder or one host for
 * both would leave it answering nothing, or everything as content.
 */
export function hostPairProblem(
  appHost: string,
  contentHost: string,
  singleHost = false,
): string | null {
  for (const [k, v] of [
    ["APP_HOST", appHost],
    ["CONTENT_HOST", contentHost],
  ] as const) {
    if (normalizeHost(v) === "") return `${k} is empty`;
    if (v.includes("{{")) return `${k} is an unrendered placeholder (${v})`;
  }
  if (singleHost)
    return normalizeHost(appHost) === normalizeHost(contentHost)
      ? null
      : "--single-host requires APP_HOST and CONTENT_HOST to match";
  if (normalizeHost(appHost) === normalizeHost(contentHost))
    return "APP_HOST and CONTENT_HOST must differ; for an existing path-routed install pass --single-host";
  return null;
}
