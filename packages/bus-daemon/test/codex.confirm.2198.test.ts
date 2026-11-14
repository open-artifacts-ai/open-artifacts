// #2198 end to end: a real daemon against a stub hub that lists ack_confirm.
// A taken Codex record is acked; the hub's `acked` confirms it for good;
// without it, the next link sends the ack again.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

afterEach(stopAll);

const ID = "mmmmmmmmmmmmmmm1";
const WAIT = { timeout: 15_000, interval: 10 };

/** A daemon whose record file already holds a taken, unacked item. */
async function world() {
  const takenFile = join(mkdtempSync(join(tmpdir(), "ob-ct-")), "p.json");
  writeFileSync(
    takenFile,
    JSON.stringify({
      [ID]: {
        state: "taken",
        thread: "019a0000-0000-7000-8000-000000000001",
        at: Date.now(),
        head: "[oa-bus] from peer",
      },
    }),
  );
  const h = await daemonHarness({
    codex: { takenFile } as never,
    // A sync pass soon after start, so the first-scan ack is not waited for 2 s.
    ...({ claude: undefined } as object),
  });
  const acks = () => h.of("ack").filter((f) => f.msg_id === ID);
  const record = () => JSON.parse(readFileSync(takenFile, "utf8"))[ID];
  /** The hub says hello_ok with the cap, then drops a sentinel the daemon answers: its frames before it are handled. */
  const helloOk = async (caps: string[]) => {
    h.toDaemon({
      id: "h0",
      type: "hello_ok",
      machine_id: "mmmmmmmmmmmmmmmm",
      machine_label: "laptop",
      server_version: "0.0.0",
      caps,
    });
    const n = h.of("refuse").length;
    h.toDaemon(deliverFrame(`nnnnnnnnnnnnnnn${n + 1}`, "nobody"));
    await vi.waitFor(() => expect(h.of("refuse").length).toBe(n + 1), WAIT);
  };
  /** Drops the link and waits for the daemon's next one. */
  const reconnect = async () => {
    const before = h.upgrades.length;
    h.hubSock()?.close();
    await vi.waitFor(() => expect(h.upgrades.length).toBe(before + 1), WAIT);
    await vi.waitFor(
      () => expect(h.of("hello").length).toBeGreaterThan(1),
      WAIT,
    );
  };
  return { h, acks, record, helloOk, reconnect };
}

vi.setConfig({ testTimeout: 30_000 });

describe("a taken Codex record and the hub's confirmation (#2198)", () => {
  it("confirmed by `acked`: saved, and not sent again after a reconnect", async () => {
    const { h, acks, record, helloOk, reconnect } = await world();
    await helloOk([BUS_CAPS.ackConfirm]);
    await vi.waitFor(
      () => expect(acks().length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    expect(record().confirmed).toBeUndefined();
    h.toDaemon({ id: acks()[0]?.id, type: "acked", msg_id: ID });
    await vi.waitFor(() => expect(record().confirmed).toBe(true), WAIT);
    const sent = acks().length;
    await reconnect();
    await helloOk([BUS_CAPS.ackConfirm]);
    expect(acks()).toHaveLength(sent);
  });

  it("an `acked` that echoes no ack of this link, or a wrong msg_id, confirms nothing", async () => {
    const { h, acks, record, helloOk } = await world();
    await helloOk([BUS_CAPS.ackConfirm]);
    await vi.waitFor(
      () => expect(acks().length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    h.toDaemon({ id: "unknownframeid01", type: "acked", msg_id: ID });
    h.toDaemon({
      id: acks()[0]?.id,
      type: "acked",
      msg_id: "nnnnnnnnnnnnnnnn",
    });
    await helloOk([BUS_CAPS.ackConfirm]); // both handled before this sentinel
    await stopAll(); // flushes the coalesced record write (#2332)
    expect(record().confirmed).toBeUndefined();
  });

  it("not confirmed: the next link sends the ack again", async () => {
    const { acks, record, helloOk, reconnect } = await world();
    await helloOk([BUS_CAPS.ackConfirm]);
    await vi.waitFor(
      () => expect(acks().length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const sent = acks().length;
    await reconnect();
    await helloOk([BUS_CAPS.ackConfirm]);
    await vi.waitFor(() => expect(acks().length).toBeGreaterThan(sent), WAIT);
    await stopAll(); // flushes the coalesced record write (#2332)
    expect(record().confirmed).toBeUndefined();
  });

  it("a hub without the cap: no replay on the next link", async () => {
    const { h, acks, record, helloOk, reconnect } = await world();
    await helloOk([]);
    await vi.waitFor(
      () => expect(acks().length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    // Even an `acked` that echoes the ack is ignored without the cap.
    h.toDaemon({ id: acks()[0]?.id, type: "acked", msg_id: ID });
    await helloOk([]);
    const sent = acks().length;
    await reconnect();
    await helloOk([]);
    expect(acks()).toHaveLength(sent);
    // The record file is written coalesced (250 ms): stopping the daemon
    // flushes it, so a wrongly confirmed record cannot still be pending (#2332).
    await stopAll();
    expect(record().confirmed).toBeUndefined();
  });
});
