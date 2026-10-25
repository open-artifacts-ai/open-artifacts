import type { Member } from "@oa/shared";
import { directorySignIn, SignInRefused } from "../directory/signin.js";
import type { KickReason } from "../directory/sync.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";

/**
 * Called after every successful Google admission, before the session is
 * issued (P3 T14, directory/signin.ts): the user is re-read from the
 * directory by their bound identity and their groups diffed. Throws
 * SignInRefused when the directory refuses them (suspended, gone, another
 * customer, Google unreachable during customer_mismatch, or a failure it
 * can't rule on). Only Google being unreachable outside customer_mismatch
 * lets the sign-in proceed (fail static, decided inside directorySignIn);
 * anything unexpected that escapes it is a refusal (fail closed).
 */
export async function onGoogleSignIn(env: Env, user: Member): Promise<void> {
  try {
    await directorySignIn(env, user);
  } catch (e) {
    if (e instanceof SignInRefused) throw e;
    logWarn("directory_signin", e);
    throw new SignInRefused("unverified");
  }
}

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

/**
 * Clears DirectorySync's state for a new or removed binding: one retry on a
 * failure (a fresh stub), then logged; never throws.
 */
export async function resetSync(
  env: Pick<Env, "DIRECTORY_SYNC">,
): Promise<void> {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) return;
  for (let tries = 1; ; tries++) {
    try {
      await ns.get(ns.idFromName(SYNC_DO_NAME)).reset();
      return;
    } catch (e) {
      if (tries >= 2) {
        logWarn("directory_reset", e);
        return;
      }
    }
  }
}

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
