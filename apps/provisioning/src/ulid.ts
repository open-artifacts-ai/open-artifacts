// Crockford base32 ULIDs (ULID_RE in @oa/shared/provisioning): 48-bit ms
// time, then 80 random bits.

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = B32[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  const r = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of r) s += B32[b % 32];
  return t + s;
}
