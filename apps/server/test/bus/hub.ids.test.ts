// Reply ids (BUS_CAPS.ids, the #1323 follow-up): `deliver.from_id` names the
// sender's agent; a reply's `send.to_id` reaches only that agent, never
// whoever holds the name now (`agent_gone`). Gated like the rename wire: only
// a socket whose hello listed the cap sees `from_id`, `agent_gone` or
// `hello_ok.caps`.
import { BUS_CAPS, type ServerFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { type Daemon, daemon, machine, ns, waitFor } from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
type Deliver = Extract<ServerFrame, { type: "deliver" }>;
type Receipt = Extract<ServerFrame, { type: "receipt" }>;

async function at(caps: string[] | undefined): Promise<{
  d: Daemon;
  hello: Extract<ServerFrame, { type: "hello_ok" }>;
}> {
  const m = await machine("MacBook");
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
    ...(caps === undefined ? {} : { caps }),
  });
  return { d, hello: await waitFor(d, "hello_ok") };
}

async function reg(d: Daemon, ref: string, name: string, namespace: string) {
  d.send({
    v: 1,
    id: id("u"),
    type: "agent_up",
    agent_ref: ref,
    kind: "opencode",
    proposed_name: name,
    namespace,
    global: false,
  });
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function send(
  d: Daemon,
  from_ref: string,
  to_name: string,
  to_id?: string,
): Promise<Receipt> {
  const fid = id("s");
  d.send({
    v: 1,
    id: fid,
    type: "send",
    from_ref,
    to_name,
    ...(to_id === undefined ? {} : { to_id }),
    body: "hi",
  });
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

describe("reply ids (BUS_CAPS.ids)", () => {
  it("hello_ok lists the hub's caps only to a hello that listed caps", async () => {
    const withCaps = await at([BUS_CAPS.ids]);
    expect(withCaps.hello.caps).toEqual(
      expect.arrayContaining([BUS_CAPS.rename, BUS_CAPS.ids]),
    );
    const old = await at(undefined);
    expect(old.hello).not.toHaveProperty("caps");
  });

  it("deliver names the sender's id to an ids socket; a reply with it is delivered", async () => {
    const n = ns("ids");
    const a = await at([BUS_CAPS.ids]);
    const b = await at([BUS_CAPS.ids]);
    const alice = await reg(a.d, "ra", "alice", n);
    const bob = await reg(b.d, "rb", "bob", n);
    expect((await send(a.d, "ra", bob)).state).toBe("pending");
    const got = (await waitFor(b.d, "deliver")) as Deliver;
    expect(got.from_id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{16}$/);
    // Bob answers alice, naming the agent that wrote.
    expect((await send(b.d, "rb", alice, got.from_id)).state).toBe("pending");
    expect(((await waitFor(a.d, "deliver")) as Deliver).from_name).toBe(bob);
  });

  it("a reply whose name now belongs to another agent is refused agent_gone", async () => {
    const n = ns("ids");
    const a = await at([BUS_CAPS.ids]);
    const b = await at([BUS_CAPS.ids]);
    await reg(a.d, "ra", "alice", n);
    const bob = await reg(b.d, "rb", "bob", n);
    await send(a.d, "ra", bob);
    const got = (await waitFor(b.d, "deliver")) as Deliver;
    // Another agent: same name, a different id (here, bob's own).
    const r = await send(b.d, "rb", "alice", (await bobsId(b, a)) ?? "");
    expect(r).toMatchObject({ state: "refused", reason: "agent_gone" });
    expect(got.from_id).toBeDefined();
  });

  it("a reply to a name no agent holds is refused agent_gone", async () => {
    const n = ns("ids");
    const b = await at([BUS_CAPS.ids]);
    await reg(b.d, "rb", "bob", n);
    const r = await send(b.d, "rb", "nobody-here", "7Yb3kQmZ1xRt9PvA");
    expect(r).toMatchObject({ state: "refused", reason: "agent_gone" });
  });

  it("an old-hello socket never sees from_id or agent_gone", async () => {
    const n = ns("ids");
    const a = await at([BUS_CAPS.ids]);
    const b = await at(undefined);
    const alice = await reg(a.d, "ra", "alice", n);
    const bob = await reg(b.d, "rb", "bob", n);
    await send(a.d, "ra", bob);
    const got = (await waitFor(b.d, "deliver")) as Deliver;
    expect(got).not.toHaveProperty("from_id");
    // On the wire too: the raw frame has exactly the old deliver's keys.
    const raw = b.d.raw
      .map((t) => {
        try {
          return JSON.parse(t) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .find((f) => f.type === "deliver");
    expect(Object.keys(raw ?? {}).sort()).toEqual(
      [
        "v",
        "id",
        "type",
        "msg_id",
        "to_ref",
        "from_name",
        "namespace",
        "body",
      ].sort(),
    );
    expect(b.hello).not.toHaveProperty("caps");
    // An old client never sends to_id; if one did, it reads unknown_agent.
    const r = await send(b.d, "rb", alice, "7Yb3kQmZ1xRt9PvA");
    expect(r).toMatchObject({ state: "refused", reason: "unknown_agent" });
  });
});

/** bob's own agent id, learned the way a client learns one: from a deliver. */
async function bobsId(
  b: { d: Daemon },
  a: { d: Daemon },
): Promise<string | undefined> {
  await send(b.d, "rb", "alice");
  return ((await waitFor(a.d, "deliver")) as Deliver).from_id;
}
