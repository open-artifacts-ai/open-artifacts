import { env } from "cloudflare:workers";
import {
  type AuditEvent,
  newId,
  R,
  TEST_AUDIT_LIMIT,
  TEST_HOOKS,
  TestAuditResultSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { uniq } from "./auth-helpers.js";
import { api, login } from "./helpers.js";

// POST /__test/audit: reads back test_hook.* audit rows only (P5 "a hook call
// is audited" on staging). Same gates as every hook.
const KEY = "k".repeat(32);
const TD = "p5.test";
const passRl = {
  limit: async () => ({ success: true }),
} as unknown as RateLimit;
const ON = {
  TEST_HOOKS: "1",
  TEST_HOOK_KEY: KEY,
  TEST_DOMAIN: TD,
  RL_ANON: passRl,
};
const on = (over: Partial<Env> = {}) => ({ ...env, ...ON, ...over }) as Env;

async function call(
  e: Env,
  path: string,
  body: unknown,
  o: { key?: string; host?: string } = {},
) {
  return worker.fetch(
    new Request(`http://${o.host ?? "app.localhost"}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.201",
        ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      },
      body: JSON.stringify(body),
    }) as never,
    e,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}
const read = (since: number, e = on(), key = KEY) =>
  call(e, TEST_HOOKS.audit, { since }, { key });

/** The standard 404, byte for byte (hooks off). */
async function same404(r: Response) {
  const ref = await call(env, TEST_HOOKS.session, {});
  expect(r.status).toBe(404);
  expect(await r.text()).toBe(await ref.text());
}

const insert = (
  at: number,
  kind: string,
  action: string,
  targetType = "test_hook",
) =>
  env.DB.prepare(
    "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail) values (?, ?, ?, null, ?, ?, ?, ?)",
  ).bind(newId(), at, kind, action, targetType, `t-${at}`, '{"k":"v"}');

describe("POST /__test/audit", () => {
  // Far future, so rows other tests write never fall in range.
  let base: number;
  beforeAll(async () => {
    base = Date.now() + 50_000_000_000;
    await env.DB.batch([
      insert(base + 1, "test_hook", "test_hook.session"),
      insert(base + 2, "user", "space.create", "space"),
      insert(base + 3, "system", "directory.sync", "directory"),
      insert(base + 4, "sync", "test_hook.session"), // wrong actor kind
      insert(base + 5, "test_hook", "testXhook.session"), // LIKE-wildcard lookalike
      insert(base + 6, "test_hook", "auth.signin"), // wrong action
      insert(base + 7, "test_hook", "test_hook.otp_latest"),
      insert(base - 1, "test_hook", "test_hook.session"), // before since
    ]);
  });

  it("returns only test_hook.* events since `since`, newest first", async () => {
    const r = await read(base);
    expect(r.status).toBe(200);
    const { events } = TestAuditResultSchema.parse(await r.json());
    expect(events).toEqual([
      {
        action: "test_hook.otp_latest",
        at: base + 7,
        actorId: null,
        targetId: `t-${base + 7}`,
        detail: { k: "v" },
      },
      {
        action: "test_hook.session",
        at: base + 1,
        actorId: null,
        targetId: `t-${base + 1}`,
        detail: { k: "v" },
      },
    ]);
  });

  it("a hook call shows up, and this call is itself audited", async () => {
    const since = Date.now();
    await call(
      on(),
      TEST_HOOKS.session,
      {
        email: uniq("aud", TD),
        role: "member",
      },
      { key: KEY },
    );
    const first = TestAuditResultSchema.parse(await (await read(since)).json());
    const mine = first.events.filter((e) => e.at < base - 1);
    expect(mine.map((e) => e.action)).toContain("test_hook.session");
    expect(mine.map((e) => e.action)).not.toContain("test_hook.audit");
    const second = TestAuditResultSchema.parse(
      await (await read(since)).json(),
    );
    const row = second.events.find((e) => e.action === "test_hook.audit");
    expect(row).toMatchObject({
      targetId: "audit",
      detail: { hook: "audit", outcome: "ok", ip: "198.51.100.201" },
    });
  });

  it("caps at TEST_AUDIT_LIMIT", async () => {
    const far = base + 1_000_000;
    await env.DB.prepare(
      `with recursive n(x) as (select 1 union all select x + 1 from n where x < ?1)
       insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail)
       select 'TstAud' || x, ?2 + x, 'test_hook', null, 'test_hook.session', 'test_hook', 'session', '{}' from n`,
    )
      .bind(TEST_AUDIT_LIMIT + 5, far)
      .run();
    const { events } = TestAuditResultSchema.parse(
      await (await read(far)).json(),
    );
    expect(events).toHaveLength(TEST_AUDIT_LIMIT);
    expect(events[0]?.at).toBe(far + TEST_AUDIT_LIMIT + 5);
  });

  it("bad input is the 404 with bad_input (after the key)", async () => {
    const ref = await call(env, TEST_HOOKS.session, {});
    const { error } = (await ref.json()) as { error: object };
    for (const body of [
      {},
      { since: "1" },
      { since: -1 },
      { since: 1, x: 1 },
    ]) {
      const r = await call(on(), TEST_HOOKS.audit, body, { key: KEY });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({
        error: { ...error, details: { reason: "bad_input" } },
      });
    }
  });

  it("every gate is the identical 404", async () => {
    await same404(await read(base, on(), "x".repeat(32)));
    await same404(await read(base, on(), ""));
    await same404(await read(base, on({ TEST_HOOKS: "0" })));
    await same404(await read(base, on({ TEST_DOMAIN: "" })));
    await same404(await read(base, on({ TEST_DOMAIN: undefined })));
    await same404(
      await read(base, on({ TEST_HOOK_KEY: "k".repeat(31) }), "k".repeat(31)),
    );
    await same404(await read(base, on({ RL_ANON: undefined })));
    const limited = {
      limit: async () => ({ success: false }),
    } as unknown as RateLimit;
    await same404(await read(base, on({ RL_ANON: limited })));
    const r = await call(
      on(),
      TEST_HOOKS.audit,
      { since: base },
      { key: KEY, host: env.CONTENT_HOST },
    );
    expect(r.status).toBe(404);
  });
});

describe("GET R.audit stays unchanged", () => {
  it("never lists test_hook rows", async () => {
    const owner = await login(uniq("audowner"), "owner");
    const at = Date.now() + 60_000_000_000;
    await env.DB.batch([
      insert(at, "test_hook", "test_hook.session"),
      insert(at - 1, "user", "space.create", "space"),
    ]);
    const r = await api(createApp(), `${R.audit}?limit=1`, owner.cookie);
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: AuditEvent[] };
    expect(items.map((e) => e.action)).toEqual(["space.create"]);
    expect(items[0]?.target.id).toBe(`t-${at - 1}`);
  });
});
