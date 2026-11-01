import type { RouteId } from "./routes.js";

/**
 * The route of a job no API route accepted (the scheduler's purge and
 * cleanup): `system:<kind>`. Never a RouteId, so it never hashes like one.
 */
export type SystemRouteKey = `system:${"purge" | "cleanup"}`;

/** JSON with keys sorted at every depth (3.1 body_hash). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * sha256 hex of canonical `{ route, installId, body }`, with `body` the zod
 * parse output (defaults applied). The same requestId on another route or
 * install hashes differently: 409 idempotency_conflict. System jobs pass
 * a SystemRouteKey (systemJobBodyHash in system.ts).
 */
export async function bodyHash(
  route: RouteId | SystemRouteKey,
  installId: string | null,
  body: unknown,
): Promise<string> {
  const data = new TextEncoder().encode(
    canonicalJson({ route, installId, body }),
  );
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
