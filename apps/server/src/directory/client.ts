import type { Env } from "../env.js";
import { brokerClient } from "./broker.js";
import { directClient } from "./direct.js";
import { type DirectoryClient, directoryTransport } from "./transport.js";

/**
 * The resolved transport as a client, or null when it is "none" (no
 * directory: R.directoryConnect answers 404). T13's polling takes its access
 * token from here, so both kinds poll identically.
 */
export function directoryClient(env: Env): DirectoryClient | null {
  const t = directoryTransport(env);
  if (t.kind === "broker") return brokerClient(env, t);
  if (t.kind === "direct") return directClient(env, t);
  return null;
}
