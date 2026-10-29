import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { hmacSign } from "../util/crypto.js";

/**
 * The per-artifact opaque key a viewer shows under: the same person on two
 * artifacts gets two unlinkable keys. `identity` is `u:{userId}`, `p:{oa_pid}`,
 * `s:{random}` or `a:{agent session}`; it never reaches a client.
 */
export async function viewerPresenceKey(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  identity: string,
): Promise<string> {
  const key = await deriveKey(env, "oa:viewer-presence");
  return (await hmacSign(key, `${artifactId}\0${identity}`)).slice(0, 16);
}
