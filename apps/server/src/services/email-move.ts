import { normalizeEmail } from "@oa/auth-core";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

// The one way a user's address changes (P3 T14; manager ruling on #592):
// shares follow the person. `shares` is keyed by address only (no user_id
// column; invites are shares), so in the same batch as the move every share
// on the old address is re-keyed to the new one, the higher role winning on
// a conflict. Every share write is gated on the row having moved and on
// nobody holding the old address, so a freed address inherits nothing and a
// stale read never re-keys a new holder's shares. Callers: sign-in drift
// (services/identity.ts followDrift) and directory sync (directory/apply.ts).
// The deletion treatment's placeholder address is the only other users.email
// write: it drops the address's shares in its own batch.

const MOVE = `update users set email = ?2
  where id = ?1 and email = ?3 and status <> 'removed'
    and not exists (select 1 from users where email = ?2)
  returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, status`;
const MOVED = `exists (select 1 from users where id = ?1 and email = ?2)
  and not exists (select 1 from users where email = ?3)`;
const COPY_SHARES = `insert into shares (artifact_id, email, role, created_by, created_at)
  select artifact_id, ?2, role, created_by, created_at from shares
  where email = ?3 and ${MOVED}
  on conflict (artifact_id, email) do update set role = 'editor'
  where shares.role <> 'editor' and excluded.role = 'editor'`;
const DROP_OLD_SHARES = `delete from shares where email = ?3 and ${MOVED}`;

export type MovedRow = {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  role: string;
  lastSeenAt: number | null;
  status: string;
};

/**
 * Moves user `uid` from `from` to `to`, with their shares, in one batch.
 * Never onto OWNER_EMAIL (no path may hand anyone the owner address).
 * Resolves to the moved row, or null when it did not move (the address is
 * taken, the row is removed or no longer at `from`). The person's access
 * only stays or widens.
 */
export async function moveUserEmail(
  env: Env,
  uid: string,
  from: string,
  to: string,
): Promise<MovedRow | null> {
  if (to === from || to === normalizeEmail(env.OWNER_EMAIL ?? "")) return null;
  const out = await env.DB.batch([
    stmt(env.DB, MOVE).bind(uid, to, from),
    stmt(env.DB, COPY_SHARES).bind(uid, to, from),
    stmt(env.DB, DROP_OLD_SHARES).bind(uid, to, from),
  ]);
  return (out[0]?.results[0] as MovedRow | undefined) ?? null;
}
