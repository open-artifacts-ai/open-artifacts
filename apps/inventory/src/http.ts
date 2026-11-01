/** The read half of D1, plus the one write POST /prodclean makes. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
      run(): Promise<unknown>;
    };
    all(): Promise<{ results?: unknown[] }>;
  };
}

/** The read half of a KV namespace: this Worker never writes HOSTS. */
export interface KvReadLike {
  list(opts?: { cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<string | null>;
  get(keys: string[]): Promise<Map<string, string | null>>;
}

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

/** Fixed bodies: nothing from the request or a verifier ever reaches them. */
export const unauthorized = () => json({ error: "unauthorized" }, 401);
export const unavailable = () => json({ error: "unavailable" }, 503);
export const forbidden = () => json({ error: "forbidden" }, 403);
export const badRequest = () => json({ error: "bad_request" }, 400);
export const internal = () => json({ error: "internal" }, 500);
export const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
export const methodNotAllowed = (allow: string) =>
  new Response(null, {
    status: 405,
    headers: { allow, "cache-control": "no-store" },
  });
