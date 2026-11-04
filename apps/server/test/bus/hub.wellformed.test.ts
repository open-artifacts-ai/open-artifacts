// Ported from OpenBus v0.63.0 apps/server/test/hub.wellformed.test.ts (#1291).
// Dropped: nothing.
// Security: a lone surrogate in a free-text field must be refused at decode,
// so it can never be forwarded in `deliver` and kill the recipient's socket
// (WS_ERR_INVALID_UTF8).
import { describe, expect, it } from "vitest";
import {
  type Daemon,
  framesSeen,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

const count = (table: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ n: number }>(`select count(*) as n from ${table}`)
        .one().n,
  );

describe("hub: non-well-formed Unicode", () => {
  it("refuses a lone-surrogate body with bad_frame; recipient unaffected", async () => {
    const sm = await machine("Sender");
    const tm = await machine("Target");
    const s: Daemon = await ready(sm.token);
    const t: Daemon = await ready(tm.token);
    const n = ns();
    s.send(up("u1", "sref", "WfSender", n));
    await waitFor(s, "agent_ok");
    t.send(up("u2", "rref", "WfReceiver", n));
    await waitFor(t, "agent_ok");

    const receiptsBefore = await count("receipts");
    const mailBefore = await count("mail");
    // Raw JSON text: the surrogate is a `\ud800` escape, as in the probe.
    s.ws.send(
      '{"v":1,"id":"bad1","type":"send","from_ref":"sref","to_name":"WfReceiver","body":"x\\ud800y"}',
    );
    const err = await waitFor(s, "error");
    expect(err).toMatchObject({ id: "bad1", code: "bad_frame" });
    expect(framesSeen(s).some((f) => f.type === "receipt")).toBe(false);

    // The recipient got nothing and its socket is alive and still delivering.
    s.send({
      v: 1,
      id: "ok1",
      type: "send",
      from_ref: "sref",
      to_name: "WfReceiver",
      body: "still fine \u{1F600}",
    });
    const receipt = await waitFor(s, "receipt");
    expect(receipt).toMatchObject({ id: "ok1", state: "pending" });
    const deliver = await waitFor(t, "deliver");
    expect(deliver.body).toBe("still fine \u{1F600}");
    expect(t.ws.readyState).toBe(WebSocket.OPEN);
    expect(framesSeen(t).filter((f) => f.type === "deliver")).toHaveLength(1);

    // Only the good message left a receipt; nothing was stored for the bad one.
    expect(await count("receipts")).toBe(receiptsBefore + 1);
    expect(await count("mail")).toBe(mailBefore);
    s.close();
    t.close();
  });
});
