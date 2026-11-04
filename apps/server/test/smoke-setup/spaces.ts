import { R } from "@oa/shared";

/**
 * Whether the instance runs with the spaces feature (#829). GET /me carries
 * personalSpaceId only with it, in every sign-in mode, so the smoke reads it
 * with the owner PAT instead of assuming staging's config. Staging runs
 * without FEATURES=spaces today: 18 MCP tools and a "nospaces-" skill ETag.
 */
export async function spacesOn(base: string, pat: string): Promise<boolean> {
  const r = await fetch(`${base}${R.me}`, {
    headers: { authorization: `Bearer ${pat}` },
  });
  if (r.status !== 200) throw new Error(`GET ${R.me}: ${r.status}`);
  return "personalSpaceId" in ((await r.json()) as object);
}

/** The tools tools/list offers: list_spaces only with spaces. */
export const expectedToolCount = (spaces: boolean): number =>
  spaces ? 19 : 18;

/**
 * The skill ETag at `version`: "nospaces-" exactly when spaces is off.
 * `spaces` undefined (no PAT to ask /me with) accepts either.
 */
export function skillEtagPattern(
  version: string,
  spaces: boolean | undefined,
): RegExp {
  const tpl = spaces === undefined ? "(nospaces-)?" : spaces ? "" : "nospaces-";
  // Cloudflare weakens the ETag when it compresses the response (W/"…").
  return new RegExp(
    `^(W/)?"${version.replace(/[.+]/g, "\\$&")}-(free|paid)-${tpl}[0-9a-f]{8}"$`,
  );
}
