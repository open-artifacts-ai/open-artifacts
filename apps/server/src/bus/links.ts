// Project links (#1567): the member allows two namespaces to see each other's
// agents and message each other. A link is one `grants` row of kind 'link',
// stored as a sorted pair (ns_a < ns_b) and read both ways. Direct only: a
// link A-B and a link B-C never join A and C. Only the member writes one
// (BusHub.putLink, from the dashboard's REST); no frame and no MCP tool does.
import { WireNamespaceSchema } from "@oa/bus-protocol";
import {
  BUS_LINK_MAX,
  BUS_LINKS_PER_NAMESPACE,
  type BusLink,
} from "@oa/shared";
import { iso } from "./dto.js";

export type PutLinkResult =
  | { ok: true; link: BusLink }
  | { ok: false; reason: "invalid"; field: "a" | "b" | "namespaces" }
  | { ok: false; reason: "link_limit" };

type Row = Record<string, SqlStorageValue>;
const all = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] => sql.exec<T>(q, ...b).toArray();

type StoredLink = { id: string; a: string; b: string; createdAt: number };

const linkDto = (r: StoredLink): BusLink => ({
  id: r.id,
  a: r.a,
  b: r.b,
  createdAt: iso(r.createdAt),
});

/** The namespaces directly linked to `ns` (never transitive), sorted. Two indexed probes. */
export function linkedNamespaces(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  max = BUS_LINK_MAX,
): string[] {
  return all<{ ns: string }>(
    sql,
    `select ns from (
       select ns_b as ns from grants where org_id = ? and kind = 'link' and ns_a = ?
       union
       select ns_a as ns from grants where org_id = ? and kind = 'link' and ns_b = ?
     ) order by ns limit ?`,
    orgId,
    ns,
    orgId,
    ns,
    max,
  ).map((r) => r.ns);
}

/** True when `a` and `b` are directly linked. */
export function isLinked(
  sql: SqlStorage,
  orgId: string,
  a: string,
  b: string,
): boolean {
  const [x, y] = a < b ? [a, b] : [b, a];
  return (
    all(
      sql,
      "select 1 as x from grants where org_id = ? and kind = 'link' and ns_a = ? and ns_b = ?",
      orgId,
      x,
      y,
    ).length > 0
  );
}

/** Every link of the hub (at most `max`), by `a` then `b`. */
export function listLinks(
  sql: SqlStorage,
  orgId: string,
  max = BUS_LINK_MAX,
): BusLink[] {
  return all<StoredLink>(
    sql,
    `select id, ns_a as a, ns_b as b, created_at as createdAt from grants
      where org_id = ? and kind = 'link' order by ns_a, ns_b limit ?`,
    orgId,
    max,
  ).map(linkDto);
}

/**
 * Links `a` and `b`. Idempotent: an existing link is returned as it is.
 * Refuses a namespace that is not canonical, the same namespace twice, and
 * a link past `max` or past `perNamespace` on either side.
 */
export function addLink(
  sql: SqlStorage,
  orgId: string,
  a: string,
  b: string,
  now: number,
  newId: () => string,
  max = BUS_LINK_MAX,
  perNamespace = BUS_LINKS_PER_NAMESPACE,
): PutLinkResult {
  if (!WireNamespaceSchema.safeParse(a).success)
    return { ok: false, reason: "invalid", field: "a" };
  if (!WireNamespaceSchema.safeParse(b).success)
    return { ok: false, reason: "invalid", field: "b" };
  if (a === b) return { ok: false, reason: "invalid", field: "namespaces" };
  const [x, y] = a < b ? [a, b] : [b, a];
  const read = () =>
    all<StoredLink>(
      sql,
      `select id, ns_a as a, ns_b as b, created_at as createdAt from grants
        where org_id = ? and kind = 'link' and ns_a = ? and ns_b = ?`,
      orgId,
      x,
      y,
    )[0];
  const had = read();
  if (had) return { ok: true, link: linkDto(had) };
  const n = all<{ n: number }>(
    sql,
    "select count(*) as n from grants where org_id = ? and kind = 'link'",
    orgId,
  )[0]?.n;
  if ((n ?? 0) >= max) return { ok: false, reason: "link_limit" };
  // Either side already has its share of links.
  for (const ns of [x, y])
    if (linkedNamespaces(sql, orgId, ns, perNamespace).length >= perNamespace)
      return { ok: false, reason: "link_limit" };
  sql.exec(
    "insert into grants (id, org_id, kind, ns_a, ns_b, created_at) values (?, ?, 'link', ?, ?, ?)",
    newId(),
    orgId,
    x,
    y,
    now,
  );
  const link = read();
  if (!link) throw new Error("link not stored");
  return { ok: true, link: linkDto(link) };
}

/** Removes link `id`; returns its namespaces, or null when unknown. */
export function removeLink(
  sql: SqlStorage,
  orgId: string,
  id: string,
): { a: string; b: string } | null {
  const row = all<{ a: string; b: string }>(
    sql,
    "select ns_a as a, ns_b as b from grants where org_id = ? and kind = 'link' and id = ?",
    orgId,
    id,
  )[0];
  if (!row) return null;
  sql.exec(
    "delete from grants where org_id = ? and kind = 'link' and id = ?",
    orgId,
    id,
  );
  return row;
}
