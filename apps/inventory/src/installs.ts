import { parseHostsValue } from "@oa/provision/names";
import { InventoryInstallsSchema } from "@oa/shared/provisioning";
import { getMany } from "./hosts.ts";
import { type D1Like, json, type KvReadLike } from "./http.ts";

// GET /installs: every install with a routed host, its API state from the
// install_status view (0008) and its live HOSTS mode.

interface Row {
  install_id: string;
  app_host: string;
  content_host: string;
  state: string;
  test_hooks: number | null;
}

// TODO(contract): InventoryInstallSchema's appHost and contentHost are
// non-null, but install_status has null hosts before the installs row
// exists (a signup, or a create before reserve); those rows are left out.
export const INSTALLS_SQL =
  "SELECT install_id, app_host, content_host, state, test_hooks FROM install_status WHERE app_host IS NOT NULL AND content_host IS NOT NULL ORDER BY install_id";

export async function listInstalls(
  db: D1Like,
  kv: KvReadLike,
): Promise<Response> {
  const { results } = await db.prepare(INSTALLS_SQL).all();
  const rows = (results ?? []) as Row[];
  const values = await getMany(kv, [...new Set(rows.map((r) => r.app_host))]);
  const installs = rows.map((r) => {
    const p = parseHostsValue(values.get(r.app_host));
    return {
      id: r.install_id,
      appHost: r.app_host,
      contentHost: r.content_host,
      state: r.state,
      testHooks: Boolean(r.test_hooks),
      // The host serves this install only when HOSTS names this install.
      mode: p && p.installId === r.install_id ? p.mode : null,
    };
  });
  return json(InventoryInstallsSchema.parse({ installs }));
}
