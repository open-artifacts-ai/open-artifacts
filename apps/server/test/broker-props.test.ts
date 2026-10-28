// Brokers through the platform's dispatch/scheduler props (BrokerGate):
// transport precedence, the hosted fail-closed path, the props path for the
// auth redeem and each directory route, and directory sync driven by the
// scheduler's oa:directory-sync tick (the alarm never calls a broker; the
// token lives in memory only).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { R, type SyncStatus } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrokerGateRefusedError,
  BrokerGateStaleError,
  BrokerUnavailableError,
  brokerFetch,
  brokerTransportKind,
  withBrokerProps,
  withoutBrokerProps,
} from "../src/auth/broker-transport.js";
import {
  DIRECTORY_DISCONNECT_CRON,
  DIRECTORY_SYNC_CRON,
  scheduled,
} from "../src/cron.js";
import { directoryClient } from "../src/directory/client.js";
import { STALE_MS } from "../src/directory/health.js";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffMs,
  FAST_MS,
  NO_FEED_MS,
  RECONCILE_MS,
  RETRY_HOURLY_MS,
  SyncEngine,
  TOKEN_TTL_MS,
  TokenBox,
} from "../src/directory/sync.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import type { Env } from "../src/env.js";
import { feedSync, SYNC_DO_NAME } from "../src/services/directory.js";
import { mailer, uniq } from "./auth-helpers.js";
import {
  BROKER,
  brokerGate,
  connect,
  directEnv,
  type GateCall,
  gateCalls,
  hostedEnv,
  hostedProps,
  post,
  registerInstall,
  resetDirectory,
} from "./directory-helpers.js";
import {
  type FakeDirectory,
  fakeDirectory,
} from "./fixtures/fake-directory.js";
import { login } from "./helpers.js";

const MIN = 60_000;
const req = (path: string) =>
  new Request(`https://broker.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
const fetcher = (name: string, calls: string[]) =>
  ({
    fetch: async (r: Request) => {
      calls.push(`${name} ${new URL(r.url).pathname}`);
      return new Response("ok");
    },
  }) as unknown as Fetcher;
const ctxOf = (props?: Record<string, unknown>) =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    ...(props ? { props } : {}),
  }) as unknown as ExecutionContext;

afterEach(() => vi.restoreAllMocks());

describe("transport precedence", () => {
  for (const [which, bindingKey, propKey, urlKey] of [
    ["auth", "BROKER", "AUTH_BROKER", "AUTH_BROKER_URL"],
    [
      "directory",
      "DIRECTORY_BROKER",
      "DIRECTORY_BROKER",
      "DIRECTORY_BROKER_URL",
    ],
  ] as const) {
    it(`${which}: binding, then props, then HTTPS (self-host only)`, async () => {
      const calls: string[] = [];
      const net = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (r) => {
          calls.push(`https ${new URL((r as Request).url).pathname}`);
          return new Response("ok");
        });
      const props = { [propKey]: fetcher("props", calls) };
      const bound = {
        [urlKey]: "https://broker.example",
        [bindingKey]: fetcher("binding", calls),
      } as unknown as Env;
      const plain = { [urlKey]: "https://broker.example" } as unknown as Env;
      // binding beats props
      await withBrokerProps({ props }, async () => {
        expect(brokerTransportKind(bound, which)).toBe("binding");
        await brokerFetch(bound, which, req("/a"));
        expect(brokerTransportKind(plain, which)).toBe("props");
        await brokerFetch(plain, which, req("/b"));
      });
      // no props: HTTPS (self-host)
      expect(brokerTransportKind(plain, which)).toBe("https");
      await brokerFetch(plain, which, req("/c"));
      // the other broker's capability never stands in
      const other = which === "auth" ? "DIRECTORY_BROKER" : "AUTH_BROKER";
      await withBrokerProps(
        { props: { [other]: fetcher("other", calls) } },
        async () => {
          expect(brokerTransportKind(plain, which)).toBe("https");
          await brokerFetch(plain, which, req("/d"));
        },
      );
      expect(calls).toEqual(["binding /a", "props /b", "https /c", "https /d"]);
      expect(net).toHaveBeenCalledTimes(2);
    });

    it(`${which}: HOSTED=1 without a binding or props fails closed, no HTTPS`, async () => {
      const net = vi.spyOn(globalThis, "fetch");
      const hosted = {
        HOSTED: "1",
        [urlKey]: "https://broker.example",
      } as unknown as Env;
      expect(brokerTransportKind(hosted, which)).toBeNull();
      await expect(
        brokerFetch(hosted, which, req("/x")),
      ).rejects.toBeInstanceOf(BrokerUnavailableError);
      // props hidden (a DO alarm): still closed
      const calls: string[] = [];
      await withBrokerProps(
        { props: { [propKey]: fetcher("props", calls) } },
        () =>
          withoutBrokerProps(async () => {
            expect(brokerTransportKind(hosted, which)).toBeNull();
            await expect(
              brokerFetch(hosted, which, req("/y")),
            ).rejects.toBeInstanceOf(BrokerUnavailableError);
          }),
      );
      // a malformed capability is no capability
      await withBrokerProps({ props: { [propKey]: { fetch: 1 } } }, () =>
        expect(brokerTransportKind(hosted, which)).toBeNull(),
      );
      expect(calls).toEqual([]);
      expect(net).not.toHaveBeenCalled();
    });
  }

  it("a gate refusal (x-oa-gate: 1) is BrokerGateRefusedError; every broker answer passes through", async () => {
    const hosted = { HOSTED: "1" } as unknown as Env;
    const answer = (status: number, error: string, gate: boolean) => ({
      DIRECTORY_BROKER: {
        fetch: async () =>
          Response.json(
            { error },
            { status, headers: gate ? { "x-oa-gate": "1" } : {} },
          ),
      },
    });
    for (const [s, e, code] of [
      [403, "install_mismatch", "install_mismatch"],
      [404, "not_found", "not_found"],
      [415, "json_only", "json_only"],
      [413, "too_large", "too_large"],
      [400, "bad_json", "bad_json"],
      [400, "bad_body", "bad_body"],
      [500, "gate_misconfigured", "gate_misconfigured"],
      // a future gate code: still the gate's (the header decides)
      [400, "something_new", "gate"],
    ] as const)
      await withBrokerProps({ props: answer(s, e, true) }, async () => {
        await expect(
          brokerFetch(hosted, "directory", req("/p")),
        ).rejects.toMatchObject({ status: s, error: code });
        await expect(
          brokerFetch(hosted, "directory", req("/p")),
        ).rejects.toBeInstanceOf(BrokerGateRefusedError);
      });
    // No header: the broker's own answer, whatever its code (its 404
    // not_found and a gate-looking code included).
    for (const [s, e] of [
      [401, "unauthorized"],
      [404, "not_found"],
      [400, "bad_json"],
      [500, "server_error"],
      [400, "invalid_grant"],
      [429, "rate_limited"],
    ] as const)
      await withBrokerProps({ props: answer(s, e, false) }, async () => {
        const r = await brokerFetch(hosted, "directory", req("/p"));
        expect(r.status).toBe(s);
      });
  });

  it("a capability used past its invocation is BrokerGateStaleError; other throws pass through", async () => {
    const hosted = { HOSTED: "1" } as unknown as Env;
    const throwing = (message: string) => ({
      DIRECTORY_BROKER: {
        fetch: async () => {
          throw new Error(message);
        },
      },
    });
    for (const m of [
      "Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and others) created in the context of one request handler cannot be accessed from a different request's handler.",
      "Attempted to use RPC stub after it has been disposed.",
      "Network connection lost.",
    ])
      await withBrokerProps({ props: throwing(m) }, () =>
        expect(
          brokerFetch(hosted, "directory", req("/p")),
        ).rejects.toBeInstanceOf(BrokerGateStaleError),
      );
    await withBrokerProps({ props: throwing("boom") }, async () => {
      const p = brokerFetch(hosted, "directory", req("/p"));
      await expect(p).rejects.toThrow("boom");
      await expect(p).rejects.not.toBeInstanceOf(BrokerGateStaleError);
    });
  });
});

// ------------------------------------------------------------ directory

let g: FakeDirectory;
let owner: { cookie: string; userId: string; email: string };
let adminSub: string;

const realStub = () => {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) throw new Error("DIRECTORY_SYNC unbound");
  return ns.get(
    ns.idFromName(SYNC_DO_NAME),
  ) as unknown as DurableObjectStub<DirectorySync>;
};
const inDo = <T>(f: (s: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(realStub(), (_i, s) => f(s));

/**
 * The hosted harness: DirectorySync's engine on the real DO storage with this
 * test's env, clock and one in-memory TokenBox (as the DO class holds one).
 * The install's DIRECTORY_SYNC is a namespace whose stub runs those engine
 * methods, so feedSync and the routes reach it as they would the DO.
 */
let clock = 0;
let box: TokenBox;
let e: Env;
const engine = (s: DurableObjectState) =>
  new SyncEngine(e, s.storage, undefined, box);
/** DirectorySync RPCs made through fakeNs, by name. */
const rpcs: string[] = [];
const fakeNs = {
  idFromName: () => ({}),
  get: () => ({
    kick: (r: never) => inDo((s) => engine(s).kick(r, clock)),
    wantsToken: () => {
      rpcs.push("wantsToken");
      return inDo((s) => engine(s).wantsToken(clock));
    },
    handToken: (k: string, h: never) => {
      rpcs.push("handToken");
      return inDo((s) => engine(s).handToken(k, h, clock));
    },
    reset: () => inDo((s) => engine(s).reset(clock)),
    confirmHeld: (id: string, by: never) =>
      inDo((s) => engine(s).confirmHeld(id, by, clock)),
    status: () => inDo((s) => engine(s).status()),
  }),
} as unknown as Env["DIRECTORY_SYNC"];

/** Broker requests made over the network (the fake's fetch spy). */
const httpsBrokerCalls = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.map((c) => new Request(c[0] as RequestInfo, c[1]).url)
    .filter((u) => u.startsWith(BROKER)).length;

/** One scheduler tick: oa:directory-sync with the scheduler's props. */
const cronTick = async (now: number, calls: GateCall[] = gateCalls) => {
  clock = now;
  await scheduled(
    { cron: DIRECTORY_SYNC_CRON },
    e,
    ctxOf({ DIRECTORY_BROKER: brokerGate(calls) }),
  );
};

/** Alarms at `now` until nothing is due, or a token is needed and none is in hand. */
async function alarms(now: number): Promise<"done" | "starved"> {
  return inDo(async (s) => {
    for (let i = 0; i < 80; i++) {
      await engine(s).alarm(now);
      if (!engine(s).due(now)) return "done";
      if (!box.tok && !box.fault) return "starved";
    }
    throw new Error("run never finished");
  });
}
/** A scheduler tick then the DO's alarms: one 2-min period, hosted. */
async function period(now: number) {
  await cronTick(now);
  return alarms(now);
}
const status = (): Promise<SyncStatus> => inDo((s) => engine(s).status());
const kv = async <T>(k: string): Promise<T | null> => {
  const v = await inDo(
    (s) =>
      s.storage.sql.exec("select v from kv where k = ?", k).toArray()[0]?.v,
  );
  return v === undefined ? null : (JSON.parse(String(v)) as T);
};
const membersOf = async (groupId: string) =>
  (
    await env.DB.prepare(
      "select user_id from directory_members where group_id = ? order by user_id",
    )
      .bind(groupId)
      .all<{ user_id: string }>()
  ).results.map((r) => r.user_id);
function dirUsers(n: number, tag: string) {
  return Array.from({ length: n }, (_, i) =>
    g.addUser({
      id: `g-${tag}-${i}-${crypto.randomUUID()}`,
      primaryEmail: uniq(`${tag}${i}`),
    }),
  );
}
async function mappedGroup(id: string, members: string[]) {
  const email = `${id}@a.com`;
  g.addGroup({ id, email, members });
  await env.DB.batch([
    env.DB.prepare(
      "insert or ignore into directory_groups (group_id, email) values (?, ?)",
    ).bind(id, email),
    env.DB.prepare(
      "insert or replace into org_group_mappings (group_id, group_email, role) values (?, ?, 'viewer')",
    ).bind(id, email),
  ]);
}

/** Every value in the DO's storage (SQLite tables and KV), as one string. */
const doStorageDump = () =>
  inDo(async (s) => {
    const parts: string[] = [];
    const tables = s.storage.sql
      .exec(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'",
      )
      .toArray()
      .map((r) => String(r.name));
    for (const t of tables)
      for (const row of s.storage.sql.exec(`select * from "${t}"`).toArray())
        parts.push(JSON.stringify(row));
    for (const [k, v] of await s.storage.list())
      parts.push(k, JSON.stringify(v));
    return parts.join("\n");
  });

beforeEach(async () => {
  await resetDirectory();
  await env.DB.batch([
    env.DB.prepare("delete from org_group_mappings"),
    env.DB.prepare("delete from restricted_groups"),
    env.DB.prepare("delete from directory_members"),
    env.DB.prepare("delete from directory_groups"),
  ]);
  await inDo(async (s) => {
    for (const t of ["kv", "seen", "dirty", "held"])
      s.storage.sql.exec(`delete from ${t}`);
    await s.storage.deleteAlarm();
  });
  await registerInstall();
  g = fakeDirectory();
  box = new TokenBox();
  gateCalls.length = 0;
  e = hostedEnv({ ...mailer().env, DIRECTORY_SYNC: fakeNs });
  const email = uniq("bp-owner");
  owner = { ...(await login(email, "owner")), email };
  adminSub = `g-admin-${crypto.randomUUID()}`;
  g.addUser({ id: adminSub, primaryEmail: uniq("super"), isAdmin: true });
});

/** Connects through the request's props, then syncs to ok by scheduler ticks. */
async function connected(t0: number) {
  clock = t0;
  expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(true);
  // Hosted: the confirm's kick handed a token with the request's props.
  if (!e.DIRECTORY_BROKER) expect(box.tok).not.toBeNull();
  expect(await alarms(t0)).toBe("done");
  expect((await status()).state).toBe("ok");
}

describe("directory routes through props", () => {
  it("connect (token), confirm (token), sync (token) and disconnect (revoke) each POST through DIRECTORY_BROKER, never HTTPS", async () => {
    const t0 = Date.now();
    await connected(t0);
    expect(gateCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /google/directory/token", // completeConsent (callback)
      "POST /google/directory/token", // confirm's access token check
      "POST /google/directory/token", // feedSync after the confirm's kick
    ]);
    const r = await post(e, R.directoryDisconnect, owner.cookie);
    expect(r.status).toBe(200);
    expect(gateCalls.at(-1)).toEqual({
      method: "POST",
      path: "/google/directory/revoke",
    });
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    expect(httpsBrokerCalls()).toBe(0);
  });

  it("hosted without props: every directory call fails closed with broker_unavailable", async () => {
    const t0 = Date.now();
    await connected(t0);
    const sealed = (
      await env.DB.prepare(
        "select value from directory_state where key = 'refresh'",
      ).first<{ value: string }>()
    )?.value as string;
    const c = directoryClient(e);
    await expect(c?.accessToken(sealed)).rejects.toMatchObject({
      stage: "broker_unavailable",
    });
    await expect(c?.revoke(sealed)).rejects.toMatchObject({
      stage: "broker_unavailable",
    });
    await expect(
      c?.completeConsent({ code: "x", verifier: "y", bstate: "z" }),
    ).rejects.toMatchObject({ stage: "broker_unavailable" });
    expect(httpsBrokerCalls()).toBe(0);
  });

  it("a gate refusal is gate_refused, distinct from the broker's 401 (refused)", async () => {
    const t0 = Date.now();
    await connected(t0);
    const sealed = (
      await env.DB.prepare(
        "select value from directory_state where key = 'refresh'",
      ).first<{ value: string }>()
    )?.value as string;
    const c = directoryClient(e);
    const via = (status: number, error: string) =>
      withBrokerProps(
        {
          props: {
            DIRECTORY_BROKER: {
              fetch: async () =>
                Response.json(
                  { error },
                  {
                    status,
                    headers: status === 401 ? {} : { "x-oa-gate": "1" },
                  },
                ),
            },
          },
        },
        () => c?.accessToken(sealed),
      );
    await expect(via(403, "install_mismatch")).rejects.toMatchObject({
      stage: "gate_refused",
    });
    await expect(via(401, "unauthorized")).rejects.toMatchObject({
      stage: "refused",
    });
    // The broker's own 404 not_found (no x-oa-gate): not a gate refusal.
    await expect(
      withBrokerProps(
        {
          props: {
            DIRECTORY_BROKER: {
              fetch: async () =>
                Response.json({ error: "not_found" }, { status: 404 }),
            },
          },
        },
        () => c?.accessToken(sealed),
      ),
    ).rejects.toMatchObject({ stage: "exchange" });
  });
});

describe("directory sync driven by the scheduler (hosted)", () => {
  it("the alarm never calls a broker: without a token it stops cleanly; with one it calls Google only", async () => {
    const t0 = Date.now();
    await connected(t0);
    const gate0 = gateCalls.length;
    const https0 = httpsBrokerCalls();
    // A new DO instance (evicted): no token in hand.
    box = new TokenBox();
    const google0 = g.adminCalls.length;
    expect(await alarms(t0 + 2 * MIN)).toBe("starved");
    expect(g.adminCalls.length).toBe(google0);
    // Nothing planned or spent while starved; the lane is still due.
    expect(await kv("run.fast")).toBeNull();
    expect(await inDo((s) => engine(s).due(t0 + 2 * MIN))).toBe(true);
    expect((await status()).state).toBe("ok");
    expect(gateCalls.length).toBe(gate0);
    // The scheduler hands a token; the alarms run the fast lane on Google.
    await cronTick(t0 + 2 * MIN);
    expect(gateCalls.length).toBe(gate0 + 1);
    const gate1 = gateCalls.length;
    expect(await alarms(t0 + 2 * MIN)).toBe("done");
    expect(g.adminCalls.length).toBeGreaterThan(google0);
    // The alarms made no broker call by any transport.
    expect(gateCalls.length).toBe(gate1);
    expect(httpsBrokerCalls()).toBe(https0);
    // A tick with a token in hand and nothing due mints nothing.
    await cronTick(t0 + 3 * MIN);
    expect(gateCalls.length).toBe(gate1);
  });

  it("the DO's storage never holds the access token; it stays in memory and drops at expiry", async () => {
    const t0 = Date.now();
    await connected(t0);
    await period(t0 + 2 * MIN);
    expect(box.tok?.token).toBe("at-refreshed");
    const dump = await doStorageDump();
    expect(dump.length).toBeGreaterThan(0);
    expect(dump).not.toContain("at-refreshed");
    const d1 = await env.DB.prepare(
      "select group_concat(value) as v from directory_state",
    ).first<{ v: string }>();
    expect(d1?.v ?? "").not.toContain("at-refreshed");
    // Expired: dropped by the next alarm, not used.
    const exp = (box.tok?.exp ?? 0) + 1;
    await inDo((s) => engine(s).alarm(exp));
    expect(box.tok).toBeNull();
  });

  it("parity: a full sync applies the same members as the self-hosted path", async () => {
    const us = dirUsers(4, "full");
    const gid = `grp-full-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    expect(await membersOf(gid)).toHaveLength(4);
    g.removeMember(gid, us[0]?.id as string);
    // The hourly reconcile on the scheduler's tick.
    expect(await period(t0 + 61 * MIN)).toBe("done");
    expect(await membersOf(gid)).toHaveLength(3);
    expect((await status()).state).toBe("ok");
  });

  it("parity (#412): an active listing of 0 holds the sweep; the owner's confirm (request props) applies it", async () => {
    const us = dirUsers(3, "zero");
    const gid = `grp-zero-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    const t0 = Date.now();
    await connected(t0);
    g.setEmptyActive(true);
    g.removeMember(gid, us[0]?.id as string);
    await period(t0 + 61 * MIN);
    expect(await membersOf(gid)).toHaveLength(3);
    const st = await status();
    expect(st.held.map((h) => h.groupId)).toEqual([gid]);
    expect(st.held[0]).toMatchObject({ wouldRemove: 1, members: 3 });
    // The confirm is a request: its kick feeds a token if the DO needs one.
    box = new TokenBox();
    g.setEmptyActive(false);
    clock = t0 + 62 * MIN;
    const gate0 = gateCalls.length;
    const r = await post(e, R.directoryHeldConfirm(gid), owner.cookie);
    expect(r.status).toBe(202);
    expect(gateCalls.length).toBe(gate0 + 1);
    expect(await alarms(t0 + 62 * MIN)).toBe("done");
    expect(await membersOf(gid)).toHaveLength(2);
    expect((await status()).held).toEqual([]);
  });

  it("a token expiring mid-run stops cleanly (no failure) and the next tick resumes from the same page", async () => {
    const us = dirUsers(6, "exp");
    const gid = `grp-exp-${crypto.randomUUID()}`;
    await mappedGroup(
      gid,
      us.map((u) => u.id),
    );
    g.setMemberPageSize(2);
    const t0 = Date.now();
    await connected(t0);
    g.removeMember(gid, us[5]?.id as string);
    const t1 = t0 + 61 * MIN;
    await cronTick(t1);
    // A few pages of the reconcile, then the token expires.
    await inDo(async (s) => {
      for (let i = 0; i < 3; i++) await engine(s).alarm(t1);
    });
    const mid = await kv<{ queue: unknown[] }>("run.rec");
    expect(mid).not.toBeNull();
    const google0 = g.adminCalls.length;
    const t2 = t1 + TOKEN_TTL_MS;
    expect(await alarms(t2)).toBe("starved");
    expect(g.adminCalls.length).toBe(google0);
    expect(await kv("run.rec")).toEqual(mid);
    expect(await kv("retryAt.rec")).toBeNull();
    expect((await status()).state).toBe("ok");
    expect(await membersOf(gid)).toHaveLength(6);
    // The next scheduler tick mints again and the run finishes.
    expect(await period(t2 + 2 * MIN)).toBe("done");
    expect(await kv("run.rec")).toBeNull();
    expect(await membersOf(gid)).toHaveLength(5);
    expect((await status()).state).toBe("ok");
  });

  it("a mint failure handed over fails the lane exactly as a failed mint in the alarm (binding) did", async () => {
    const outcome = async (hosted: boolean) => {
      await resetDirectory();
      await inDo(async (s) => {
        for (const t of ["kv", "seen", "dirty", "held"])
          s.storage.sql.exec(`delete from ${t}`);
        await s.storage.deleteAlarm();
      });
      box = new TokenBox();
      g.setRefreshStatus(200);
      e = hostedEnv({
        DIRECTORY_SYNC: fakeNs,
        ...(hosted
          ? {}
          : { DIRECTORY_BROKER: brokerGate() as unknown as Fetcher }),
      });
      const t0 = Date.now();
      await connected(t0);
      box = new TokenBox();
      g.setRefreshStatus(400);
      const t1 = t0 + 2 * MIN;
      if (hosted) await period(t1);
      else await alarms(t1);
      return {
        retry: ((await kv<number>("retryAt.fast")) as number) - t1,
        state: (await status()).state,
        code: (await status()).lastError?.message,
      };
    };
    const before = await outcome(false);
    const after = await outcome(true);
    expect(after).toEqual(before);
    expect(before.state).toBe("auth_failed");
    expect(before.retry).toBe(RETRY_HOURLY_MS);
    // Not due during the retry wait: the tick mints nothing.
    const gate0 = gateCalls.length;
    await cronTick(Date.now() + 10 * MIN);
    expect(gateCalls.length).toBe(gate0);
  });

  it("revoke at delete (oa:directory-disconnect, H-DV) runs under the scheduler's props", async () => {
    const t0 = Date.now();
    await connected(t0);
    const calls: GateCall[] = [];
    await scheduled(
      { cron: DIRECTORY_DISCONNECT_CRON },
      e,
      ctxOf({ DIRECTORY_BROKER: brokerGate(calls) }),
    );
    expect(calls).toEqual([
      { method: "POST", path: "/google/directory/revoke" },
    ]);
    expect(g.revoked).toEqual([`rt-${adminSub}`]);
    expect(httpsBrokerCalls()).toBe(0);
    // Without props, the same job rejects and keeps the grant.
    await resetDirectory();
    clock = t0;
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    await expect(
      scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, e, ctxOf()),
    ).rejects.toThrow();
    expect(g.revoked).toHaveLength(1);
  });

  it("self-host (a binding, or its own Google app): feedSync does nothing and the alarm mints as before", async () => {
    const t0 = Date.now();
    clock = t0;
    const calls: GateCall[] = [];
    const bound = hostedEnv({
      DIRECTORY_SYNC: fakeNs,
      DIRECTORY_BROKER: brokerGate(calls) as unknown as Fetcher,
    });
    e = bound;
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    expect(
      await withBrokerProps({ props: hostedProps() }, () => feedSync(e)),
    ).toBe("self");
    box = new TokenBox();
    const n = calls.length;
    expect(await alarms(t0)).toBe("done");
    // The alarm minted through the binding (as the alarm did before).
    expect(calls.length).toBe(n + 1);
    expect(await feedSync(directEnv({ DIRECTORY_SYNC: fakeNs }))).toBe("self");
  });
});

describe("cadence", () => {
  it("the constants are unchanged", () => {
    expect([
      FAST_MS,
      RECONCILE_MS,
      BACKOFF_MIN_MS,
      BACKOFF_MAX_MS,
      RETRY_HOURLY_MS,
      TOKEN_TTL_MS,
    ]).toEqual([2 * MIN, 60 * MIN, 2 * MIN, 30 * MIN, 60 * MIN, 45 * MIN]);
    expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual(
      [2, 4, 8, 16, 30, 30].map((m) => m * MIN),
    );
  });

  it("the scheduler asks for a token exactly when the alarm's lane timing is due (fast, reconcile, backoff)", async () => {
    const t0 = Date.now();
    await connected(t0);
    box = new TokenBox();
    // A DO with no token in hand (wantsToken is false while one is).
    const wants = (at: number) => {
      box = new TokenBox();
      return inDo((s) => engine(s).wantsToken(at));
    };
    const due = (at: number) => inDo((s) => engine(s).due(at));
    // fast: due FAST_MS after the last run, not a ms before
    for (const at of [t0 + FAST_MS - 1, t0 + FAST_MS]) {
      expect(await wants(at)).toBe(await due(at));
    }
    expect(await wants(t0 + FAST_MS - 1)).toBe(false);
    expect(await wants(t0 + FAST_MS)).toBe(true);
    expect(await kv("next.reconcile")).toBe(t0 + RECONCILE_MS);
    expect(await kv("next.fast")).toBe(t0 + FAST_MS);
    // backoff: a failed fast run (Google 503) retries after backoffMs(n)
    g.fail(/\/reports\//, 503, { times: 2 });
    const t1 = t0 + FAST_MS;
    await period(t1);
    expect(await kv("retryAt.fast")).toBe(t1 + BACKOFF_MIN_MS);
    expect(await wants(t1 + BACKOFF_MIN_MS - 1)).toBe(false);
    expect(await wants(t1 + BACKOFF_MIN_MS)).toBe(true);
    const t2 = t1 + BACKOFF_MIN_MS;
    await period(t2);
    expect(await kv("retryAt.fast")).toBe(t2 + backoffMs(2));
    expect(await wants(t2 + backoffMs(2) - 1)).toBe(false);
    expect(await wants(t2 + backoffMs(2))).toBe(true);
    // reconcile: due at next.reconcile
    g.clearFailures();
    const t3 = t2 + backoffMs(2);
    await period(t3);
    const nr = (await kv<number>("next.reconcile")) as number;
    expect(nr).toBe(t0 + RECONCILE_MS);
    expect(await due(nr)).toBe(true);
    expect(await wants(nr)).toBe(true);
  });
});

describe("review fixes", () => {
  const audits = async (action: string) =>
    (
      await env.DB.prepare(
        "select count(*) n from audit_events where action = ?",
      )
        .bind(action)
        .first<{ n: number }>()
    )?.n ?? 0;

  it("M1: a lane due past NO_FEED_MS with no token fails as transport_no_feed (audited, and stale past STALE_MS)", async () => {
    const t0 = Date.now();
    await connected(t0);
    box = new TokenBox();
    const failed0 = await audits("directory.sync.failed");
    // Starved under NO_FEED_MS: no failure.
    const t1 = t0 + 2 * MIN;
    expect(await alarms(t1)).toBe("starved");
    expect(await alarms(t1 + NO_FEED_MS - 1)).toBe("starved");
    expect(await kv("retryAt.fast")).toBeNull();
    expect((await status()).state).toBe("ok");
    // Past it: the lane fails like any other failure.
    const t2 = t1 + NO_FEED_MS + MIN;
    await alarms(t2);
    expect(await kv("retryAt.fast")).toBe(t2 + BACKOFF_MIN_MS);
    const s = await status();
    expect(s.state).toBe("backoff");
    expect(s.lastError?.message).toBe("transport_no_feed");
    expect(await audits("directory.sync.failed")).toBe(failed0 + 1);
    // Still no feed a week later: stale, audited once.
    const stale0 = await audits("directory.stale");
    const late = t0 + STALE_MS + 16 * MIN;
    await alarms(late);
    await alarms(late + NO_FEED_MS + MIN);
    expect(await audits("directory.stale")).toBe(stale0 + 1);
    // A feed clears it: the next tick mints and the lane succeeds.
    const back = late + NO_FEED_MS + MIN + BACKOFF_MAX_MS;
    expect(await period(back)).toBe("done");
    expect((await status()).state).toBe("ok");
    expect(await kv("nofeed.since")).toBeNull();
  });

  it("M1: a hosted feed without props is no_props (logged), not self", async () => {
    const t0 = Date.now();
    await connected(t0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n = rpcs.length;
    expect(await feedSync(e)).toBe("no_props");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "directory_feed",
    );
    expect(rpcs.length).toBe(n);
  });

  it("M2: a mint failing outside the transport (an undecryptable token) fails the lane as the self-host alarm does", async () => {
    const outcome = async (hosted: boolean) => {
      await resetDirectory();
      await inDo(async (s) => {
        for (const t of ["kv", "seen", "dirty", "held"])
          s.storage.sql.exec(`delete from ${t}`);
        await s.storage.deleteAlarm();
      });
      box = new TokenBox();
      e = hostedEnv({
        DIRECTORY_SYNC: fakeNs,
        ...(hosted
          ? {}
          : { DIRECTORY_BROKER: brokerGate() as unknown as Fetcher }),
      });
      const t0 = Date.now();
      await connected(t0);
      box = new TokenBox();
      // A sealed token this install can't open.
      await env.DB.prepare(
        "update directory_state set value = 'not-a-sealed-token' where key = 'refresh'",
      ).run();
      const t1 = t0 + 2 * MIN;
      if (hosted) await cronTick(t1);
      await alarms(t1);
      return {
        retry: ((await kv<number>("retryAt.fast")) as number) - t1,
        state: (await status()).state,
        code: (await status()).lastError?.message,
      };
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await outcome(false);
    const after = await outcome(true);
    expect(after).toEqual(before);
    expect(before).toEqual({
      retry: BACKOFF_MIN_MS,
      state: "backoff",
      code: "internal",
    });
  });

  it("L2: a capability used past its invocation hands nothing over; the next tick retries", async () => {
    const t0 = Date.now();
    await connected(t0);
    box = new TokenBox();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clock = t0 + 2 * MIN;
    const stale = {
      DIRECTORY_BROKER: {
        fetch: async () => {
          throw new Error(
            "Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and others) created in the context of one request handler cannot be accessed from a different request's handler.",
          );
        },
      },
    };
    const hands = () => rpcs.filter((r) => r === "handToken").length;
    const n = hands();
    expect(await withBrokerProps({ props: stale }, () => feedSync(e))).toBe(
      "stale_props",
    );
    expect(hands()).toBe(n);
    expect(box.fault).toBeNull();
    expect(await alarms(t0 + 2 * MIN)).toBe("starved");
    expect(await kv("retryAt.fast")).toBeNull();
    // The next tick, with a live capability, runs it.
    expect(await period(t0 + 3 * MIN)).toBe("done");
    expect((await status()).state).toBe("ok");
  });

  it("L3: a never-connected install doesn't wake its DO", async () => {
    const n = rpcs.length;
    clock = Date.now();
    expect(
      await withBrokerProps({ props: hostedProps() }, () => feedSync(e)),
    ).toBe("unbound");
    await cronTick(clock);
    expect(rpcs.length).toBe(n);
    expect(await inDo((s) => s.storage.getAlarm())).toBeNull();
  });

  it("P2.5 #15: a reconnect waiting for confirm keeps feeding (and syncing) the live binding", async () => {
    const t0 = Date.now();
    await connected(t0);
    const r = await connect(
      e,
      owner.cookie,
      g,
      { sub: adminSub },
      {
        confirm: false,
      },
    );
    expect(r.consented).toBe(true);
    // The DO's token is gone (evicted): the next due lane wants one.
    box = new TokenBox();
    clock = t0 + FAST_MS;
    expect(
      await withBrokerProps({ props: hostedProps() }, () => feedSync(e)),
    ).toBe("fed");
    expect(await alarms(t0 + FAST_MS)).toBe("done");
  });

  it("L5: a token or fault held for another binding is never used", async () => {
    const t0 = Date.now();
    await connected(t0);
    const google0 = g.adminCalls.length;
    box = new TokenBox();
    box.tok = { token: "at-other", exp: t0 + TOKEN_TTL_MS, for: "C-other:1" };
    expect(await alarms(t0 + 2 * MIN)).toBe("starved");
    expect(box.tok).toBeNull();
    expect(g.adminCalls.length).toBe(google0);
    expect(await kv("retryAt.fast")).toBeNull();
    box.fault = { stage: "invalid_grant", for: "C-other:1" };
    expect(await alarms(t0 + 2 * MIN)).toBe("starved");
    expect(box.fault).toBeNull();
    expect((await status()).state).toBe("ok");
  });

  it("L5: an alarm reached inside a props scope still never uses the capability", async () => {
    const t0 = Date.now();
    await connected(t0);
    box = new TokenBox();
    const calls: GateCall[] = [];
    await inDo((s) =>
      withBrokerProps({ props: { DIRECTORY_BROKER: brokerGate(calls) } }, () =>
        engine(s).alarm(t0 + 2 * MIN),
      ),
    );
    expect(calls).toEqual([]);
    expect(box.tok).toBeNull();
    expect(await kv("run.fast")).toBeNull();
  });

  it("L5: reset() drops the token at once, before the alarm applies it", async () => {
    const t0 = Date.now();
    await connected(t0);
    expect(box.tok).not.toBeNull();
    await inDo((s) => engine(s).reset(t0 + MIN));
    expect(box.tok).toBeNull();
    expect(box.fault).toBeNull();
  });

  it("L5: a customer swap while a token is held, then a late hand-over for the old binding, is refused", async () => {
    const t0 = Date.now();
    await connected(t0);
    const old = box.tok?.for as string;
    expect(old).toBeTruthy();
    // Reconnect (a new binding): the confirm resets, then feeds the new one.
    clock = t0 + MIN;
    expect((await connect(e, owner.cookie, g, { sub: adminSub })).ok).toBe(
      true,
    );
    const fresh = box.tok?.for as string;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);
    expect(await alarms(t0 + MIN)).toBe("done");
    // A late hand-over minted for the old binding.
    await inDo((s) =>
      engine(s).handToken(old, { token: "at-late" }, t0 + 3 * MIN),
    );
    const google0 = g.adminCalls.length;
    expect(await alarms(t0 + 3 * MIN)).toBe("starved");
    expect(box.tok).toBeNull();
    expect(g.adminCalls.length).toBe(google0);
  });
});
