// #2478: a member's hub records the first time one of their agents is named
// (a chosen name or a role) for the checklist; a default re-mint does not.
import { env } from "cloudflare:workers";
import { decodeServerFrame, encodeFrame, newId } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  AUTHZ_AT_HEADER,
  type BusHub,
  CONNECT_DO_PATH,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
  OWNER_ORG_ID,
} from "../../src/bus/hub.js";
import { namedKey } from "../../src/services/onboarding-firsts.js";
import { login } from "../helpers.js";
import { e, trackSocket } from "./helpers.js";

const stored = (userId: string) =>
  env.DB.prepare("select value from settings where key = ?1")
    .bind(namedKey(userId))
    .first<{ value: string }>();

async function connect(userId: string) {
  const ns = e.BUS_HUB as DurableObjectNamespace<BusHub>;
  const h = ns.getByName(`bus:${userId}`);
  const mid = newId();
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(h, (_i: BusHub, s) => {
    s.storage.sql.exec(
      "insert into machines (id, org_id, label, created_at) values (?, ?, 'Mac', ?)",
      mid,
      OWNER_ORG_ID,
      Date.now(),
    );
  });
  const res = await h.fetch(`https://hub.internal${CONNECT_DO_PATH}`, {
    headers: {
      Upgrade: "websocket",
      [MACHINE_ID_HEADER]: mid,
      [MACHINE_LABEL_HEADER]: "Mac",
      [AUTHZ_AT_HEADER]: String(Date.now()),
    },
  });
  const ws = res.webSocket as WebSocket;
  ws.accept();
  trackSocket(ws);
  const seen: string[] = [];
  ws.addEventListener("message", (ev) => {
    const r = decodeServerFrame(String(ev.data));
    if (r.ok) seen.push(r.frame.type);
  });
  return {
    send: (f: Parameters<typeof encodeFrame>[0]) => ws.send(encodeFrame(f)),
    seen,
  };
}
const until = async (fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await fn()); i++)
    await new Promise((r) => setTimeout(r, 20));
};

describe("the hub records a named agent (#2478)", () => {
  it("an agent_up with name_chosen records the owner's first time, once", async () => {
    const o = await login(`hub-own-${newId().slice(0, 6)}@x.com`, "owner");
    const c = await connect(o.userId);
    c.send({
      v: 1,
      id: "u0",
      type: "agent_up",
      agent_ref: "ref_a",
      kind: "pi",
      proposed_name: "pi-2",
      namespace: "ns",
      global: false,
    });
    await until(() => c.seen.includes("agent_ok"));
    expect(await stored(o.userId)).toBeNull();
    c.send({
      v: 1,
      id: "u1",
      type: "agent_up",
      agent_ref: "ref_b",
      kind: "pi",
      proposed_name: "pi-3",
      namespace: "ns",
      global: false,
      name_chosen: true,
    });
    await until(async () => (await stored(o.userId)) !== null);
    const first = await stored(o.userId);
    expect(Number(first?.value)).toBeGreaterThan(0);
    c.send({
      v: 1,
      id: "r1",
      type: "rename",
      agent_ref: "ref_a",
      proposed_name: "Atlas",
    });
    await until(() => c.seen.includes("renamed"));
    await new Promise((r) => setTimeout(r, 50));
    expect((await stored(o.userId))?.value).toBe(first?.value);
  });

  it("a plain rename records it; a default re-mint does not", async () => {
    const o = await login(`hub-own-${newId().slice(0, 6)}@x.com`, "owner");
    const c = await connect(o.userId);
    c.send({
      v: 1,
      id: "u0",
      type: "agent_up",
      agent_ref: "ref_a",
      kind: "pi",
      proposed_name: "pi-2",
      namespace: "ns",
      global: false,
    });
    await until(() => c.seen.includes("agent_ok"));
    c.send({
      v: 1,
      id: "r0",
      type: "rename",
      agent_ref: "ref_a",
      proposed_name: "pi-9",
      name_kind: "default",
    });
    await until(() => c.seen.includes("renamed"));
    await new Promise((r) => setTimeout(r, 50));
    expect(await stored(o.userId)).toBeNull();
    c.send({
      v: 1,
      id: "r1",
      type: "rename",
      agent_ref: "ref_a",
      proposed_name: "Atlas",
    });
    await until(async () => (await stored(o.userId)) !== null);
    expect(await stored(o.userId)).not.toBeNull();
  });

  it("a re-derived title (name_chosen false) does not record it", async () => {
    const o = await login(`hub-own-${newId().slice(0, 6)}@x.com`, "owner");
    const c = await connect(o.userId);
    c.send({
      v: 1,
      id: "u0",
      type: "agent_up",
      agent_ref: "ref_a",
      kind: "pi",
      proposed_name: "pi-2",
      namespace: "ns",
      global: false,
    });
    await until(() => c.seen.includes("agent_ok"));
    c.send({
      v: 1,
      id: "r0",
      type: "rename",
      agent_ref: "ref_a",
      proposed_name: "Fix the login bug",
      name_chosen: false,
    });
    await until(() => c.seen.includes("renamed"));
    await new Promise((r) => setTimeout(r, 50));
    expect(await stored(o.userId)).toBeNull();
  });

  it("after the first record the hub makes no more settings writes", async () => {
    const o = await login(`hub-own-${newId().slice(0, 6)}@x.com`, "owner");
    const c = await connect(o.userId);
    const up = (ref: string, id: string) =>
      c.send({
        v: 1,
        id,
        type: "agent_up",
        agent_ref: ref,
        kind: "pi",
        proposed_name: `pi-${id}`,
        namespace: "ns",
        global: false,
        name_chosen: true,
      });
    up("ref_a", "1");
    await until(async () => (await stored(o.userId)) !== null);
    const first = await stored(o.userId);
    // Remove the row: a hub that still asked D1 would write it again.
    await env.DB.prepare("delete from settings where key = ?1")
      .bind(namedKey(o.userId))
      .run();
    await new Promise((r) => setTimeout(r, 50));
    up("ref_b", "2");
    await until(() => c.seen.filter((t) => t === "agent_ok").length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(await stored(o.userId)).toBeNull();
    expect(first).not.toBeNull();
  });
});
