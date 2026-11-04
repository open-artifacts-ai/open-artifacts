// Ported from OpenBus v0.63.0 apps/server/test/hub.from_ref.test.ts (#1291).
// Dropped: the AGENT_CARD_MIN_CLIENT gate (card_request is now an unknown frame, still bad_frame).
// Review Focus 1: a socket may act only for agents it registered itself.
import type { ClientFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  framesSeen,
  hello,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

const MSG = "aaaaaaaaaaaaaaaa";

const send = (id: string, from_ref: string): ClientFrame => ({
  v: 1,
  id,
  type: "send",
  from_ref,
  to_name: "Mine",
  body: "spoof",
});
const list = (id: string, from_ref: string): ClientFrame => ({
  v: 1,
  id,
  type: "list",
  from_ref,
});
const fetchMail = (id: string, from_ref: string): ClientFrame => ({
  v: 1,
  id,
  type: "fetch",
  from_ref,
  msg_id: MSG,
});

describe("identity: from_ref", () => {
  for (const [what, frame] of [
    ["send", send],
    ["list", list],
    ["fetch", fetchMail],
  ] as const)
    it(`${what} with an unregistered from_ref is not_registered, no receipt, socket open`, async () => {
      const m = await machine();
      const d = await ready(m.token);
      d.send(up("u1", "ses_a", "Mine", ns()));
      await waitFor(d, "agent_ok");

      d.send(frame("x1", "ses_other"));
      const err = await waitFor(d, "error");
      expect(err).toMatchObject({ id: "x1", code: "not_registered" });

      // Still open and answering; nothing else was sent for the spoof.
      d.send(hello("h2"));
      expect((await waitFor(d, "hello_ok")).id).toBe("h2");
      const types = framesSeen(d).map((f) => f.type);
      expect(types).not.toContain("receipt");
      expect(types).not.toContain("roster");
      expect(types).not.toContain("body");
      d.close();
    });

  it("an agent of another machine is not registered on this socket", async () => {
    const owner = await machine("Owner");
    const thief = await machine("Thief");
    const a = ns();
    const o = await ready(owner.token);
    o.send(up("u1", "ses_shared", "Owner", a));
    await waitFor(o, "agent_ok");
    const t = await ready(thief.token);
    for (const f of [list("l1", "ses_shared"), send("s1", "ses_shared")]) {
      t.send(f);
      expect((await waitFor(t, "error")).code).toBe("not_registered");
    }
    o.close();
    t.close();
  });

  it("a closed agent's from_ref is not registered any more", async () => {
    const m = await machine();
    const d = await ready(m.token);
    d.send(up("u1", "ses_a", "Gone", ns()));
    await waitFor(d, "agent_ok");
    d.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "ses_a" });
    d.send(list("l1", "ses_a"));
    expect((await waitFor(d, "error")).code).toBe("not_registered");
    d.close();
  });

  it("a registered from_ref gets not_found for fetch until B8", async () => {
    const m = await machine();
    const d = await ready(m.token);
    d.send(up("u1", "ses_a", "Mine", ns()));
    await waitFor(d, "agent_ok");
    d.send(fetchMail("f1", "ses_a"));
    expect(await waitFor(d, "error")).toMatchObject({
      id: "f1",
      code: "not_found",
    });
    expect(framesSeen(d).map((f) => f.type)).not.toContain("receipt");
    d.close();
  });
});

describe("agent card frames (dropped from the port)", () => {
  // No agent cards in Open Artifacts: card_request is not a client frame, so
  // the hub answers bad_frame and keeps the socket open.
  it("status gets no reply (AC3); card_request is answered bad_frame, socket open", async () => {
    const m = await machine();
    const d = await ready(m.token);
    d.send(up("u1", "ses_a", "Mine", ns()));
    await waitFor(d, "agent_ok");
    d.send({
      v: 1,
      id: "s1",
      type: "status",
      from_ref: "ses_a",
      state: "idle",
    });
    d.ws.send(
      JSON.stringify({
        v: 1,
        id: "c1",
        type: "card_request",
        from_ref: "ses_a",
        aud: "https://oa.example.com",
        nonce: "n".repeat(16),
      }),
    );
    expect(await waitFor(d, "error")).toMatchObject({
      id: "c1",
      code: "bad_frame",
    });
    expect(framesSeen(d).filter((f) => f.id === "s1")).toEqual([]);
    d.send(hello("h2"));
    expect((await waitFor(d, "hello_ok")).id).toBe("h2");
  });
});
