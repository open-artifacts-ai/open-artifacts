// The install registry (KV BROKER_REGISTRY, key "install:<id>"), written by
// P1 provisioning; read-only here, for both brokers (only `get` is called). Public data only: no secret ever lives in
// an entry, so a stolen registry can't sign for any install.

export type RegistryKey = {
  /** keyId(x): the first 16 chars of base64url(SHA-256(x)). */
  kid: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  x: string;
};

export type RegistryEntry = {
  installId: string;
  /** The install's origin (https://acme.<hosted>): the only place a callback goes. */
  origin: string;
  /** At most 2 during rotation. */
  keys: RegistryKey[];
  /** Verified domains, for the account chooser's hd hint only. */
  domains?: string[];
  disabled?: boolean;
};

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; entry: RegistryEntry | null }>();

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function valid(e: unknown, id: string): e is RegistryEntry {
  const r = e as RegistryEntry | null;
  return (
    !!r &&
    r.installId === id &&
    typeof r.origin === "string" &&
    /^https:\/\/[^/]+$/.test(r.origin) &&
    Array.isArray(r.keys) &&
    r.keys.length <= 2 &&
    r.keys.every((k) => typeof k?.kid === "string" && typeof k?.x === "string")
  );
}

/** The install's entry, or null when unknown, malformed or disabled. Cached 60 s per isolate. */
export async function lookupInstall(
  kv: KVNamespace,
  id: string,
  now = Date.now(),
): Promise<RegistryEntry | null> {
  if (!ID.test(id)) return null;
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.entry;
  const raw = await kv.get(`install:${id}`, "json").catch(() => null);
  const entry = valid(raw, id) && !raw.disabled ? raw : null;
  cache.set(id, { at: now, entry });
  return entry;
}

/** Tests only: forget cached entries. */
export const clearRegistryCache = () => cache.clear();
