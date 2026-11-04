// Ported from OpenBus v0.63.0 apps/server/test/hub.machines.test.ts (#1291).
// Dropped: createMachine, verifyToken, listMachines, token hashing, the
// machine cap, label validation, last_used throttling and the machines_list
// query plans (machines and tokens are D1 bus_machines rows now). Kept: the
// hub's machine mirror (written on first accept), revokeMachine, connected
// liveness (now snapshot().connected), the RPC surface and the schema.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  AUTHZ_AT_HEADER,
  BusHub,
  CONNECT_DO_PATH,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
  OWNER_ORG_ID,
} from "../../src/bus/hub.js";
import { HUB_SCHEMA } from "../../src/bus/schema.js";
import type { Env } from "../../src/env.js";

const e = env as unknown as Env;

type BusHubStub = DurableObjectStub<BusHub>;
const busNs = () => e.BUS_HUB as DurableObjectNamespace<BusHub>;

/** A hub of its own, so counts and ordering are not shared with other tests. */
const freshHub = (): BusHubStub => busNs().get(busNs().newUniqueId());

const inHub = <R>(h: BusHubStub, fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(h, (i: BusHub, s) => fn(i, s));

/** The Worker's forward of a verified upgrade (bus/routes.ts connect). */
const forward = (h: BusHubStub, id: string, label = "MacBook") =>
  h.fetch(`https://hub.internal${CONNECT_DO_PATH}`, {
    headers: {
      Upgrade: "websocket",
      [MACHINE_ID_HEADER]: id,
      [MACHINE_LABEL_HEADER]: label,
      [AUTHZ_AT_HEADER]: String(Date.now()),
    },
  });

/** Connects machine `id` to `h` and returns the client end. */
async function connect(
  h: BusHubStub,
  id: string,
  label = "MacBook",
): Promise<WebSocket> {
  const r = await forward(h, id, label);
  expect(r.status).toBe(101);
  const ws = r.webSocket as WebSocket;
  ws.accept();
  return ws;
}

const closedOf = (ws: WebSocket) =>
  new Promise<number>((resolve) =>
    ws.addEventListener("close", (ev) => resolve(ev.code)),
  );

const mirror = (h: BusHubStub) =>
  inHub(h, (_, s) =>
    s.storage.sql
      .exec<{
        id: string;
        org_id: string;
        label: string;
        revoked_at: number | null;
      }>("select id, org_id, label, revoked_at from machines order by rowid")
      .toArray(),
  );

/** The deliberate RPC surface. Adding a public method means adding it here. */
const RPC_ALLOWLIST = [
  "closeAll",
  "deleteRole",
  "listRoles",
  "putRole",
  "revokeMachine",
  "snapshot",
  "wipe",
];

/**
 * DurableObject handlers (B5). On the prototype, but workerd reserves these
 * names: a stub cannot call them over RPC (DurableObjectStub omits them).
 */
const DO_HANDLERS = [
  "alarm",
  "fetch",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
];

describe("hub machines", () => {
  it("writes the machine mirror on first accept, stamped with org_id, label kept current", async () => {
    const h = freshHub();
    const id = newId();
    expect(await mirror(h)).toEqual([]);
    const a = await connect(h, id, "MacBook");
    expect(await mirror(h)).toEqual([
      { id, org_id: OWNER_ORG_ID, label: "MacBook", revoked_at: null },
    ]);
    // A reconnect under a new label updates it; one row per machine.
    const aClosed = closedOf(a);
    const b = await connect(h, id, "Renamed");
    expect(await aClosed).toBe(1000);
    expect((await mirror(h)).map((r) => [r.id, r.label])).toEqual([
      [id, "Renamed"],
    ]);
    b.close(1000, "done");
  });

  it("revokeMachine: true once, false for unknown, malformed or already revoked", async () => {
    const h = freshHub();
    const id = newId();
    const ws = await connect(h, id);
    const closed = closedOf(ws);
    expect(await h.revokeMachine(id)).toBe(true);
    expect(await closed).toBe(4403);
    expect(await h.revokeMachine(id)).toBe(false);
    expect(await h.revokeMachine(newId())).toBe(false);
    expect(await h.revokeMachine("not an id")).toBe(false);
    const rows = await mirror(h);
    expect(rows[0]?.revoked_at).toEqual(expect.any(Number));
  });

  it("a revoked machine stays revoked: its forward is refused 401 and its label kept", async () => {
    const h = freshHub();
    const id = newId();
    const ws = await connect(h, id, "Old laptop");
    const closed = closedOf(ws);
    await h.revokeMachine(id);
    await closed;
    expect((await forward(h, id, "New label")).status).toBe(401);
    expect((await mirror(h)).map((r) => r.label)).toEqual(["Old laptop"]);
  });

  it("refuses a forward with a malformed id, label or authz time", async () => {
    const h = freshHub();
    const url = `https://hub.internal${CONNECT_DO_PATH}`;
    const base = {
      Upgrade: "websocket",
      [MACHINE_ID_HEADER]: newId(),
      [MACHINE_LABEL_HEADER]: "MacBook",
      [AUTHZ_AT_HEADER]: String(Date.now()),
    };
    for (const bad of [
      { [MACHINE_ID_HEADER]: "1" },
      { [MACHINE_LABEL_HEADER]: "" },
      { [MACHINE_LABEL_HEADER]: "a".repeat(129) },
      { [AUTHZ_AT_HEADER]: "soon" },
    ])
      expect(
        (await h.fetch(url, { headers: { ...base, ...bad } })).status,
      ).toBe(400);
    expect(await mirror(h)).toEqual([]);
  });

  it("reports connected from a socket tagged with the machine id, never for a revoked one", async () => {
    const h = freshHub();
    const on = newId();
    const off = newId();
    const cut = newId();
    const onWs = await connect(h, on, "On");
    const offWs = await connect(h, off, "Off");
    const cutWs = await connect(h, cut, "Cut");
    const offClosed = closedOf(offWs);
    offWs.close(1000, "bye");
    await offClosed;
    const cutClosed = closedOf(cutWs);
    await h.revokeMachine(cut);
    await cutClosed;
    expect((await h.snapshot()).connected).toEqual([on]);
    onWs.close(1000, "done");
  });

  it("keeps the test clock off the RPC surface", async () => {
    // RPC exposes the class's prototype methods; calling a missing one over the
    // stub rejects but workerd also logs it as uncaught, so check the shape.
    const rpc = Object.getOwnPropertyNames(BusHub.prototype);
    expect(rpc).not.toContain("setClock");
    expect(rpc).not.toContain("setTestClock");
    expect(typeof BusHub.setTestClock).toBe("function");
    await inHub(freshHub(), (i) => {
      expect("setClock" in i).toBe(false);
      expect("setTestClock" in i).toBe(false);
    });
  });

  it("refuses the socket handlers over RPC", async () => {
    const stub = freshHub() as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    for (const n of [
      "alarm",
      "webSocketMessage",
      "webSocketClose",
      "webSocketError",
    ])
      await expect(
        Promise.resolve().then(() => stub[n]?.(null, "x")),
        n,
      ).rejects.toThrow(/reserved method/);
  });

  it("exposes exactly the allowlisted methods over RPC (ADV-1)", async () => {
    const own = Object.getOwnPropertyNames(BusHub.prototype)
      .filter((n) => n !== "constructor" && !DO_HANDLERS.includes(n))
      .sort();
    expect(own).toEqual(RPC_ALLOWLIST);
    for (const n of DO_HANDLERS)
      expect(Object.getOwnPropertyNames(BusHub.prototype)).toContain(n);
    await inHub(freshHub(), (i) => {
      for (const n of ["all", "one", "now", "machine", "withLiveness"])
        expect(n in i).toBe(false);
    });
  });

  it("the schema is idempotent", async () => {
    const h = freshHub();
    const id = newId();
    const ws = await connect(h, id, "Keep");
    await inHub(h, (_, s) => {
      s.storage.sql.exec(HUB_SCHEMA);
      s.storage.sql.exec(HUB_SCHEMA);
      new BusHub(s, e);
    });
    expect((await mirror(h)).map((r) => r.label)).toEqual(["Keep"]);
    ws.close(1000, "done");
  });
});
