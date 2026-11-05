import type { Me } from "@oa/shared";
import { useMe } from "../auth/useMe";

/**
 * #1293: who sees the bus pages (Machines, Agents) and their nav links: the
 * server's own canConnect and busOn from /me, never derived here. A server
 * that omits either (older, or bus off) shows nothing.
 */
export const canUseBus = (me: Me | null | undefined): boolean =>
  me?.canConnect === true && me.busOn === true;

/** `null` while /me loads; then whether the bus pages show. */
export function useCanUseBus(): boolean | null {
  const state = useMe();
  if (state.status !== "authed")
    return state.status === "loading" ? null : false;
  return canUseBus(state.me);
}
