// Parity 2: one-time notices for the org owner (Me.notices). Each is
// computed live and stays hidden for good once dismissed (a settings row,
// once per install).
import {
  GUEST_SHARES_NOTICE_LIMIT,
  type GuestSharesNotice,
  type MeNotices,
  type NoticeId,
} from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

/** The settings row that marks `id` dismissed for this install. */
export const noticeKey = (id: NoticeId): string => `notice_dismissed:${id}`;

const DISMISS = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/** Marks `id` dismissed for this install (idempotent; the first time is kept). */
export async function dismissNotice(env: Env, id: NoticeId): Promise<void> {
  await stmt(env.DB, DISMISS).bind(noticeKey(id), String(Date.now())).run();
}

/**
 * Shares an active guest holds above viewer, on live artifacts: the guest cap
 * reads them as viewer, while the row keeps its role. Newest share first; one
 * row past the limit says there are more.
 */
const GUEST_SHARES = `select s.artifact_id as artifactId, a.title as title,
    s.email as guestEmail, s.role as role
  from shares s
  join users u on u.email = s.email
  join artifacts a on a.id = s.artifact_id
  where u.role = 'guest' and u.status = 'active'
    and s.role <> 'viewer' and a.deleted_at is null
  order by s.created_at desc, s.artifact_id, s.email
  limit ?1`;

type Row = {
  artifactId: string;
  title: string;
  guestEmail: string;
  role: string;
};

/** Me.notices.guestShares, or null when no guest holds a share above viewer. */
export async function guestSharesNotice(
  env: Env,
): Promise<GuestSharesNotice | null> {
  const { results } = await stmt(env.DB, GUEST_SHARES)
    .bind(GUEST_SHARES_NOTICE_LIMIT + 1)
    .all<Row>();
  // Only the roles above viewer the contract names (fail closed on others).
  const rows = results.filter(
    (r): r is Row & { role: "editor" } => r.role === "editor",
  );
  if (rows.length === 0) return null;
  return {
    items: rows.slice(0, GUEST_SHARES_NOTICE_LIMIT).map((r) => ({
      artifactId: r.artifactId,
      title: r.title,
      guestEmail: r.guestEmail,
      role: r.role,
    })),
    more: rows.length > GUEST_SHARES_NOTICE_LIMIT,
  };
}

/**
 * Me.notices for the org owner (the caller checks), or null when none is
 * present. `kv` is the settings rows /me already read. Never on hosted:
 * guests there were always capped, so no share changed.
 */
export async function ownerNotices(
  env: Env,
  kv: Map<string, string>,
): Promise<MeNotices | null> {
  if (env.HOSTED === "1") return null;
  if (kv.has(noticeKey("guest_shares"))) return null;
  const guestShares = await guestSharesNotice(env);
  return guestShares ? { guestShares } : null;
}
