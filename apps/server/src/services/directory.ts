import type { Member } from "@oa/shared";
import type { KickReason } from "../directory/sync.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";

/**
 * P3 seam: called after every successful Google admission, before the
 * session is issued (P3 diffs groups.list for this user). P2 lands the
 * signature; P3 owns the body. A throw is logged and never blocks sign-in.
 */
export async function onGoogleSignIn(_env: Env, _user: Member): Promise<void> {}

/**
 * P3 T13 seam: called once the owner confirms a directory connect (its binding and
 * sealed refresh token stored) and the initial binding pass ran (directory/
 * binding.ts). T13's DirectorySync takes over here: it kicks its first
 * reconcile (restricted groups) and, when
 * `initialDone` is false, finishes the pass from binding.initial's cursor
 * (email matching still allowed until that pass completes). A throw is
 * logged; the connection stands.
 */
export async function afterDirectoryConnect(
  env: Env,
  _pass: { initialDone: boolean },
): Promise<void> {
  // A new binding: DirectorySync forgets the old one's health, holds,
  // active count and Reports cursors, then reconciles now and finishes an
  // unfinished initial pass from its cursor (email matching allowed until
  // it completes). A future disconnect calls resetSync too.
  await resetSync(env);
  await kickSync(env, "manual");
}

/** Clears DirectorySync's state for a new or removed binding; never throws. */
export async function resetSync(
  env: Pick<Env, "DIRECTORY_SYNC">,
): Promise<void> {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) return;
  await ns
    .get(ns.idFromName(SYNC_DO_NAME))
    .reset()
    .catch((e) => logWarn("directory_reset", e));
}

/**
 * P3 T14 seam: a synced group's member diff (install user ids) was just
 * written to directory_members by DirectorySync, its members' restriction
 * flags recomputed and the removed users' sockets closed. T14 recomputes
 * space_members(source = 'sync') from it. A throw is logged.
 */
export async function onGroupDiff(
  _env: Env,
  _groupId: string,
  _added: string[],
  _removed: string[],
): Promise<void> {}

/**
 * Asks the install's DirectorySync for a run (P3 T13). Without the
 * DIRECTORY_SYNC binding it is a no-op. With a context it runs in waitUntil;
 * it never throws.
 */
export async function kickSync(
  env: Pick<Env, "DIRECTORY_SYNC">,
  reason: KickReason,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) return;
  const run = (async () => {
    await ns.get(ns.idFromName(SYNC_DO_NAME)).kick(reason);
  })().catch((e) => logWarn("directory_kick", e, { reason }));
  if (ctx) ctx.waitUntil(run);
  else await run;
}

/** The one DirectorySync per install. */
export const SYNC_DO_NAME = "install";
