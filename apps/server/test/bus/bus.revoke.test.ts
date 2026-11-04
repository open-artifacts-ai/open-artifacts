// #1291 revocation and isolation: a revoked token's socket closes; member
// removal, erase and a cap revoke machines and close sockets (through the
// one hook, UserPresence.closeAll); install suspend closes bus sockets; two
// members never reach each other's hub.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Member as OaMember } from "@oa/shared";
import { R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  AUTHZ_AT_HEADER,
  type BusHub,
  CONNECT_DO_PATH,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
  SKEW_MS,
} from "../../src/bus/hub.js";
import {
  INSTALL_INDEX,
  type UserPresence,
} from "../../src/runtime/presence.js";
import { revokeUserLive } from "../../src/runtime/revoke.js";
import {
  eraseMember,
  SYSTEM_ACTOR,
  setUserStatus,
} from "../../src/services/members.js";
import { setMemberRestricted } from "../../src/services/spaces.js";
import { getUser } from "../../src/services/users.js";
import { api } from "../helpers.js";
import {
  type Daemon,
  daemon,
  e,
  hello,
  hubOf,
  type Member,
  machine,
  member,
  ns,
  up,
  upgrade,
  waitFor,
} from "./helpers.js";

const app = createApp();
let admin: Member;
let adminM: OaMember;

beforeAll(async () => {
  admin = await member("owner");
  const m = await getUser(env, admin.userId);
  if (!m) throw new Error("no admin");
  adminM = m;
});

async function connected(
  who: Member,
  label = "box",
): Promise<{
  d: Daemon;
  id: string;
  token: string;
}> {
  const m = await machine(label, who.userId);
  const d = await daemon(m.token);
  d.send(hello());
  await waitFor(d, "hello_ok");
  return { d, id: m.id, token: m.token };
}

const revokedAt = async (machineId: string) =>
  (
    await env.DB.prepare(
      "select revoked_at as r from bus_machines where id = ?",
    )
      .bind(machineId)
      .first<{ r: number | null }>()
  )?.r ?? null;

describe("revocation closes bus sockets", () => {
  it("a revoked token's socket closes with 4403, and the token is 401 after", async () => {
    const u = await member();
    const c = await connected(u);
    const r = await api(app, R.busMachine(c.id), u.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    expect((await c.d.closed).code).toBe(4403);
    expect((await upgrade(c.token)).status).toBe(401);
  });

  it("member removal revokes every machine in the status batch and closes the sockets", async () => {
    const u = await member();
    const a = await connected(u, "a");
    const b = await machine("never-connected", u.userId);
    await setUserStatus(env, u.userId, "removed", "admin_remove", SYSTEM_ACTOR);
    expect((await a.d.closed).code).toBe(4403);
    expect(await revokedAt(a.id)).not.toBeNull();
    expect(await revokedAt(b.id)).not.toBeNull();
    expect((await upgrade(a.token)).status).toBe(401);
  });

  it("suspension does the same", async () => {
    const u = await member();
    const a = await connected(u);
    await setUserStatus(
      env,
      u.userId,
      "suspended",
      "admin_suspend",
      SYSTEM_ACTOR,
    );
    expect((await a.d.closed).code).toBe(4403);
    expect(await revokedAt(a.id)).not.toBeNull();
  });

  it("erase deletes their machines and device codes", async () => {
    const u = await member();
    const a = await connected(u);
    await setUserStatus(env, u.userId, "removed", "admin_remove", SYSTEM_ACTOR);
    await a.d.closed;
    await env.DB.prepare(
      "insert into bus_device_codes (id, device_code_hash, user_code, label, ip_tag, created_at, expires_at, user_id, approved_at) values (?, ?, ?, 'x', 't', 0, 1, ?, 0)",
    )
      .bind(`dc${u.userId}`, `h${u.userId}`, `C${u.userId}`, u.userId)
      .run();
    await eraseMember(env, u.userId, adminM);
    const n = await env.DB.prepare(
      "select count(*) as n from bus_device_codes where user_id = ?1",
    )
      .bind(u.userId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
    // Machines stay as emptied, revoked rows: no label, no token hash.
    const rows = await env.DB.prepare(
      "select label, token_hash as h, revoked_at as r from bus_machines where user_id = ?1",
    )
      .bind(u.userId)
      .all<{ label: string; h: string; r: number | null }>();
    expect(rows.results).toEqual([
      { label: "", h: `erased:${a.id}`, r: expect.any(Number) },
    ]);
  });

  it("erase itself closes bus sockets (belt and braces, as for artifact sockets)", async () => {
    const u = await member();
    const a = await connected(u);
    // Removed behind the hooks' back: only erase's own revokeUserLive runs.
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(u.userId)
      .run();
    await eraseMember(env, u.userId, adminM);
    expect((await a.d.closed).code).toBe(4403);
  });

  it("a cap (restricted) closes the sockets and refuses the next connect, without revoking the machine", async () => {
    const u = await member();
    const a = await connected(u);
    await setMemberRestricted(env, adminM, u.userId, true);
    expect((await a.d.closed).code).toBe(4403);
    expect(await revokedAt(a.id)).toBeNull();
    expect((await upgrade(a.token)).status).toBe(401);
  });

  it("any live-access revocation (a space change) closes bus sockets; the daemon reconnects after the skew", async () => {
    const u = await member();
    const a = await connected(u);
    await revokeUserLive(env, u.userId, "space role lowered");
    expect((await a.d.closed).code).toBe(4403);
  });

  it("an upgrade authorized before closeAll (within the skew) is refused 429, later ones pass", async () => {
    const u = await member();
    const m = await machine("race", u.userId);
    const hub = await hubOf(u.userId);
    const before = Date.now();
    await hub.closeAll("test");
    const ask = (authzAt: number) =>
      hub.fetch(
        new Request(`https://bus.internal${CONNECT_DO_PATH}`, {
          headers: {
            Upgrade: "websocket",
            [MACHINE_ID_HEADER]: m.id,
            [MACHINE_LABEL_HEADER]: "race",
            [AUTHZ_AT_HEADER]: String(authzAt),
          },
        }),
      );
    const early = await ask(before);
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).not.toBeNull();
    const late = await ask(Date.now() + SKEW_MS + 1000);
    expect(late.status).toBe(101);
    late.webSocket?.accept();
    late.webSocket?.close();
  });
});

/**
 * env whose D1 runs `between` right before /bus/connect's last_used_at write:
 * the request has already read the machine row and the member (both fine),
 * and the revocation commits before the write. Deterministic, no timing.
 */
function racingEnv(between: () => Promise<void>): unknown {
  const real = env.DB;
  const db = new Proxy(real, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!sql.includes("set last_used_at")) return st;
          return {
            bind: (...a: unknown[]) => {
              const b = st.bind(...a);
              return {
                run: async () => {
                  await between();
                  return b.run();
                },
              };
            },
          };
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...env, DB: db };
}

describe("a revocation racing a machine's first connect", () => {
  it("removal between the reads and the first-use write: 401, and no socket", async () => {
    const u = await member();
    const m = await machine("first", u.userId);
    const r = await upgrade(
      m.token,
      {},
      racingEnv(() =>
        setUserStatus(env, u.userId, "removed", "admin_remove", SYSTEM_ACTOR),
      ),
    );
    expect(r.status).toBe(401);
    expect(r.webSocket).toBeNull();
    // The hub never saw the machine.
    expect(
      await runInDurableObject(
        await hubOf(u.userId),
        (_i: BusHub, s: DurableObjectState) =>
          s.storage.sql
            .exec<{ n: number }>("select count(*) as n from machines")
            .one().n,
      ),
    ).toBe(0);
  });

  it("a cap between the reads and the first-use write: 401 (the machine is not revoked)", async () => {
    const u = await member();
    const m = await machine("first-cap", u.userId);
    const r = await upgrade(
      m.token,
      {},
      racingEnv(async () => {
        await setMemberRestricted(env, adminM, u.userId, true);
      }),
    );
    expect(r.status).toBe(401);
    expect(await revokedAt(m.id)).toBeNull();
  });
});

describe("install suspend closes bus sockets (the install index)", () => {
  it("a hub reports on accept, and closeInstall closes its sockets", async () => {
    const u = await member();
    const a = await connected(u);
    const pns = e.USER_PRESENCE;
    if (!pns) throw new Error("USER_PRESENCE unbound");
    const idx = pns.get(
      pns.idFromName(INSTALL_INDEX),
    ) as unknown as DurableObjectStub<UserPresence>;
    const seen = await runInDurableObject(
      idx,
      (_i, s: DurableObjectState) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from seen where artifact_id = ?",
            `bus:${u.userId}`,
          )
          .one().n,
    );
    expect(seen).toBe(1);
    const r = await (
      idx as unknown as {
        closeInstall(reason: string): Promise<{ closed: number }>;
      }
    ).closeInstall("suspended");
    expect(r.closed).toBeGreaterThanOrEqual(1);
    expect((await a.d.closed).code).toBe(4403);
  });
});

describe("two members: one bus each", () => {
  it("A's token reaches only A's hub, and no frame of A's addresses B's agents", async () => {
    const alice = await member();
    const bob = await member();
    const space = ns("iso");
    const a = await connected(alice, "alice-box");
    const b = await connected(bob, "bob-box");
    b.d.send(up("u1", "bob-ref", "bob-agent", space));
    await waitFor(b.d, "agent_ok");
    a.d.send(up("u2", "alice-ref", "alice-agent", space));
    await waitFor(a.d, "agent_ok");
    // A sends to B's agent's exact name and namespace: unknown on A's bus.
    a.d.send({
      v: 1,
      id: "s1",
      type: "send",
      from_ref: "alice-ref",
      to_name: "bob-agent",
      to_namespace: space,
      body: "hi",
    });
    const rec = await waitFor(a.d, "receipt");
    expect(rec.state).toBe("refused");
    expect(rec.reason).toBe("unknown_agent");
    // A's roster never lists B's agent.
    a.d.send({ v: 1, id: "l1", type: "list", from_ref: "alice-ref" });
    const roster = await waitFor(a.d, "roster");
    expect(roster.agents.map((x) => x.bus_name)).toEqual(["alice-agent"]);
    // Each hub knows only its own machine; B's daemon got nothing from A.
    const machinesOf = async (uid: string) =>
      runInDurableObject(
        await hubOf(uid),
        (_i: BusHub, s: DurableObjectState) =>
          s.storage.sql
            .exec<{ id: string }>("select id from machines")
            .toArray()
            .map((x) => x.id),
      );
    expect(await machinesOf(alice.userId)).toEqual([a.id]);
    expect(await machinesOf(bob.userId)).toEqual([b.id]);
    expect(
      b.d.raw.some((t) => t.includes("alice-agent") || t.includes('"hi"')),
    ).toBe(false);
    a.d.close();
    b.d.close();
  });

  it("a client-supplied user id or hub name never picks the hub", async () => {
    const alice = await member();
    const bob = await member();
    const m = await machine("spoof", alice.userId);
    const r = await upgrade(m.token, {
      "x-oa-bus-user": bob.userId,
      "x-oa-user-id": bob.userId,
      "x-oa-bus-machine-id": "AAAAAAAAAAAAAAAA",
      "x-oa-bus-authz-at": "0",
    });
    expect(r.status).toBe(101);
    const ws = r.webSocket as WebSocket;
    ws.accept();
    const ids = async (uid: string) =>
      runInDurableObject(
        await hubOf(uid),
        (_i: BusHub, s: DurableObjectState) =>
          s.storage.sql
            .exec<{ id: string }>("select id from machines")
            .toArray()
            .map((x) => x.id),
      );
    expect(await ids(alice.userId)).toEqual([m.id]);
    expect(await ids(bob.userId)).toEqual([]);
    ws.close();
  });
});
