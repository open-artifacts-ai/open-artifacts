import type { Member } from "@oa/shared";
import type { Env } from "../env.js";

/**
 * P3 seam: called after every successful Google admission, before the
 * session is issued (P3 diffs groups.list for this user). P2 lands the
 * signature; P3 owns the body. A throw is logged and never blocks sign-in.
 */
export async function onGoogleSignIn(_env: Env, _user: Member): Promise<void> {}

/**
 * P3 T13 seam: called once a directory connect has stored its binding and
 * sealed refresh token and run the initial binding pass (directory/
 * binding.ts). T13's DirectorySync takes over here: it kicks its first
 * reconcile (restricted groups, suspensions beyond the inline cap) and, when
 * `initialDone` is false, finishes the pass from binding.initial's cursor
 * (email matching still allowed until that pass completes). A throw is
 * logged; the connection stands.
 */
export async function afterDirectoryConnect(
  _env: Env,
  _pass: { initialDone: boolean },
): Promise<void> {}
