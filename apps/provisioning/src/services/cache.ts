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
  stale = false,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  try {
    const value = await load();
    cache.set(key, { at: now, value });
    return value;
  } catch (e) {
    // A failed refresh keeps the last good value where `stale` allows.
    if (stale && hit) return hit.value;
    throw e;
  }
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

/**
 * One version's catalog entry, or null when it is unknown or below the
 * floor: reads that version's records only, so create and upgrade stay
 * cheap however many releases the bucket holds (#1029). Not cached.
 */
export async function releaseOf(
  env: Env,
  version: string,
): Promise<Release | null> {
  try {
    const [r] = await env.PROVISIONER.releases({ version });
    return r?.version === version ? r : null;
  } catch {
    throw new ApiError("unavailable", "releases are unavailable");
  }
}

/**
 * The provisioning token's status, or null when the call failed and no
 * earlier answer exists: a transient RPC error is not an invalid token.
 * A failed refresh serves the last good status.
 */
export async function knownTokenStatus(env: Env): Promise<TokenStatus | null> {
  try {
    return await cached(
      tokenCache,
      env.PROVISIONER,
      TOKEN_STATUS_TTL_MS,
      () => env.PROVISIONER.tokenStatus(),
      true,
    );
  } catch {
    return null;
  }
}

/** R1's banner: an unknown status shows as invalid (the enum has no unknown). */
export async function tokenStatus(env: Env): Promise<TokenStatus> {
  return (
    (await knownTokenStatus(env)) ?? {
      status: "invalid",
      expiresAt: null,
      daysLeft: null,
    }
  );
}
