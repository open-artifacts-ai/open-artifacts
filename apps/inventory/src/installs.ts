import { parseHostsValue } from "@oa/provision/names";
import { InventoryInstallsSchema } from "@oa/shared/provisioning";
import { getMany } from "./hosts.ts";
import { type D1Like, internal, json, type KvReadLike } from "./http.ts";

// GET /installs: every install, its API state from the install_status view
// (0008) and its live HOSTS mode.

interface Row {
  install_id: string;
  app_host: string | null;
  content_host: string | null;
  state: string;
  test_hooks: number | null;
}

// Every row, hostless ones too: prodClean must see every install. A row
// before its installs row exists (a signup, or a create before reserve) has
// both hosts null, no HOSTS lookup and mode null. One host null and not the
// other fails the schema: the whole listing is the fixed 500.
export const INSTALLS_SQL =
  "SELECT install_id, app_host, content_host, state, test_hooks FROM install_status ORDER BY install_id";

/**
 * An installs row with no install_lifecycle row (created outside the
 * Provisioning API, after 0008's backfill) is missing from install_status,
 * so prodClean would never probe it. Any such row fails the whole listing.
 */
export const UNTRACKED_SQL =
  "SELECT 1 AS untracked FROM installs i WHERE NOT EXISTS (SELECT 1 FROM install_lifecycle l WHERE l.install_id = i.id) LIMIT 1";

export async function listInstalls(
  db: D1Like,
  kv: KvReadLike,
): Promise<Response> {
  const untracked = await db.prepare(UNTRACKED_SQL).all();
  if (untracked.results?.length) {
    console.error("inventory installs untracked");
    return internal();
  }
  const { results } = await db.prepare(INSTALLS_SQL).all();
  const rows = (results ?? []) as Row[];
  const hosts = rows.flatMap((r) => (r.app_host === null ? [] : [r.app_host]));
  const values = await getMany(kv, [...new Set(hosts)]);
  const installs = rows.map((r) => {
    const p =
      r.app_host === null ? null : parseHostsValue(values.get(r.app_host));
    return {
      id: r.install_id,
      appHost: r.app_host,
      contentHost: r.content_host,
      state: r.state,
      // Unknown (NULL) reads as hooks on: prodClean fails closed on it.
      testHooks: r.test_hooks !== 0,
      // The host serves this install only when HOSTS names this install.
      mode: p && p.installId === r.install_id ? p.mode : null,
    };
  });
  return json(InventoryInstallsSchema.parse({ installs }));
}
