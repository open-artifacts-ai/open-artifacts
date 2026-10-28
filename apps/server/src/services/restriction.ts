import {
  type GroupRef,
  type IdentityProvider,
  IdentityProviderSchema,
  type Restriction,
} from "@oa/shared";

// users.restricted_sync (P3 T9): 1 while the user is in any restricted group,
// never for an org owner or admin (restrict_admin; sync skips them). One
// definition, recomputed wherever its inputs change: a restricted group added
// or removed (every member of that group) and a role change (that user).

/** The flag's value for the `users` row in scope. */
export const RESTRICTED_SYNC_CASE = `(case
    when users.role in ('owner', 'admin') then 0
    when exists (select 1 from directory_members dm join restricted_groups rg on rg.group_id = dm.group_id
      where dm.user_id = users.id) then 1
    else 0 end)`;

/** Recomputes the flag for every member of group ?1 (only rows that change). */
export const RESTRICTED_SYNC_FOR_GROUP = `update users set restricted_sync = ${RESTRICTED_SYNC_CASE}
  where id in (select user_id from directory_members where group_id = ?1)
    and restricted_sync <> ${RESTRICTED_SYNC_CASE}`;

/**
 * Recomputes the flag for user ?1, returning the new value only when it
 * changed (no row = unchanged), so the caller knows a cap was just raised.
 */
export const RESTRICTED_SYNC_FOR_USER = `update users set restricted_sync = ${RESTRICTED_SYNC_CASE}
  where id = ?1 and restricted_sync <> ${RESTRICTED_SYNC_CASE}
  returning restricted_sync as restrictedSync`;

/** The `groups` column of MEMBER_EXTRAS_COLS for the users row aliased `u`. */
export const restrictedGroupsSql = (
  u: string,
) => `(case when ${u}.restricted_sync <> 0 then (
    select json_group_array(json_object('groupId', rg.group_id, 'email', rg.group_email))
    from restricted_groups rg join directory_members dm
      on dm.group_id = rg.group_id and dm.user_id = ${u}.id) end)`;
/** The `idents` column of MEMBER_EXTRAS_COLS for the users row aliased `u`. */
export const identitiesSql = (u: string) =>
  `(select json_group_array(i.provider) from identities i where i.user_id = ${u}.id)`;
export const RESTRICTED_GROUPS_SQL = restrictedGroupsSql("users");
export const IDENTITIES_SQL = identitiesSql("users");
/**
 * Member.restriction and Member.identities as columns of the `users` row in
 * scope, in the same query (no per-member round trip): `rm` (the manual
 * flag), `groups` (JSON of the restricted groups the user is in; null unless
 * restricted_sync is on, so owners and admins never list one) and `idents`
 * (JSON provider list). Read them back with restrictionOf / identitiesOf.
 */
export const MEMBER_EXTRAS_COLS = `users.restricted_manual as rm,
  ${RESTRICTED_GROUPS_SQL} as groups, ${IDENTITIES_SQL} as idents`;

export type MemberExtrasRow = {
  rm: number | null;
  groups: string | null;
  idents?: string | null;
};

const parseList = (s: string | null | undefined): unknown[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** The restriction from MEMBER_EXTRAS_COLS: null when neither the flag nor a group applies. */
export function restrictionOf(r: MemberExtrasRow): Restriction | null {
  const groups: GroupRef[] = parseList(r.groups).flatMap((g) => {
    const o = (g ?? {}) as { groupId?: unknown; email?: unknown };
    return typeof o.groupId === "string" && typeof o.email === "string"
      ? [{ groupId: o.groupId, email: o.email, name: null }]
      : [];
  });
  groups.sort((a, b) =>
    a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
  );
  const manual = (r.rm ?? 0) !== 0;
  return manual || groups.length ? { manual, groups } : null;
}

/** The linked identities from MEMBER_EXTRAS_COLS (known providers, sorted). */
export function identitiesOf(r: MemberExtrasRow): IdentityProvider[] {
  return parseList(r.idents)
    .filter(
      (p): p is IdentityProvider => IdentityProviderSchema.safeParse(p).success,
    )
    .sort();
}
