// The opaque per-artifact key a viewer shows under on the presence roster.

import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { hmacSign } from "../util/crypto.js";

/**
 * First 16 base64url characters of HMAC(artifact id + NUL + identity) under
 * the `oa:viewer-presence` key. Per artifact, so it cannot link a viewer
 * across artifacts, and it reveals no user id, cookie or token.
 * `identity` is `u:{userId}`, `p:{oa_pid}`, `s:{random}` (no valid cookie: one
 * face per socket) or `a:{session or connection}` (an agent).
 */
export async function viewerPresenceKey(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  identity: string,
): Promise<string> {
  const mac = await hmacSign(
    await deriveKey(env, "oa:viewer-presence"),
    `${artifactId}\0${identity}`,
  );
  return mac.slice(0, 16);
}
