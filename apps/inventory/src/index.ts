interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
    };
    all(): Promise<{ results?: unknown[] }>;
  };
}

/** The read half of a KV namespace: this Worker never writes HOSTS. */
interface KvReadLike {
  list(opts?: { cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<string | null>;
  get(keys: string[]): Promise<Map<string, string | null>>;
}

export interface Env {
  PLATFORM_DB: D1Like;
  /** host -> install id (oa-<p>-hosts), the namespace dispatch reads. */
  HOSTS: KvReadLike;
  /** Secret. Not listed in wrangler.jsonc. */
  INVENTORY_KEY?: string;
}

interface Row {
  id: string;
  app_host: string;
  content_host: string;
  state: string;
  test_hooks: number;
}

const SQL =
  "SELECT id, app_host, content_host, state, test_hooks FROM installs ORDER BY id";

/** A HOSTS value is the bare install id (same shape as @oa/provision's isInstallId). */
const INSTALL_ID = /^i[a-z0-9]{11}$/;
const MAX_HOSTS = 10_000;
const LIST_PAGE = 1000;
const GET_BULK = 100;

const installIdOf = (v: string | null | undefined): string | null =>
  typeof v === "string" && INSTALL_ID.test(v) ? v : null;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

async function listHosts(kv: KvReadLike): Promise<Response> {
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
  const hosts: { host: string; installId: string | null }[] = [];
  for (let i = 0; i < names.length; i += GET_BULK) {
    const chunk = names.slice(i, i + GET_BULK);
    const values = await kv.get(chunk);
    for (const host of chunk)
      hosts.push({ host, installId: installIdOf(values.get(host)) });
  }
  return json({ hosts, complete });
}

const notFound = () => new Response("Not found", { status: 404 });

async function sha256(s: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(d);
}

async function keyMatches(
  presented: string,
  expected: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.INVENTORY_KEY;
    if (typeof key !== "string" || key.length < 32) return notFound();
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      (url.pathname !== "/installs" && url.pathname !== "/hosts")
    )
      return notFound();
    const m = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
    if (!m || !(await keyMatches(m[1], key))) return notFound();

    if (url.pathname === "/hosts") {
      const host = url.searchParams.get("host");
      if (host === null) return listHosts(env.HOSTS);
      return json({ host, installId: installIdOf(await env.HOSTS.get(host)) });
    }

    const { results } = await env.PLATFORM_DB.prepare(SQL).all();
    const installs = ((results ?? []) as Row[]).map((r) => ({
      id: r.id,
      appHost: r.app_host,
      contentHost: r.content_host,
      state: r.state,
      testHooks: Boolean(r.test_hooks),
    }));
    return json({ installs });
  },
};
