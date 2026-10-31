import type { Release, TokenStatus } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";

// Per-isolate caches of the two read-only ProvisionerRpc calls (2.6):
// releases() for 60 s, tokenStatus() for 5 min (R1's banner and R27), so
// polling never drives a Cloudflare call per request. Keyed by the binding
// object, so each Env (and each test's fake) has its own entry.

export const RELEASES_TTL_MS = 60_000;
export const TOKEN_STATUS_TTL_MS = 5 * 60_000;

type Entry<T> = { at: number; value: T };
const releasesCache = new WeakMap<object, Entry<Release[]>>();
const tokenCache = new WeakMap<object, Entry<TokenStatus>>();

async function cached<T>(
  cache: WeakMap<object, Entry<T>>,
  key: object,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  const value = await load();
  cache.set(key, { at: now, value });
  return value;
}

/** GET /releases (R16), and the version checks of create and upgrade. */
export async function releases(env: Env): Promise<Release[]> {
  try {
    return await cached(releasesCache, env.PROVISIONER, RELEASES_TTL_MS, () =>
      env.PROVISIONER.releases(),
    );
  } catch {
    throw new ApiError("unavailable", "releases are unavailable");
  }
}

/** The provisioning token's status; a failed call reads as invalid, uncached. */
export async function tokenStatus(env: Env): Promise<TokenStatus> {
  try {
    return await cached(tokenCache, env.PROVISIONER, TOKEN_STATUS_TTL_MS, () =>
      env.PROVISIONER.tokenStatus(),
    );
  } catch {
    return { status: "invalid", expiresAt: null, daysLeft: null };
  }
}
