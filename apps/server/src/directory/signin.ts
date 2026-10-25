import type { Member } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import type { AuditActor } from "../services/audit.js";
import { setUserStatus } from "../services/members.js";
import { directoryMode } from "../services/spaces.js";
import { applyGroupDiff } from "./apply.js";
import { directoryClient } from "./client.js";
import {
  GoogleApiError,
  type GoogleUser,
  getUser,
  hasMember,
  userGroups,
} from "./google.js";
import { HK } from "./health.js";
import { readBinding, readPending } from "./store.js";

// The sign-in refresh (P3 T14): after P2 admits a Google sign-in, that one
// user is re-read from the directory by their bound identity (Google `sub`
// is the directory user id) and their groups are diffed.
// - Suspended, deleted or another customer's user in Google: refused (a
//   suspension is applied at once).
// - Google unreachable: the sign-in proceeds on last-sync access (fail
//   static), unless the install is in customer_mismatch (fail closed; the
//   org owner still gets through for break-glass, T18).
// - Groups: the targets (mapped or restricted) the user belongs to, through
//   nesting (directory_groups.parent_ids), against their directory_members
//   rows. A removal is confirmed with groups.hasMember first, so a nested
//   group sync hasn't seen yet never removes anyone. Frozen: no group sync.

const SYNC: AuditActor = { kind: "sync", id: null };
/** userGroups pages read at sign-in; more and nobody is removed. */
const SIGNIN_GROUP_PAGES = 5;

/** The sign-in is refused (P2's callback turns it into a sign-in error). */
export class SignInRefused extends Error {
  constructor(public why: "suspended" | "gone" | "customer_mismatch") {
    super(`directory sign-in refused: ${why}`);
    this.name = "SignInRefused";
  }
}

/** The bound directory id, and whether this is the org owner (break-glass). */
const SUBJECT_OF = `select i.subject, u.role = 'owner' as owner from identities i
  join users u on u.id = i.user_id
  where i.provider = 'google' and i.user_id = ?1 and i.directory_bound = 1`;
const STATE = "select value from directory_state where key = ?1";
/** Targets reached from the user's direct groups (?1), through parents. */
const REACHED = `with recursive up(g) as (
    select value from json_each(?1)
    union
    select p.value from up join directory_groups dg on dg.group_id = up.g,
      json_each(dg.parent_ids) p
  )
  select distinct g as group_id from up
  where g in (select group_id from group_mappings
      union select group_id from org_group_mappings
      union select group_id from restricted_groups)
    and g in (select group_id from directory_groups)`;
const CURRENT = "select group_id from directory_members where user_id = ?1";

export async function directorySignIn(
  env: Env,
  user: Member,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const mode = directoryMode(env);
  if (mode === "off") return;
  const client = directoryClient(env);
  if (!client) return;
  const [{ binding, sealed }, pending, bound, state] = await Promise.all([
    readBinding(env),
    readPending(env),
    stmt(env.DB, SUBJECT_OF)
      .bind(user.id)
      .first<{ subject: string; owner: number }>(),
    stmt(env.DB, STATE)
      .bind(HK.state)
      .first<{ value: string }>()
      .then((r) => r?.value ?? null),
  ]);
  if (!binding || !sealed || pending || !bound) return;
  const sub = bound.subject;
  const mismatch = state === "customer_mismatch";
  let u: GoogleUser | null = null;
  let token = "";
  let direct: string[] | null = null;
  let partial = false;
  try {
    token = await client.accessToken(sealed);
    try {
      u = await getUser(token, sub);
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.status === 404)) throw e;
    }
    if (u && !u.suspended && mode === "google") {
      direct = [];
      let page: string | undefined;
      for (let i = 0; i < SIGNIN_GROUP_PAGES; i++) {
        const out = await userGroups(token, sub, page);
        direct.push(...out.groups.map((x) => x.id));
        page = out.nextPageToken ?? undefined;
        if (!page) break;
      }
      // Too many groups to read whole: adds only.
      partial = !!page;
    }
  } catch (e) {
    if (mismatch && !bound.owner) throw new SignInRefused("customer_mismatch");
    logWarn("directory_signin_unreachable", e);
    return;
  }
  if (!u) throw new SignInRefused("gone");
  // Google sub == directory user id, and the binding's customer only.
  if (u.id !== sub || u.customerId !== binding.customerId)
    throw new SignInRefused("customer_mismatch");
  if (u.suspended) {
    await setUserStatus(
      env,
      user.id,
      "suspended",
      "directory_suspend",
      ctx,
      SYNC,
    );
    throw new SignInRefused("suspended");
  }
  if (direct)
    await signInGroups(env, user.id, sub, direct, partial, token, ctx);
}

async function signInGroups(
  env: Env,
  uid: string,
  sub: string,
  ids: string[],
  partial: boolean,
  token: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const [reached, current] = await Promise.all([
    stmt(env.DB, REACHED).bind(JSON.stringify(ids)).all<{ group_id: string }>(),
    stmt(env.DB, CURRENT).bind(uid).all<{ group_id: string }>(),
  ]);
  const want = new Set(reached.results.map((r) => r.group_id));
  const have = new Set(current.results.map((r) => r.group_id));
  const adds = [...want].filter((x) => !have.has(x));
  // Every removal confirmed before any write: a failure removes nobody.
  const drops: string[] = [];
  if (!partial)
    for (const gid of [...have].filter((x) => !want.has(x))) {
      try {
        if (!(await hasMember(token, gid, sub))) drops.push(gid);
      } catch (e) {
        logWarn("directory_signin_has_member", e);
        drops.length = 0;
        break;
      }
    }
  for (const gid of adds)
    await applyGroupDiff(env, gid, [uid], [], SYNC, { ctx });
  for (const gid of drops)
    await applyGroupDiff(env, gid, [], [uid], SYNC, { ctx });
}
