import type { Member } from "@oa/shared";
import type { Env } from "../env.js";

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
  _env: Env,
  _pass: { initialDone: boolean },
): Promise<void> {}
