import { parseHostsValue } from "@oa/provision/names";
import {
  InventoryHostSchema,
  InventoryHostsSchema,
} from "@oa/shared/provisioning";
import type { z } from "zod";
import { json, type KvReadLike } from "./http.ts";

// GET /hosts and GET /hosts?host= (design v7 5.5, 6.3). Every HOSTS value goes
// through parseHostsValue, the one parser dispatch uses: an unparseable value,
// a platform principal or a miss is installId and mode null.

const MAX_HOSTS = 10_000;
const LIST_PAGE = 1000;
export const GET_BULK = 100;
/** KV's key limit; a longer host can't be a key. */
const MAX_KEY = 512;

type Host = z.infer<typeof InventoryHostSchema>;

export function hostEntry(host: string, value: unknown): Host {
  const p = parseHostsValue(value);
  return { host, installId: p?.installId ?? null, mode: p?.mode ?? null };
}

/** HOSTS values for `keys`, in bulk gets of at most GET_BULK. */
export async function getMany(
  kv: KvReadLike,
  keys: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i += GET_BULK) {
    const chunk = keys.slice(i, i + GET_BULK);
    const values = await kv.get(chunk);
    for (const k of chunk) out.set(k, values.get(k) ?? null);
  }
  return out;
}

export async function listHosts(kv: KvReadLike): Promise<Response> {
  const names: string[] = [];
  let complete = true;
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({
      cursor,
      limit: Math.min(LIST_PAGE, MAX_HOSTS - names.length + 1),
    });
    for (const k of page.keys) names.push(k.name);
    if (page.list_complete) break;
    if (names.length > MAX_HOSTS) {
      complete = false;
      break;
    }
    cursor = page.cursor;
  }
  names.sort();
  if (names.length > MAX_HOSTS) {
    complete = false;
    names.length = MAX_HOSTS;
  }
  const values = await getMany(kv, names);
  const hosts = names.map((h) => hostEntry(h, values.get(h)));
  return json(InventoryHostsSchema.parse({ hosts, complete }));
}

export async function oneHost(kv: KvReadLike, host: string): Promise<Response> {
  const value =
    host === "" || new TextEncoder().encode(host).length > MAX_KEY
      ? null
      : await kv.get(host);
  return json(InventoryHostSchema.parse(hostEntry(host, value)));
}
