// The keys a verifier of `env`'s release records and floors accepts: the
// current key first, then that env's retired keys. Per env, never across envs.
// Not exported from the package index. Fresh signatures (attach, a new floor)
// are checked against the current key alone, never through this list.
import { RELEASE_PUBKEY, RELEASE_RETIRED_PUBKEYS } from "./gates.js";

type Env = "staging" | "prod";

export function acceptedKeys(
  env: Env,
  retired: Readonly<Record<Env, readonly string[]>> = RELEASE_RETIRED_PUBKEYS,
): string[] {
  return [RELEASE_PUBKEY[env], ...Object.values(retired).flat()];
}
