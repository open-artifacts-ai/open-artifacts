import type { DirectoryBinding, Member } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import type { AuditActor } from "../services/audit.js";
import { SYSTEM_ACTOR, setUserStatus } from "../services/members.js";
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
import { readBinding } from "./store.js";

// The sign-in refresh (P3 T14): after P2 admits a Google sign-in, that one
// user is re-read from the directory by their bound identity (Google `sub`
// is the directory user id) and their groups are diffed.
// - Suspended, deleted or another customer's user in Google: refused (a
//   suspension is applied at once).
// - Google unreachable: the sign-in proceeds on last-sync access (fail
//   static), unless the install is in customer_mismatch. Any other failure
//   (a D1 read, a write) refuses, fail closed. The org owner is never
//   refused (break-glass, T18 limits their routes); during a mismatch they
//   get in without a group diff.
// - Groups: the targets (mapped or restricted) the user belongs to, through
//   nesting (directory_groups.parent_ids), against their directory_members
//   rows. A removal is confirmed with groups.hasMember first, so a nested
//   group sync hasn't seen yet never removes anyone. Frozen: no group sync.

const SYNC: AuditActor = { kind: "sync", id: null };
/** userGroups pages read at sign-in; more and nobody is removed. */
const SIGNIN_GROUP_PAGES = 5;

/** The sign-in is refused (P2's callback turns it into a sign-in error). */
export class SignInRefused extends Error {
  constructor(
    public why: "suspended" | "gone" | "customer_mismatch" | "unverified",
  ) {
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

/** sync.state (async: a failure is a rejection, never a sync throw). */
async function readState(env: Env): Promise<string | null> {
  const r = await stmt(env.DB, STATE).bind(HK.state).first<{ value: string }>();
  return r?.value ?? null;
}

/** group_id rows of `sql` bound to `arg` (async, as readState). */
async function groupRows(env: Env, sql: string, arg: string) {
  return stmt(env.DB, sql).bind(arg).all<{ group_id: string }>();
}

/**
 * The binding this sign-in read is still the live one. A reconnect waiting
 * for confirm doesn't matter: the live binding is enforced until the swap
 * (P2.5 #15), which changes connectedAt.
 */
async function sameBinding(env: Env, b: DirectoryBinding): Promise<boolean> {
  const { binding } = await readBinding(env);
  return (
    !!binding &&
    binding.customerId === b.customerId &&
    binding.connectedAt === b.connectedAt
  );
}

export async function directorySignIn(
  env: Env,
  user: Member,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const mode = directoryMode(env);
  if (mode === "off") return;
  const client = directoryClient(env);
  if (!client) return;
  // Fail closed: a D1 error reading who this is refuses the sign-in.
  let bound: { subject: string; owner: number } | null;
  try {
    bound = await stmt(env.DB, SUBJECT_OF)
      .bind(user.id)
      .first<{ subject: string; owner: number }>();
  } catch (e) {
    logWarn("directory_signin_read", e);
    throw new SignInRefused("unverified");
  }
  if (!bound) return;
  const owner = !!bound.owner;
  const sub = bound.subject;
  // From here a failure refuses everyone but the org owner (break-glass,
  // T18 limits their routes), except Google being unreachable outside
  // customer_mismatch (fail static).
  let mismatch = false;
  try {
    // Every read is an async call, so none throws while the array is built
    // and leaves another's rejection unhandled.
    const [{ binding, sealed }, state] = await Promise.all([
      readBinding(env),
      readState(env),
    ]);
    // No live binding (never connected, or a first connect waiting for its
    // owner): nothing to check against. A reconnect waiting for confirm
    // keeps the live binding enforced (P2.5 #15).
    if (!binding || !sealed) return;
    mismatch = state === "customer_mismatch";
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
      // Groups only for this customer's active user: the gone, customer and
      // suspended checks below never wait on (or get skipped by) userGroups.
      if (
        u &&
        u.id === sub &&
        u.customerId === binding.customerId &&
        !u.suspended &&
        mode === "google"
      ) {
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
      if (mismatch) throw e;
      logWarn("directory_signin_unreachable", e);
      return;
    }
    // The owner is never suspended or removed; during a mismatch (or another
    // customer's answer) they get in without a group diff.
    if (owner && (mismatch || !u || u.customerId !== binding.customerId))
      return;
    if (!u) throw new SignInRefused("gone");
    // Google sub == directory user id, and the binding's customer only.
    if (u.id !== sub || u.customerId !== binding.customerId)
      throw new SignInRefused("customer_mismatch");
    if (u.suspended && !owner) {
      // Refused even when the write fails (the next reconcile retries it).
      await setUserStatus(
        env,
        user.id,
        "suspended",
        "directory_suspend",
        SYSTEM_ACTOR,
        ctx,
      ).catch((e) => logWarn("directory_signin_suspend", e));
      throw new SignInRefused("suspended");
    }
    if (mismatch || !direct) return;
    await signInGroups(env, binding, user.id, sub, direct, partial, token, ctx);
  } catch (e) {
    if (e instanceof SignInRefused) throw e;
    if (owner) {
      logWarn("directory_signin_owner", e);
      return;
    }
    if (mismatch) throw new SignInRefused("customer_mismatch");
    logWarn("directory_signin_read", e);
    throw new SignInRefused("unverified");
  }
}

/**
 * One user's group diff. Every removal is confirmed (hasMember) before any
 * write, so a failure removes nobody. The DirectorySync epoch lives in its
 * DO; a reset only follows a binding swap or disconnect, so each write is
 * gated on the binding read at sign-in still being the live one (and no
 * consent pending). A diff that races a swap anyway is swept by the next
 * reconcile, which recomputes every row from the new binding.
 */
async function signInGroups(
  env: Env,
  b: DirectoryBinding,
  uid: string,
  sub: string,
  ids: string[],
  partial: boolean,
  token: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const [reached, current] = await Promise.all([
    groupRows(env, REACHED, JSON.stringify(ids)),
    groupRows(env, CURRENT, uid),
  ]);
  const want = new Set(reached.results.map((r) => r.group_id));
  const have = new Set(current.results.map((r) => r.group_id));
  const adds = [...want].filter((x) => !have.has(x));
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
  for (const [gid, add] of [
    ...adds.map((g) => [g, true] as const),
    ...drops.map((g) => [g, false] as const),
  ]) {
    if (!(await sameBinding(env, b))) return;
    await applyGroupDiff(env, gid, add ? [uid] : [], add ? [] : [uid], SYNC, {
      ctx,
    });
  }
}
