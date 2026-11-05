import type { BusMachine, Me } from "@oa/shared";
import { useBusMachines } from "../api/queries";
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

/**
 * Settings › Machines (#1447): "full" for canUseBus; "revoke" for a member
 * the server won't let connect (capped or plan-locked) while the bus is on
 * and an unrevoked machine is left, since revoking never sits behind a cap;
 * else "none". Guests never get it. `null` while that's being worked out.
 */
export type MachinesAccess = "full" | "revoke" | "none";

/** Whether `me` could be revoke-only (it then depends on their machines). */
export const mayRevokeOnly = (me: Me | null | undefined): boolean =>
  me?.busOn === true && me.canConnect === false && me.user.role !== "guest";

export function machinesAccessOf(
  me: Me | null | undefined,
  machines: { machines: BusMachine[] } | undefined,
  failed = false,
): MachinesAccess | null {
  if (canUseBus(me)) return "full";
  if (!mayRevokeOnly(me)) return "none";
  // A failed list still opens the page, which shows the error and Retry.
  if (failed) return "revoke";
  if (machines === undefined) return null;
  return machines.machines.some((m) => m.revokedAt === null)
    ? "revoke"
    : "none";
}

export function useMachinesAccess(): MachinesAccess | null {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const q = useBusMachines(mayRevokeOnly(me));
  if (state.status === "loading") return null;
  return machinesAccessOf(me, q.data, q.isError);
}
