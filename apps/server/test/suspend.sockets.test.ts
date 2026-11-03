// #1182: the platform's suspend closes every open socket on the install
// (cron.ts CLOSE_SOCKETS_CRON, the socket index in runtime/presence.ts), and
// sets nothing that refuses a socket once the install serves again.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CLOSE_SOCKETS_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import type { ArtifactRuntime } from "../src/runtime/do.js";
import { runtimeStub } from "../src/runtime/do.js";
import {
  CLOSE_FANOUT,
  INDEX_WINDOW_MS,
  INSTALL_INDEX,
  LATER_PASSES_MS,
  SECOND_PASS_MS,
  type UserPresence,
} from "../src/runtime/presence.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member };
let owner: U;
let viewer: U;

async function mk(prefix: string): Promise<U> {
  const l = await login(`${prefix}-${tag}@x.com`, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m };
}

const pub = async (visibility: "public" | "team") =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "suspend",
        format: "html",
        content: "<p>x</p>",
        visibility,
        capabilities: { db: true, viewer: true, storage: true },
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

type Sock = {
  ws: WebSocket;
  closed: Promise<number>;
  isOpen: () => boolean;
  frames: string[];
};
function wrap(ws: WebSocket): Sock {
  let open = true;
  const frames: string[] = [];
  ws.addEventListener("message", (e) => frames.push(String(e.data)));
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => {
      open = false;
      res((e as CloseEvent).code);
    }),
  );
  ws.accept();
  return { ws, closed, isOpen: () => open, frames };
}
let ipSeq = 0;
/** A socket through the route: `u` null is anonymous. */
async function viaRoute(path: string, u: U | null): Promise<Sock> {
  const r = await api(app, path, u?.cookie ?? null, {
    headers: {
      upgrade: "websocket",
      "cf-connecting-ip": `198.51.100.${(++ipSeq % 250) + 1}`,
    },
  });
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}
/** Every kind: events and data, signed-in and anonymous. */
async function everyKind(pubId: string, teamId: string) {
  return {
    userEvents: await viaRoute(R.events(teamId), viewer),
    userData: await viaRoute(R.dataSubscribe(teamId, "c"), viewer),
    anonEvents: await viaRoute(R.events(pubId), null),
    anonData: await viaRoute(R.dataSubscribe(pubId, "c"), null),
    userOnPublic: await viaRoute(R.events(pubId), owner),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 50));
/** The close code, or "open" if the socket is still open after 2 s. */
const closedIn = (s: Sock): Promise<number | "open"> =>
  Promise.race([
    s.closed,
    new Promise<"open">((r) => setTimeout(() => r("open"), 2000)),
  ]);
const ctx = () =>
  ({
    waitUntil: () => {},
    passThroughOnException() {},
    props: {},
  }) as unknown as ExecutionContext;
const runJob = (e: Env = env as unknown as Env) =>
  scheduled({ cron: CLOSE_SOCKETS_CRON }, e, ctx());

const presence = (name: string) => {
  const ns = env.USER_PRESENCE;
  if (!ns) throw new Error("USER_PRESENCE unbound");
  return ns.get(
    ns.idFromName(name),
  ) as unknown as DurableObjectStub<UserPresence>;
};
const index = () => presence(INSTALL_INDEX);
/**
 * Runs the index's alarm until `done` (at most 10 runs): an alarm re-armed
 * in the past may also fire on its own, so a count of runs is not exact.
 */
async function alarmsUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 10 && !done(); i++) {
    await runDurableObjectAlarm(index());
    await tick();
  }
}
/** The DO's own SQL storage, inside runInDurableObject. */
const sqlOf = (p: UserPresence) =>
  (p as unknown as { ctx: DurableObjectState }).ctx.storage.sql;

beforeAll(async () => {
  owner = await mk("sus-owner");
  viewer = await mk("sus-viewer");
});

describe("oa:close-sockets (#1182)", () => {
  it("closes every kind of open socket, signed-in and anonymous, with 4403 (never the TTL's 4408)", async () => {
    const pubId = await pub("public");
    const teamId = await pub("team");
    const s = await everyKind(pubId, teamId);
    await tick();
    for (const k of Object.values(s)) expect(k.isOpen()).toBe(true);
    await runJob();
    const codes = Object.fromEntries(
      await Promise.all(
        Object.entries(s).map(
          async ([k, v]) => [k, await closedIn(v)] as const,
        ),
      ),
    );
    expect(codes).toEqual({
      userEvents: 4403,
      userData: 4403,
      anonEvents: 4403,
      anonData: 4403,
      userOnPublic: 4403,
    });
    // Events sockets are told to ask again (gone "changed"), not "deleted".
    expect(s.anonEvents.frames.at(-1)).toBe(
      '{"type":"gone","reason":"changed"}',
    );
    expect(s.userEvents.frames.at(-1)).toBe(
      '{"type":"gone","reason":"changed"}',
    );
  });

  it("after the job (a resume needs nothing): new sockets of every kind open and stay open; a reconnecting user is accepted", async () => {
    const pubId = await pub("public");
    const teamId = await pub("team");
    const before = await everyKind(pubId, teamId);
    await runJob();
    for (const v of Object.values(before)) expect(await closedIn(v)).toBe(4403);
    // The reconnect: same users, same artifacts, right after the close.
    const after = await everyKind(pubId, teamId);
    await tick();
    for (const [k, v] of Object.entries(after))
      expect({ k, open: v.isOpen() }).toEqual({ k, open: true });
    expect(JSON.parse(after.userEvents.frames[0] ?? "{}")).toMatchObject({
      type: "hello",
    });
    expect(JSON.parse(after.anonEvents.frames[0] ?? "{}")).toMatchObject({
      type: "hello",
    });
    // Nothing set that refuses a later accept: no user revocation, no
    // access change on the artifact.
    for (const u of [viewer, owner])
      expect(
        await runInDurableObject(presence(u.userId), (p) => p.revokedAt()),
      ).toBeNull();
    for (const id of [pubId, teamId])
      expect(
        await runInDurableObject(
          runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
          (d) => d.accessChangedAt(),
        ),
      ).toBeNull();
    expect(await runInDurableObject(index(), (p) => p.revokedAt())).toBeNull();
    for (const v of Object.values(after)) v.ws.close();
  });

  it("the second pass closes a socket that reconnected before dispatch saw the pause", async () => {
    const pubId = await pub("public");
    const first = await viaRoute(R.events(pubId), null);
    await runJob();
    expect(await closedIn(first)).toBe(4403);
    const due = await runInDurableObject(index(), (p) => p.pendingSweep());
    expect(due).toEqual(expect.any(Number));
    // Reconnected inside the HOSTS propagation window.
    const again = await viaRoute(R.events(pubId), null);
    await tick();
    expect(again.isOpen()).toBe(true);
    // The second pass, SECOND_PASS_MS later.
    await runInDurableObject(index(), (p) => {
      const base = p.now;
      p.now = () => base() + SECOND_PASS_MS;
    });
    try {
      // The pass queues the closes; they run on that alarm or the next.
      await alarmsUntil(() => !again.isOpen());
      expect(await closedIn(again)).toBe(4403);
      // The 5-minute pass is still to come, for a slow edge.
      expect(
        await runInDurableObject(index(), (p) => p.pendingSweep()),
      ).toEqual(expect.any(Number));
      // A slow edge: a reconnect after the second pass.
      const late = await viaRoute(R.events(pubId), null);
      await tick();
      expect(late.isOpen()).toBe(true);
      await runInDurableObject(index(), (p) => {
        const base = p.now;
        p.now = () => base() + (LATER_PASSES_MS[1] - SECOND_PASS_MS);
      });
      await alarmsUntil(() => !late.isOpen());
      expect(await closedIn(late)).toBe(4403);
      expect(
        await runInDurableObject(index(), (p) => p.pendingSweep()),
      ).toBeNull();
    } finally {
      await runInDurableObject(index(), (p) => {
        p.now = () => Date.now();
      });
    }
  });

  it("rejects when the socket index is unbound (no USER_PRESENCE), so the caller logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        runJob({ ...(env as unknown as Env), USER_PRESENCE: undefined }),
      ).rejects.toThrow("socket index unbound");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the socket index (UserPresence INSTALL_INDEX)", () => {
  it("is bounded: CLOSE_FANOUT closes per call or alarm run, the rest queued; rows past INDEX_WINDOW_MS are not closed", async () => {
    // The real index, with a counting closer.
    const calls: (string | null)[][] = [];
    const n = CLOSE_FANOUT * 2 + 7;
    const result = await runInDurableObject(index(), async (p) => {
      const base = Date.now();
      p.now = () => base;
      // Clear what earlier tests left.
      sqlOf(p).exec("delete from seen");
      sqlOf(p).exec("delete from retry");
      sqlOf(p).exec("delete from sweep");
      p.closer = async (_e, id, actor) => {
        calls.push([id, actor]);
        return 1;
      };
      for (let i = 0; i < n; i++) p.seen(`art${i}`);
      // Old enough to name no live socket: never closed.
      sqlOf(p).exec(
        "insert into seen (artifact_id, seen_at) values ('old', ?)",
        base - INDEX_WINDOW_MS - 1,
      );
      return p.closeInstall("suspended");
    });
    expect(result).toEqual({
      artifacts: n,
      closed: CLOSE_FANOUT,
      queued: n - CLOSE_FANOUT,
    });
    expect(calls).toHaveLength(CLOSE_FANOUT);
    // actor null: every socket on the artifact.
    expect(calls.every(([, a]) => a === null)).toBe(true);
    await runDurableObjectAlarm(index());
    // One alarm run closes CLOSE_FANOUT more, at most.
    expect(calls.length).toBeLessThanOrEqual(CLOSE_FANOUT * 2);
    await alarmsUntil(() => calls.length >= n);
    expect(calls).toHaveLength(n);
    expect(new Set(calls.map(([id]) => id))).toEqual(
      new Set(Array.from({ length: n }, (_, i) => `art${i}`)),
    );
    expect(calls.some(([id]) => id === "old")).toBe(false);
    // Only the second pass is left.
    const left = await runInDurableObject(index(), (p) => ({
      retries: p.pendingRetries().length,
      sweep: p.pendingSweep(),
    }));
    expect(left.retries).toBe(0);
    expect(left.sweep).toEqual(expect.any(Number));
    await runInDurableObject(index(), (p) => {
      sqlOf(p).exec("delete from seen");
      sqlOf(p).exec("delete from sweep");
      p.now = () => Date.now();
      p.closer = UserPresenceCloser;
    });
  });

  it("a failed close is retried by the alarm; it is logged with a fixed name, no ids", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const calls: string[] = [];
    try {
      await runInDurableObject(index(), async (p) => {
        sqlOf(p).exec("delete from seen");
        sqlOf(p).exec("delete from retry");
        sqlOf(p).exec("delete from sweep");
        p.closer = async (_e, id) => {
          calls.push(id);
          if (fail) throw new Error(`boom ${id} a@b.co`);
          return 1;
        };
        p.seen("artfail");
        const r = await p.closeInstall("suspended");
        expect(r).toEqual({ artifacts: 1, closed: 0, queued: 1 });
        p.now = () => Date.now() + 5_000;
      });
      const lines = err.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.some((l) => l.includes("install_close_failed"))).toBe(true);
      expect(lines.join("\n")).not.toContain("artfail");
      expect(lines.join("\n")).not.toContain("a@b.co");
      // A failed retry (the alarm) logs the same fixed line.
      await alarmsUntil(() => calls.length >= 2);
      const again = err.mock.calls.map((c) => c.map(String).join(" "));
      expect(again.length).toBeGreaterThan(lines.length);
      expect(again.join("\n")).not.toContain("artfail");
      expect(again.join("\n")).not.toContain("a@b.co");
      fail = false;
      await runInDurableObject(index(), (p) => {
        p.now = () => Date.now() + 60_000;
      });
      await alarmsUntil(() => calls.length >= 3);
      expect(calls).toEqual(["artfail", "artfail", "artfail"]);
      expect(
        await runInDurableObject(index(), (p) => p.pendingRetries()),
      ).toEqual([]);
    } finally {
      err.mockRestore();
      await runInDurableObject(index(), (p) => {
        sqlOf(p).exec("delete from seen");
        sqlOf(p).exec("delete from sweep");
        p.now = () => Date.now();
        p.closer = UserPresenceCloser;
      });
    }
  });

  it("the index and a user's presence keep to their own roles", async () => {
    await runInDurableObject(index(), async (p) => {
      expect(() => p.touch("a", Date.now())).toThrow("not a user's presence");
      expect(() => p.markRevoked()).toThrow("not a user's presence");
      await expect(p.closeAll("x")).rejects.toThrow("not a user's presence");
    });
    await runInDurableObject(presence(viewer.userId), async (p) => {
      expect(() => p.seen("a")).toThrow("not the install index");
      await expect(p.closeInstall("x")).rejects.toThrow(
        "not the install index",
      );
    });
  });
});

/** The real closer, restored after a test stubs it. */
const UserPresenceCloser: UserPresence["closer"] = (
  e,
  artifactId,
  actor,
  why,
) => {
  const ns = e.ARTIFACT_RUNTIME;
  const s = ns.get(ns.idFromName(artifactId)) as unknown as {
    closeActor(a: string, r: string): Promise<number>;
    closeAllSockets(r: string): Promise<number>;
  };
  return actor === null ? s.closeAllSockets(why) : s.closeActor(actor, why);
};
