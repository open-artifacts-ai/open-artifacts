// B17 CPU-budget suite, deterministic half (runs in `pnpm test`): the work
// each hot path does — bytes parsed/scanned and binding calls (subrequests) —
// is bounded. Timings are opt-in (`pnpm --filter @oa/server bench`, Node
// proxy; see scripts/bench.ts). DO-side bounds (≤ 200 sockets, 16 KB inline
// broadcast, 2 MiB query cap) are asserted in runtime.adv.test.ts.
import { env } from "cloudflare:workers";
import { AUDIT_RETENTION_MS, LIMITS } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import { injectRuntime } from "../../src/content/inject.js";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";
import { purgeDeleted } from "../../src/services/artifacts.js";
import {
  AUDIT_SWEEP_BATCH,
  AUDIT_SWEEP_STATEMENTS,
  sweepAuditEvents,
} from "../../src/services/audit.js";
import { fetchAndWait, login } from "../helpers.js";

/** Binding calls by kind, i.e. the subrequests a request makes. */
type Counts = { d1: number; r2: number; r2Put: number; do: number };

/** env whose DB/FILES/ARTIFACT_RUNTIME count every call. */
function counted(): { env: Env; n: Counts } {
  const n: Counts = { d1: 0, r2: 0, r2Put: 0, do: 0 };
  const base = env as Env;
  const stmt = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (typeof v !== "function") return v;
        if (k === "bind") return (...a: unknown[]) => stmt(v.apply(t, a));
        if (k === "first" || k === "all" || k === "run" || k === "raw")
          return (...a: unknown[]) => {
            n.d1++;
            return v.apply(t, a);
          };
        return v.bind(t);
      },
    });
  const DB = new Proxy(base.DB, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      if (k === "prepare") return (q: string) => stmt(v.call(t, q));
      if (k === "batch" || k === "exec")
        return (...a: unknown[]) => {
          n.d1++;
          return v.apply(t, a);
        };
      return v.bind(t);
    },
  });
  const FILES = new Proxy(base.FILES, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        n.r2++;
        if (k === "put") n.r2Put++;
        return v.apply(t, a);
      };
    },
  });
  const ns = base.ARTIFACT_RUNTIME;
  const ARTIFACT_RUNTIME = {
    idFromName: (s: string) => ns.idFromName(s),
    get: (id: DurableObjectId) => {
      const s = ns.get(id);
      return new Proxy(s, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function") return v;
          // RPC stub members are proxies: call through the stub, not .apply.
          return (...a: unknown[]) => {
            n.do++;
            return (
              t as unknown as Record<PropertyKey, (...x: unknown[]) => unknown>
            )[k](...a);
          };
        },
      });
    },
  };
  return {
    env: { ...base, DB, FILES, ARTIFACT_RUNTIME } as unknown as Env,
    n,
  };
}

const APP = "https://app.localhost";
let token = "";
const call = (e: Env, path: string, init: RequestInit = {}) =>
  fetchAndWait(
    worker as never,
    new Request(`${APP}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    }),
    e,
  );
const publish = async (e: Env, body: unknown) => {
  const r = await call(e, "/api/v1/artifacts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; version: number };
};

beforeAll(async () => {
  const u = await login("cpu-budget@example.com", "owner");
  token = (await createPat(env as Env, u.userId, "cpu")).token;
  for (let i = 0; i < 30; i++)
    await publish(env as Env, {
      title: `cpu budget ${i}`,
      format: "markdown",
      content: `budget note ${i}`,
    });
});

describe("publish", () => {
  it("inline base64 at the limit: one R2 put per file, bounded D1 calls, one DO enqueue, no R2 read", async () => {
    const bytes = new Uint8Array(LIMITS.inlineBytes - 1024).fill(7);
    const { env: e, n } = counted();
    await publish(e, {
      title: "inline",
      files: {
        "index.html": "<img src=a.bin>",
        "a.bin": { base64: btoa(String.fromCharCode(...bytes.subarray(0, 3))) },
      },
    });
    const small = { ...n };
    Object.assign(n, { d1: 0, r2: 0, r2Put: 0, do: 0 });
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await publish(e, {
      title: "inline",
      files: {
        "index.html": "<img src=a.bin>",
        "a.bin": { base64: btoa(bin) },
      },
    });
    expect(n.r2Put).toBe(2);
    // C3: indexing is one scheduleIndex RPC; extraction runs in the DO alarm.
    expect(n.do).toBe(1);
    expect(n.r2).toBe(n.r2Put);
    // Size never changes the call count; ~10 D1 calls incl. auth.
    expect(n).toEqual(small);
    expect(n.d1 + n.r2).toBeLessThanOrEqual(16);
  });

  it(`inline over LIMITS.inlineBytes (${LIMITS.inlineBytes}) is refused before any write`, async () => {
    const { env: e, n } = counted();
    const r = await call(e, "/api/v1/artifacts", {
      method: "POST",
      body: JSON.stringify({
        title: "big",
        format: "markdown",
        content: "x".repeat(LIMITS.inlineBytes + 1),
      }),
    });
    expect(r.status).toBe(413);
    expect(n.r2Put).toBe(0);
  });
});

describe("content __view injection", () => {
  it("scans at most the 64 KiB prefix of a 500 KB entry before streaming", async () => {
    const chunk = 16 * 1024;
    const total = 500 * 1024; // pulled in whole chunks: 512 KiB
    let pulled = 0;
    const head = new TextEncoder().encode(
      "<!doctype html><html><head><title>t</title></head><body>",
    );
    const src = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= total) return c.close();
        const b = new Uint8Array(chunk).fill(0x61);
        if (pulled === 0) b.set(head);
        pulled += chunk;
        c.enqueue(b);
      },
    });
    const out = injectRuntime(
      new Response(src, { headers: { "content-type": "text/html" } }),
      '<script src="/_oa/rt.js"></script>',
    );
    const reader = (out.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value).includes("/_oa/rt.js")).toBe(
      true,
    );
    // The insertion point was found in the first chunk (plus the stream's
    // read-ahead): nothing past the 64 KiB prefix went through JS.
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + chunk);
    let rest = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest += r.value.byteLength;
    }
    expect((first.value?.byteLength ?? 0) + rest).toBe(
      pulled + '<script src="/_oa/rt.js"></script>'.length,
    );
  });
});

describe("reads", () => {
  it("list 25: 25 items, constant D1 calls, no R2/DO", async () => {
    const { env: e, n } = counted();
    const r = await call(e, "/api/v1/artifacts?limit=25");
    expect(r.status).toBe(200);
    const page = (await r.json()) as { items: unknown[]; nextCursor: string };
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).toBeTruthy();
    expect(n.r2 + n.do).toBe(0);
    expect(n.d1).toBeLessThanOrEqual(3);
  });

  it("search: constant D1 calls, no R2/DO", async () => {
    const { env: e, n } = counted();
    const r = await call(e, "/api/v1/search?q=budget");
    expect(r.status).toBe(200);
    expect(n.r2 + n.do).toBe(0);
    expect(n.d1).toBeLessThanOrEqual(3);
  });
});

describe("runtime + MCP", () => {
  it("db.set: exactly one DO call; the Worker never parses the doc", async () => {
    const { id } = await publish(env as Env, {
      title: "db",
      format: "html",
      content: "<p>x</p>",
      capabilities: { db: true },
    });
    const { env: e, n } = counted();
    const r = await call(e, `/api/v1/artifacts/${id}/data/todos/a`, {
      method: "PUT",
      body: JSON.stringify({ text: "x".repeat(1000) }),
    });
    expect(r.status).toBe(200);
    expect(n.do).toBe(1);
    expect(n.r2).toBe(0);
    expect(n.d1).toBeLessThanOrEqual(3);
  });

  it("MCP tools/list: PAT + user lookups only", async () => {
    const { env: e, n } = counted();
    const r = await call(e, "/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("publish_artifact");
    expect(n.r2 + n.do).toBe(0);
    expect(n.d1).toBeLessThanOrEqual(3);
  });
});

describe("cron purge", () => {
  it("one run over a full window stays far under 1000 subrequests", async () => {
    const u = await login("cpu-purge@example.com");
    const old = Date.now() - (LIMITS.softDeleteDays + 1) * 86400_000;
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = (
        await env.DB.prepare(
          `insert into artifacts (id, owner_id, space_id, title, format, visibility, current_version,
             capabilities, allow_anonymous_writes, created_at, updated_at, deleted_at)
           values (lower(hex(randomblob(8))), ?, ?, 't', 'markdown', 'private', 0, '{}', 0, ?, ?, ?)
           returning id`,
        )
          .bind(u.userId, u.userId, old, old, old)
          .first<{ id: string }>()
      )?.id as string;
      ids.push(id);
      for (let f = 0; f < 3; f++)
        await env.FILES.put(`files/${id}/f${f}`, new Uint8Array([f]));
    }
    const { env: e, n } = counted();
    expect(await purgeDeleted(e, Date.now())).toBe(50); // PURGE_BATCH
    // Per artifact: list + delete + DO destroy + one D1 batch.
    expect(n.r2).toBe(100);
    expect(n.do).toBe(50);
    expect(n.d1).toBe(51);
    expect(n.d1 + n.r2 + n.do).toBeLessThan(1000);
  }, 30_000);

  it("the audit retention sweep over a backlog is AUDIT_SWEEP_STATEMENTS D1 calls", async () => {
    const now = Date.now();
    const cap = AUDIT_SWEEP_STATEMENTS * AUDIT_SWEEP_BATCH;
    await env.DB.prepare(
      `with recursive s(i) as (select 0 union all select i + 1 from s where i + 1 < ?)
       insert into audit_events (id, at, actor_kind, action, target_type)
       select lower(hex(randomblob(10))), ? + i, 'system', 'test.cpu', 'artifact' from s`,
    )
      .bind(cap + 10, now - AUDIT_RETENTION_MS - 86400_000 - cap - 10)
      .run();
    const { env: e, n } = counted();
    expect(await sweepAuditEvents(e, now)).toBe(cap);
    expect(n.d1).toBe(AUDIT_SWEEP_STATEMENTS);
    expect(n.r2 + n.do).toBe(0);
    expect(await sweepAuditEvents(env, now)).toBe(10);
  }, 30_000);
});
