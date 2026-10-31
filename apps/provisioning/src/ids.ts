// Ids the API mints (3.1): ULIDs for jobs (the Workflow instance id) and
// the install id of a create. newInstallId stays provision's one copy.
export { newInstallId } from "@oa/provision/names";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit ms time, then 80 random bits, Crockford base32 (ULID_RE). */
export function ulid(now = Date.now()): string {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  let r = "";
  for (const b of crypto.getRandomValues(new Uint8Array(16)))
    r += CROCKFORD[b & 31];
  return t + r;
}
