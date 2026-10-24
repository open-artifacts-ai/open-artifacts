import { normalizeEmail } from "@oa/auth-core";
import { newId } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import type { AuditActor } from "../services/audit.js";
import { setUserStatus } from "../services/members.js";
import { type GoogleUser, listUsers } from "./google.js";
import { putInitial, readInitial } from "./store.js";

// The initial binding (P3 T12): right after connect, a full users.list links
// every directory user to an install user through identities('google', id)
// (directory_bound = 1), creating the user row when none exists. Email
// matching is allowed in this one pass only (binding.initial.done): every
// later pass (T13/T14) matches by directory id alone, so a recycled address
// never inherits an old row.
// - A user row matched by email is linked only when it has no Google
//   identity yet (an address already bound to another Google id stays put).
// - New rows are created only for active users whose address is in
//   AUTH_DOMAINS (the sign-in allow-list), as members. While any restricted
//   group exists they start restricted (fail closed); T13's first reconcile
//   recomputes restricted_sync from the groups.
// - A linked user who is suspended in Google is suspended here
//   (suspensions always apply), through setUserStatus (sessions, tokens,
//   grants and sockets revoked).
// - Bounded per request: INITIAL_PAGES pages of 500; the cursor is kept for
//   T13 to finish (afterDirectoryConnect).

export const INITIAL_PAGES = 4;
/** Suspensions applied inline per page; the rest wait for T13's first run. */
export const SUSPEND_PER_PAGE = 25;
const SYNC: AuditActor = { kind: "sync", id: null };

const ID = "json_extract(j.value, '$.id')";
const EMAIL = "json_extract(j.value, '$.email')";

/** Already linked through the directory id: mark it bound. */
const MARK_BOUND = `update identities set directory_bound = 1
  where provider = 'google' and directory_bound = 0
    and subject in (select ${ID} from json_each(?1) j)`;

/** Email match (initial pass only), never onto a user with a Google identity. */
const LINK_BY_EMAIL = `insert or ignore into identities
  (provider, subject, tenant, user_id, created_at, directory_bound)
  select 'google', ${ID}, ?2, u.id, ?3, 1
  from json_each(?1) j join users u on u.email = ${EMAIL}
  where not exists (select 1 from identities i
                    where i.provider = 'google' and i.subject = ${ID})
    and not exists (select 1 from identities i
                    where i.provider = 'google' and i.user_id = u.id)`;

/**
 * New rows for unknown directory users (the trigger adds the personal
 * space). An existing address is never reused here: without the email pass,
 * T14's new-id rule decides what happens to it.
 */
const CREATE_USERS = `insert or ignore into users
  (id, email, name, role, created_at, status, restricted_sync)
  select json_extract(j.value, '$.uid'), ${EMAIL},
         json_extract(j.value, '$.name'), 'member', ?2, 'active',
         (select exists (select 1 from restricted_groups))
  from json_each(?1) j
  where not exists (select 1 from users u where u.email = ${EMAIL})
    and not exists (select 1 from identities i
                    where i.provider = 'google' and i.subject = ${ID})`;

/** The identities of the rows CREATE_USERS just wrote. */
const LINK_CREATED = `insert or ignore into identities
  (provider, subject, tenant, user_id, created_at, directory_bound)
  select 'google', ${ID}, ?2, u.id, ?3, 1
  from json_each(?1) j join users u on u.id = json_extract(j.value, '$.uid')
  where not exists (select 1 from identities i
                    where i.provider = 'google' and i.subject = ${ID})`;

/** Active install users bound to a suspended directory user. */
const SUSPENDED_LINKED = `select i.user_id id from identities i
  join users u on u.id = i.user_id
  where i.provider = 'google' and u.status = 'active'
    and i.subject in (select value from json_each(?1))
  limit ${SUSPEND_PER_PAGE}`;

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/**
 * The Worker-side work for one page (no I/O): normalized addresses, the
 * rows to create (in-domain, active, with fresh ids) and the suspended ids.
 */
export function planPage(domains: ReadonlySet<string>, page: GoogleUser[]) {
  const all: { id: string; email: string }[] = [];
  const create: { id: string; email: string; uid: string; name: string }[] = [];
  const suspended: string[] = [];
  for (const u of page) {
    const email = normalizeEmail(u.primaryEmail);
    if (!email) continue;
    all.push({ id: u.id, email });
    if (u.suspended) suspended.push(u.id);
    else if (domains.has(domainOf(email)))
      create.push({
        id: u.id,
        email,
        uid: newId(),
        name: email.slice(0, email.indexOf("@")),
      });
  }
  return { all, create, suspended };
}

/** Links (and creates) one page of directory users in one batch. */
export async function bindPage(
  env: Env,
  page: GoogleUser[],
  o: {
    tenant: string;
    allowEmail: boolean;
    ctx?: Pick<ExecutionContext, "waitUntil">;
  },
): Promise<void> {
  const { all, create, suspended } = planPage(
    new Set(authConfig(env).domains),
    page,
  );
  if (all.length === 0) return;
  const now = Date.now();
  const allJson = JSON.stringify(all);
  const createJson = JSON.stringify(create);
  await env.DB.batch([
    stmt(env.DB, MARK_BOUND).bind(allJson),
    ...(o.allowEmail
      ? [stmt(env.DB, LINK_BY_EMAIL).bind(allJson, o.tenant, now)]
      : []),
    ...(create.length
      ? [
          stmt(env.DB, CREATE_USERS).bind(createJson, now),
          stmt(env.DB, LINK_CREATED).bind(createJson, o.tenant, now),
        ]
      : []),
  ]);
  if (suspended.length === 0) return;
  const { results } = await stmt(env.DB, SUSPENDED_LINKED)
    .bind(JSON.stringify(suspended))
    .all<{ id: string }>();
  for (const r of results)
    await setUserStatus(
      env,
      r.id,
      "suspended",
      "directory_suspend",
      o.ctx,
      SYNC,
    );
}

/**
 * The initial binding pass for `customerId`, up to INITIAL_PAGES pages.
 * Resolves to the pass state left behind: done, or a cursor for T13.
 * A Google failure keeps the cursor (the binding itself is already stored).
 */
export async function initialBinding(
  env: Env,
  token: string,
  customerId: string,
  tenant: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<{ done: boolean; cursor: string | null }> {
  const prior = await readInitial(env);
  // Email matching only while the first pass has never completed.
  const allowEmail = !prior.done;
  let cursor = prior.done ? null : prior.cursor;
  let done = false;
  try {
    for (let i = 0; i < INITIAL_PAGES; i++) {
      const page = await listUsers(token, customerId, cursor ?? undefined);
      await bindPage(env, page.users, { tenant, allowEmail, ctx });
      cursor = page.nextPageToken;
      if (!cursor) {
        done = true;
        break;
      }
    }
  } catch (e) {
    logWarn("directory_initial_binding", e);
  }
  const state = { done: done || prior.done, cursor: done ? null : cursor };
  await putInitial(env, state).run();
  logInfo("directory_initial_binding", { done: state.done });
  return state;
}
