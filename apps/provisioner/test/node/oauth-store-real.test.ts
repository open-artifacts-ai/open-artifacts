// #1008 PR1 against the real thing: apps/server's copy route (mountOAuthCopy)
// and its /healthz oauthStore (oauthStoreHealth), running on the install's
// own D1 from fake-cf (the server's migrations applied) and an in-memory
// KV. oauth-store.test.ts covers the failure paths with a contract fake;
// this one catches a reading of the route that both sides would share.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { NAMESPACES } from "@oa/provision";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeD1 } from "../../../../packages/provision/test/d1-node.js";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { runManage } from "../../src/manage.js";
import { runCreate } from "../../src/workflow.js";
import {
  ENV,
  event,
  seedCreate,
  seedJob,
  stepRunner,
  ulid,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

// The server's modules, loaded at run time: the provisioner's typecheck stays
// off the server's graph (its build-time defines, its Env), and its Hono is
// the server's own (the provisioner doesn't depend on hono).
const SERVER = new URL("../../../server/", import.meta.url);
const load = (rel: string) => import(new URL(`src/${rel}`, SERVER).href);
const hono = createRequire(new URL("package.json", SERVER)).resolve("hono");
type Handler = { fetch(r: Request, env: unknown): Promise<Response> };
type App = Handler & {
  onError(f: (e: unknown) => Response): void;
};
const { Hono } = (await import(pathToFileURL(hono).href)) as {
  Hono: new () => App;
};
const { toErrorResponse } = (await load("http/errors.ts")) as {
  toErrorResponse(e: unknown): Response;
};
const { mountOAuthCopy } = (await load("mcp/oauth-copy.ts")) as {
  mountOAuthCopy(app: App): void;
};
const {
  BACKFILLED_KEY,
  KV_WRITES_OFF_KEY,
  oauthStoreHealth,
  resetOAuthStoreMarkers,
} = (await load("mcp/oauth-store.ts")) as {
  BACKFILLED_KEY: string;
  KV_WRITES_OFF_KEY: string;
  oauthStoreHealth(env: unknown): Promise<unknown>;
  resetOAuthStoreMarkers(): void;
};

const KEY = "OAUTH_COPY_KEY";
let w: World;
beforeEach(async () => {
  w = await world();
  resetOAuthStoreMarkers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * A KV namespace: list pages by an opaque cursor it issued (any other is an
 * error, as KV's own), get as text.
 */
function memoryKv(n: number) {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++)
    m.set(`grant:${String(i).padStart(5, "0")}`, `{"v":${i}}`);
  const issued = new Map<string, number>();
  return {
    m,
    list: async (o: { limit?: number; cursor?: string }) => {
      const names = [...m.keys()].sort();
      const from = o.cursor ? issued.get(o.cursor) : 0;
      if (from === undefined) throw new Error("KV list: unknown cursor");
      const to = from + (o.limit ?? 1000);
      const done = to >= names.length;
      const cursor = done ? "" : `kv-${crypto.randomUUID()}`;
      if (!done) issued.set(cursor, to);
      return {
        keys: names.slice(from, to).map((name) => ({ name })),
        list_complete: done,
        cursor,
      };
    },
    get: async (k: string) => m.get(k) ?? null,
  };
}

/** The install, as the server would run it, behind DISPATCHER. */
async function realInstall(o: { keys: number; staleKey?: number }) {
  const s = seedCreate(w, {
    slug: `r${Math.random().toString(36).slice(2, 8)}`,
  });
  await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
  const id = s.installId;
  const script = `oa-s-${id}`;
  const fs = () => w.fake.script(NAMESPACES[ENV], script);
  const sqlite = (
    [...w.fake.d1.values()].find((d) => d.name === script) as {
      db: import("node:sqlite").DatabaseSync;
    }
  ).db;
  const DB = nodeD1(sqlite) as unknown as D1Database;
  const kv = memoryKv(o.keys);
  const calls: number[] = [];
  let probes = 0;
  const RL_ANON = {
    limit: async () => {
      calls.push(w.clock.t);
      const recent = calls.filter((t) => t > w.clock.t - 60_000).length;
      return { success: recent <= 30 };
    },
  };
  const bindingOf = (name: string) =>
    (
      fs()?.metadata.bindings.find((b: { name: string }) => b.name === name) as
        | { text?: string }
        | undefined
    )?.text;
  // One env object per script version, as one isolate's.
  const envs = new Map<string, Record<string, unknown>>();
  const envOf = () => {
    const mode = bindingOf("OAUTH_STORE") ?? "";
    const key = fs()?.secrets.get(KEY);
    const k = `${mode}|${key ?? ""}`;
    let e = envs.get(k);
    if (!e) {
      e = {
        DB,
        OAUTH_KV: kv,
        OAUTH_STORE: mode,
        OAUTH_COPY_KEY: key,
        RL_ANON,
        INSTALL_ID: id,
        APP_HOST: `${s.installId}.test`,
      };
      envs.set(k, e);
    }
    return e;
  };
  const app = new Hono();
  app.onError((e) => toErrorResponse(e));
  mountOAuthCopy(app);
  const real = w.env.DISPATCHER;
  w.env.DISPATCHER = {
    get: (name: string) => ({
      fetch: async (req: Request) => {
        if (name !== script) return real.get(name).fetch(req);
        const u = new URL(req.url);
        if (u.pathname === "/healthz") {
          const base = (await (await real.get(name).fetch(req)).json()) as {
            oauthStore?: unknown;
          };
          // The server's own field, from the server's own function.
          base.oauthStore = await oauthStoreHealth(envOf());
          return Response.json(base);
        }
        if (u.pathname !== "/__oa/oauth-store/copy")
          return real.get(name).fetch(req);
        const e = { ...envOf() };
        // A put not live yet: the isolate still holds the old key.
        if (probes++ < (o.staleKey ?? 0)) e.OAUTH_COPY_KEY = "s".repeat(40);
        return app.fetch(req, e);
      },
    }),
  } as unknown as DispatchNamespace;
  const settings = () =>
    Object.fromEntries(
      (
        sqlite.prepare("SELECT key, value FROM settings").all() as {
          key: string;
          value: string;
        }[]
      ).map((r) => [r.key, r.value]),
    );
  return {
    id,
    sqlite,
    kv,
    calls,
    settings,
    hasKey: () => fs()?.secrets.has(KEY),
  };
}

function grant(): string {
  const id = ulid();
  w.db
    .prepare(
      `INSERT INTO agent_tokens (id, kind, session_hash, admin_email, label, scopes, client_id, oauth_user, created_at, expires_at)
VALUES (?, 'oauth', 'sh', 'a@example.com', 'x', '["installs:write"]', 'client', 'adm_x', 1, 9)`,
    )
    .run(id);
  return id;
}
async function run(installId: string, args: Record<string, unknown>) {
  const id = seedJob(w, { kind: "update", installId, args, actor: "token" });
  w.db.prepare("UPDATE jobs SET token_id = ? WHERE id = ?").run(grant(), id);
  await runManage(w.ctx, event(id), stepRunner(w.clock).step).catch(() => {});
  return w.job(id) as Record<string, unknown>;
}
const set = (m: string) => ({ vars: { OAUTH_STORE: m } });

describe("the jobs against the server's copy route and /healthz", () => {
  it("kv, dual, copy, d1: every key in D1, the marker set, the key gone", async () => {
    const i = await realInstall({ keys: 1700 });
    expect((await run(i.id, set("dual"))).status).toBe("done");
    w.clock.t += 120_000;
    const refused = await run(i.id, set("d1"));
    expect(refused.error_code).toBe("copy_incomplete");
    const copy = await run(i.id, { oauthCopy: true });
    expect(copy.error_code ?? null).toBeNull();
    expect(copy.status).toBe("done");
    const rows = i.sqlite
      .prepare("SELECT count(*) AS n FROM oauth_kv")
      .get() as { n: number };
    expect(rows.n).toBe(1700);
    expect(JSON.parse(copy.args as string).counts).toEqual({
      kvKeys: 1700,
      copied: 1700,
      skippedExpiring: 0,
      d1Rows: 1700,
    });
    expect(i.settings()[BACKFILLED_KEY]).toBeDefined();
    expect(i.hasKey()).toBe(false);
    expect(i.calls.length).toBeGreaterThan(0);
    const d1 = await run(i.id, set("d1"));
    expect(d1.status).toBe("done");
    // Off d1 now: refused before any write.
    expect((await run(i.id, set("dual"))).error_code).toBe("leave_d1_refused");
  });

  it("a stale key with the markers refusing is the probe's 503: copy_markers", async () => {
    const i = await realInstall({ keys: 10, staleKey: 1 });
    expect((await run(i.id, set("dual"))).status).toBe("done");
    w.clock.t += 120_000;
    i.sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(KV_WRITES_OFF_KEY, "5");
    resetOAuthStoreMarkers();
    const copy = await run(i.id, { oauthCopy: true });
    expect(copy.error_code).toBe("copy_markers");
    expect(i.hasKey()).toBe(false);
  });

  it("markers refusing after the key verifies is copy_markers too", async () => {
    const i = await realInstall({ keys: 10 });
    expect((await run(i.id, set("dual"))).status).toBe("done");
    w.clock.t += 120_000;
    i.sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(KV_WRITES_OFF_KEY, "5");
    resetOAuthStoreMarkers();
    const copy = await run(i.id, { oauthCopy: true });
    expect(copy.error_code).toBe("copy_markers");
    expect(i.hasKey()).toBe(false);
  });

  it("a key that isn't live yet is polled until the route takes it", async () => {
    const i = await realInstall({ keys: 10, staleKey: 2 });
    expect((await run(i.id, set("dual"))).status).toBe("done");
    w.clock.t += 120_000;
    expect((await run(i.id, { oauthCopy: true })).status).toBe("done");
  });
});
