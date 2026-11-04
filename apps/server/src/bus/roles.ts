// Role addresses (#1296): a member-set alias in one namespace (`backend-lead`)
// that points at one agent by its stable id, so it follows a rename. The only
// rerouting on the bus (design Decision 3): a send to a role resolves at send
// time to its holder; the system never guesses one. Only the member sets a
// role (BusHub.putRole, from the dashboard's REST); no frame does.
//
// Adapted from OpenBus v0.63.0 apps/server/src/hub/roles.ts, without the
// agent card's `role` claim or the one-role-per-agent rule. A close does not
// clear the holder (v0.63 did): the role reads vacant while its holder isn't
// open in its namespace (holderOf), and the holder's reopened session holds
// it again, which lasting mailboxes (#1295, #1349) build on.
import {
  BusNameSchema,
  type RefusalReason,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import { BUS_ROLE_MAX, type BusRole } from "@oa/shared";
import { iso } from "./dto.js";
import { AGENT_COLS, type AgentRow } from "./rows.js";

export type RoleResolution =
  | { ok: true; agent: AgentRow; viaRole: true }
  | { ok: false; reason: RefusalReason };

export type PutRoleResult =
  | { ok: true; role: BusRole }
  | { ok: false; reason: "invalid"; field: "namespace" | "name" }
  | { ok: false; reason: "name_taken" | "agent_not_open" | "role_limit" };

type Row = Record<string, SqlStorageValue>;
const all = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] => sql.exec<T>(q, ...b).toArray();
const one = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T | null => all<T>(sql, q, ...b)[0] ?? null;

/**
 * The SQL fragment (and its bindings after `lname`) that is true when a role
 * reserves `lname` from an agent: a role in `namespace`, or for a global
 * agent (visible everywhere) a role in any namespace. A vacant role still
 * reserves its name. For nameTaken (hub.ts).
 */
export function roleTakenSql(
  orgId: string,
  lname: string,
  namespace: string,
  global: boolean,
): { sql: string; binds: SqlStorageValue[] } {
  return global
    ? {
        sql: "exists (select 1 from roles indexed by roles_lname where org_id = ? and lname = ?)",
        binds: [orgId, lname],
      }
    : {
        sql: "exists (select 1 from roles where org_id = ? and namespace = ? and lname = ?)",
        binds: [orgId, namespace, lname],
      };
}

/**
 * The SQL fragment (and its bindings) that is true when a live agent other
 * than `selfId` (null: none) holds `lname` as a chosen former name still in
 * its grace, reserved in the scope of an agent in `namespace` (`global`: in
 * any scope). OpenBus #451: a row reserves in the scope it was left in
 * (former_names namespace, global), not its agent's current one, so a move
 * or flip keeps it reserved where it was. One definition for nameTaken
 * (hub.ts) and putRole, so a role never takes a name an agent couldn't.
 */
export function formerReservedSql(
  orgId: string,
  lname: string,
  now: number,
  namespace: string,
  global: boolean,
  selfId: string | null,
): { sql: string; binds: SqlStorageValue[] } {
  return {
    sql: `exists (select 1 from former_names f join agents a on a.id = f.agent_id
            where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.kind = 'chosen'
              and f.agent_id is not ? and a.live = 1${global ? "" : " and (f.namespace = ? or f.global = 1)"})`,
    binds: [orgId, lname, now, selfId, ...(global ? [] : [namespace])],
  };
}

type StoredRole = {
  id: string;
  namespace: string;
  name: string;
  agentId: string | null;
  setAt: number;
  holderName: string | null;
  held: number;
};

const ROLE_SELECT = `select r.id, r.namespace, r.name, r.agent_id as agentId, r.set_at as setAt,
    h.name as holderName,
    (h.id is not null and h.live = 1 and (h.namespace = r.namespace or h.global = 1)) as held
  from roles r left join agents h on h.id = r.agent_id`;

const roleDto = (r: StoredRole): BusRole => ({
  id: r.id,
  namespace: r.namespace,
  name: r.name,
  agentId: r.agentId,
  holderName: r.holderName,
  vacant: r.held !== 1,
  setAt: iso(r.setAt),
});

/** Every role of the hub (at most `max`), by namespace then name. */
export function listRoles(
  sql: SqlStorage,
  orgId: string,
  max: number = BUS_ROLE_MAX,
): BusRole[] {
  return all<StoredRole>(
    sql,
    `${ROLE_SELECT} where r.org_id = ? order by r.namespace, r.lname limit ?`,
    orgId,
    max,
  ).map(roleDto);
}

/**
 * Sets role (`namespace`, `name`) to `agentId`, or vacates it (null),
 * creating it if needed (a new random id); re-pointing keeps its id, and the
 * stored display name follows the latest call. Refused (nothing written):
 * - invalid (with the field): not a wire namespace, or not a bus name
 *   (reserved names too);
 * - agent_not_open: the agent isn't open, or is neither in `namespace` nor
 *   global;
 * - name_taken: a live agent visible in `namespace` (in it, or a global) has
 *   the name, or a live agent holds it as a chosen former name still in its
 *   grace reserved there (R393b; OpenBus #451: in the scope the name was left
 *   in, formerReservedSql, as nameTaken), any case; or it was minted for an
 *   agent other than `agentId` (OpenBus #446: a minted name is never handed
 *   on, in any scope, so a default former name needs no reservation);
 * - role_limit: `max` roles exist and this would add one.
 */
export function putRole(
  sql: SqlStorage,
  orgId: string,
  namespace: string,
  name: string,
  agentId: string | null,
  now: number,
  newId: () => string,
  max: number = BUS_ROLE_MAX,
): PutRoleResult {
  if (!WireNamespaceSchema.safeParse(namespace).success)
    return { ok: false, reason: "invalid", field: "namespace" };
  if (!BusNameSchema.safeParse(name).success)
    return { ok: false, reason: "invalid", field: "name" };
  const lname = name.toLowerCase();
  if (agentId !== null) {
    const agent = one<{ namespace: string; global: number }>(
      sql,
      "select namespace, global from agents where id = ? and org_id = ? and live = 1",
      agentId,
      orgId,
    );
    if (agent === null || (agent.global !== 1 && agent.namespace !== namespace))
      return { ok: false, reason: "agent_not_open" };
  }
  const former = formerReservedSql(orgId, lname, now, namespace, false, null);
  const taken = one<{ x: number }>(
    sql,
    `select (exists (select 1 from agents where org_id = ? and lower(name) = ? and live = 1 and (namespace = ? or global = 1))
         or ${former.sql}
         or exists (select 1 from minted_names where org_id = ? and lname = ? and agent_id is not ?)) as x`,
    orgId,
    lname,
    namespace,
    ...former.binds,
    orgId,
    lname,
    agentId,
  );
  if (taken?.x === 1) return { ok: false, reason: "name_taken" };
  const existing = one<{ id: string }>(
    sql,
    "select id from roles where org_id = ? and namespace = ? and lname = ?",
    orgId,
    namespace,
    lname,
  );
  if (
    existing === null &&
    (one<{ n: number }>(
      sql,
      "select count(*) as n from roles where org_id = ?",
      orgId,
    )?.n ?? 0) >= max
  )
    return { ok: false, reason: "role_limit" };
  const id = existing?.id ?? newId();
  sql.exec(
    `insert into roles (id, org_id, namespace, name, lname, agent_id, set_at) values (?, ?, ?, ?, ?, ?, ?)
     on conflict (org_id, namespace, lname) do update set name = excluded.name, agent_id = excluded.agent_id, set_at = excluded.set_at`,
    id,
    orgId,
    namespace,
    name,
    lname,
    agentId,
    now,
  );
  const row = one<StoredRole>(sql, `${ROLE_SELECT} where r.id = ?`, id);
  if (row === null) throw new Error("role row missing after write");
  return { ok: true, role: roleDto(row) };
}

/** Removes role `id`; false when there was none. The name is free at once. */
export function deleteRole(
  sql: SqlStorage,
  orgId: string,
  id: string,
): boolean {
  return (
    sql.exec("delete from roles where org_id = ? and id = ?", orgId, id)
      .rowsWritten > 0
  );
}

/** Role `lname` in `ns` resolved: its holder, or role_vacant. */
function holderOf(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  lname: string,
): RoleResolution {
  const agent = one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where id =
       (select r.agent_id from roles r where r.org_id = ? and r.namespace = ? and r.lname = ?)
       and live = 1 and (namespace = ? or global = 1)`,
    orgId,
    ns,
    lname,
    ns,
  );
  return agent
    ? { ok: true, agent, viaRole: true }
    : { ok: false, reason: "role_vacant" };
}

const roleIn = (sql: SqlStorage, orgId: string, ns: string, lname: string) =>
  one(
    sql,
    "select 1 as x from roles where org_id = ? and namespace = ? and lname = ?",
    orgId,
    ns,
    lname,
  ) !== null;

/**
 * The role `lname` in namespace `ns`, resolved, or null when `ns` has no such
 * role (name resolution runs). Within a scope a role comes first: no live
 * agent can share its name there.
 */
export function resolveRoleIn(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  lname: string,
): RoleResolution | null {
  return roleIn(sql, orgId, ns, lname) ? holderOf(sql, orgId, ns, lname) : null;
}

/**
 * A global sender's role target outside its own namespace (no to_namespace),
 * or null when no namespace has a role `lname`. A role in two namespaces is
 * ambiguous; so is one role while a live agent elsewhere has the name
 * (`elsewhere`: hub.ts checks current and former names outside the role's
 * scope). The system never picks one.
 */
export function resolveRoleAnywhere(
  sql: SqlStorage,
  orgId: string,
  lname: string,
  elsewhere: (ns: string) => boolean,
): RoleResolution | null {
  const hits = all<{ namespace: string }>(
    sql,
    "select namespace from roles indexed by roles_lname where org_id = ? and lname = ? limit 2",
    orgId,
    lname,
  );
  const hit = hits[0];
  if (hit === undefined) return null;
  if (hits.length > 1 || elsewhere(hit.namespace))
    return { ok: false, reason: "ambiguous" };
  return holderOf(sql, orgId, hit.namespace, lname);
}
