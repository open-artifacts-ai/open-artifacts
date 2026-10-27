import type { Member } from "@oa/shared";
import { brokerTransportKind } from "../auth/broker-transport.js";
import { directoryClient } from "../directory/client.js";
import { directorySignIn, SignInRefused } from "../directory/signin.js";
import { readBinding, readPending } from "../directory/store.js";
import { type KickReason, tokenFor } from "../directory/sync.js";
import { TransportError } from "../directory/transport.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import { directoryMode } from "./spaces.js";

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
 * Asks the install's DirectorySync for a run (P3 T13), then hands it an
 * access token when it needs one (feedSync). Without the DIRECTORY_SYNC
 * binding it is a no-op. With a context it runs in waitUntil (still this
 * invocation, so its broker capability holds); it never throws.
 */
export async function kickSync(
  env: Env,
  reason: KickReason,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) return;
  const run = (async () => {
    await ns.get(ns.idFromName(SYNC_DO_NAME)).kick(reason);
    await feedSync(env);
  })().catch((e) => logWarn("directory_kick", e, { reason }));
  if (ctx) ctx.waitUntil(run);
  else await run;
}

/** What one feedSync did (logged by the scheduler tick, asserted by tests). */
export type FeedOutcome =
  | "self"
  | "no_props"
  | "off"
  | "not_due"
  | "unbound"
  | "fed"
  | "mint_failed"
  | "stale_props";

/**
 * Hosted directory sync (oa:directory-sync, request kicks): DirectorySync
 * can't reach the broker from its alarm, so an invocation holding the
 * platform's DIRECTORY_BROKER capability asks it whether a run is due
 * (wantsToken: its own stored timing), and if so mints the access token here
 * and hands over the token (or the mint's failure stage), never the
 * capability. A self-hosted install (a binding, HTTPS, or its own Google
 * app) mints in the alarm as before: "self", nothing done. Throws only on a
 * D1 or DO error.
 */
export async function feedSync(env: Env): Promise<FeedOutcome> {
  const ns = env.DIRECTORY_SYNC;
  const client = directoryClient(env);
  if (!ns || !client || directoryMode(env) === "off") return "off";
  if (client.kind !== "broker") return "self";
  const kind = brokerTransportKind(env, "directory");
  // Hosted without the capability: nothing can feed the DO from here (its
  // alarm fails the lane as transport_no_feed after NO_FEED_MS).
  if (kind === null) {
    logWarn("directory_feed", new Error("no DIRECTORY_BROKER props"), {
      outcome: "no_props",
    });
    return "no_props";
  }
  if (kind !== "props") return "self";
  // The binding first: a never-connected install doesn't wake its DO.
  const [{ binding, sealed }, pending] = await Promise.all([
    readBinding(env),
    readPending(env),
  ]);
  // The alarm syncs nothing in these states either.
  if (!binding || !sealed || pending) return "unbound";
  const stub = ns.get(ns.idFromName(SYNC_DO_NAME));
  if (!(await stub.wantsToken())) return "not_due";
  const key = tokenFor(binding);
  let token: string;
  try {
    token = await client.accessToken(sealed);
  } catch (e) {
    // A capability past its invocation: nothing was sent and nothing is
    // handed over; the next tick brings a fresh one.
    if (e instanceof TransportError && e.stage === "gate_stale") {
      logWarn("directory_feed", e, { outcome: "stale_props" });
      return "stale_props";
    }
    // Anything else (a decrypt failure included) is a failed mint: the DO's
    // next alarm fails the lane with it, as a mint there would have
    // (classify: transport_<stage>, or backoff "internal" for the rest).
    if (!(e instanceof TransportError)) logWarn("directory_feed_mint", e);
    await stub.handToken(key, {
      error: e instanceof TransportError ? e.stage : "internal",
    });
    return "mint_failed";
  }
  await stub.handToken(key, { token });
  return "fed";
}

/** The one DirectorySync per install. */
export const SYNC_DO_NAME = "install";
