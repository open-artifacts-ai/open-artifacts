// P3 Task 7b: UserPresence closes a revoked user's live sockets at once
// (the DO class alone is in presence.class.test.ts).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { mw } from "../src/auth/route-policy.js";
import type { AppType } from "../src/routes/index.js";
import { mountRoutes } from "../src/routes/index.js";
import {
  ACTOR_HEADER,
  AUTHZ_AT_HEADER,
  runtimeStub,
} from "../src/runtime/do.js";
import {
  retryBackoffMs,
  SKEW_MS,
  type UserPresence,
} from "../src/runtime/presence.js";
import { REVOKE_RETRIES, revokeUserLive } from "../src/runtime/revoke.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let member: U;

async function mk(prefix: string, role: Member["role"]): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const pub = async () =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "presence",
        format: "html",
        content: "<p>x</p>",
        visibility: "team",
        capabilities: { db: true, viewer: true, storage: true },
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

type Sock = { ws: WebSocket; closed: Promise<number>; isOpen: () => boolean };
function wrap(ws: WebSocket): Sock {
  let open = true;
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => {
      open = false;
      res((e as CloseEvent).code);
    }),
  );
  ws.accept();
  return { ws, closed, isOpen: () => open };
}
async function viaRoute(path: string, u: U, a = app): Promise<Sock> {
  const r = await api(a, path, u.cookie, {
    headers: { upgrade: "websocket", "cf-connecting-ip": "198.51.100.9" },
  });
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}
const openSockets = async (u: U, id: string) => ({
  data: await viaRoute(R.dataSubscribe(id, "c"), u),
  events: await viaRoute(R.events(id), u),
});

/** A data socket straight to the artifact DO, authorized at `authzAt`. */
async function direct(id: string, userId: string, authzAt: number) {
  const r = await runtimeStub(env, id).fetch(
    "https://runtime.invalid/subscribe?collection=c",
    {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: `u:${userId}`,
        [AUTHZ_AT_HEADER]: String(authzAt),
      },
    },
  );
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}

const presence = (userId: string) => {
  const ns = env.USER_PRESENCE;
  if (!ns) throw new Error("USER_PRESENCE unbound");
  return ns.get(ns.idFromName(userId));
};
const inPresence = <T>(
  userId: string,
  cb: (p: UserPresence) => T | Promise<T>,
) =>
  runInDurableObject(
    presence(userId) as unknown as DurableObjectStub<UserPresence>,
    cb,
  );
const tick = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  owner = await mk("pr-owner", "member");
  member = await mk("pr-member", "member");
});

describe("UserPresence", () => {
  it("suspending a user closes their data and events sockets with 4403", async () => {
    const u = await mk(`pr-s-${newId().slice(0, 4)}`, "member");
    const art = await pub();
    const ws = await openSockets(u, art);
    await env.DB.prepare("update users set status = 'suspended' where id = ?")
      .bind(u.userId)
      .run();
    await revokeUserLive(env, u.userId, "suspended");
    expect(await ws.data.closed).toBe(4403);
    expect(await ws.events.closed).toBe(4403);
  });

  it("socket accepted after revocation started is closed (authzAt <= revokedAt)", async () => {
    const uid = `pr-race-${newId()}`;
    const art = await pub();
    await revokeUserLive(env, uid, "removed");
    const revokedAt = await inPresence(uid, (p) => p.revokedAt());
    expect(revokedAt).not.toBeNull();
    const before = await direct(art, uid, (revokedAt as number) - 5);
    const same = await direct(art, uid, revokedAt as number);
    expect(await before.closed).toBe(4403);
    expect(await same.closed).toBe(4403);
    // Authorized after the revocation plus the skew margin (a reactivated
    // user): stays open.
    const after = await direct(art, uid, (revokedAt as number) + SKEW_MS + 1);
    await tick();
    expect(after.isOpen()).toBe(true);
    after.ws.close();
  });

  it("other users' sockets stay open", async () => {
    const u = await mk(`pr-o-${newId().slice(0, 4)}`, "member");
    const art = await pub();
    const mine = await openSockets(u, art);
    const theirs = await openSockets(member, art);
    await revokeUserLive(env, u.userId, "suspended");
    expect(await mine.data.closed).toBe(4403);
    expect(await mine.events.closed).toBe(4403);
    await tick();
    expect(theirs.data.isOpen()).toBe(true);
    expect(theirs.events.isOpen()).toBe(true);
    theirs.data.ws.close();
    theirs.events.ws.close();
  });

  it("a failed closeActor is retried from the queue", async () => {
    const uid = `pr-retry-${newId()}`;
    const art = await pub();
    const s = await direct(art, uid, Date.now());
    let calls = 0;
    // Within the socket TTL of the touch above, still far from due.
    const base = Date.now() + 300_000;
    await inPresence(uid, async (p) => {
      p.now = () => base;
      const real = p.closer;
      p.closer = async (...a) => {
        if (++calls === 1) throw new Error("boom");
        return real(...a);
      };
      expect(await p.closeAll("suspended")).toBe(0);
      expect(p.pendingRetries()).toMatchObject([
        { artifactId: art, attempts: 1 },
      ]);
    });
    expect(s.isOpen()).toBe(true);
    // Make the queued retry due, then fire the alarm.
    await inPresence(uid, (p) => {
      p.now = () => base + retryBackoffMs(1);
    });
    expect(await runDurableObjectAlarm(presence(uid))).toBe(true);
    expect(await s.closed).toBe(4403);
    expect(calls).toBe(2);
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("revokeUserLive never throws", async () => {
    await expect(
      revokeUserLive({ USER_PRESENCE: undefined }, "u1", "x"),
    ).resolves.toBeUndefined();
    const broken = {
      USER_PRESENCE: {
        idFromName: () => {
          throw new Error("boom");
        },
      } as never,
    };
    await expect(revokeUserLive(broken, "u1", "x")).resolves.toBeUndefined();
    const ctx = {
      waitUntil: () => {
        throw new Error("no ctx");
      },
    };
    await expect(
      revokeUserLive(broken, "u1", "x", ctx),
    ).resolves.toBeUndefined();
  });

  it("revokeUserLive retries a failed closeAll, then gives up quietly", async () => {
    let calls = 0;
    const flaky = (failures: number) => ({
      USER_PRESENCE: {
        idFromName: (n: string) => n,
        get: () => ({
          closeAll: async () => {
            if (++calls <= failures) throw new Error("transient");
            return 0;
          },
        }),
      } as never,
    });
    await revokeUserLive(flaky(2), "u1", "x");
    expect(calls).toBe(3);
    calls = 0;
    await expect(revokeUserLive(flaky(99), "u1", "x")).resolves.toBeUndefined();
    expect(calls).toBe(REVOKE_RETRIES + 1);
  });

  it("presence_unbound is logged at most once per isolate", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await revokeUserLive({ USER_PRESENCE: undefined }, "u1", "x");
      await revokeUserLive({ USER_PRESENCE: undefined }, "u2", "x");
      const n = spy.mock.calls.filter((c) =>
        String(c[0]).includes("presence_unbound"),
      ).length;
      expect(n).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a revocation between the session read and the handler closes the socket 4403", async () => {
    const u = await mk(`pr-mid-${newId().slice(0, 4)}`, "member");
    const art = await pub();
    // Runs after the policy gate (session read, prefetched access) and
    // before the socket handlers: the revocation lands in between.
    const revokeNow = mw(async (_c: unknown, next: () => Promise<void>) => {
      await revokeUserLive(env, u.userId, "suspended");
      // Past the skew margin: only an authzAt stamped before the session
      // read (not at the handler) is still refused.
      await new Promise((r) => setTimeout(r, SKEW_MS + 200));
      await next();
    });
    const racing = createApp((a: AppType) => {
      a.use("/api/v1/artifacts/:id/data-subscribe", revokeNow);
      a.use("/api/v1/artifacts/:id/events", revokeNow);
      mountRoutes(a);
    });
    const data = await viaRoute(R.dataSubscribe(art, "c"), u, racing);
    const events = await viaRoute(R.events(art), u, racing);
    expect(await data.closed).toBe(4403);
    expect(await events.closed).toBe(4403);
  }, 20_000);

  it("a signed-in socket without an authorization time is refused", async () => {
    const art = await pub();
    const r = await runtimeStub(env, art).fetch(
      "https://runtime.invalid/subscribe?collection=c",
      { headers: { Upgrade: "websocket", [ACTOR_HEADER]: "u:someone" } },
    );
    expect(r.status).toBe(400);
  });

  it("closeActor closes only that actor's data and events sockets", async () => {
    const art = await pub();
    const a = await openSockets(member, art);
    const b = await direct(art, `pr-b-${newId()}`, Date.now());
    const n = await runtimeStub(env, art).closeActor(`u:${member.userId}`, "x");
    expect(n).toBe(2);
    expect(await a.data.closed).toBe(4403);
    expect(await a.events.closed).toBe(4403);
    await tick();
    expect(b.isOpen()).toBe(true);
    b.ws.close();
  });
});
