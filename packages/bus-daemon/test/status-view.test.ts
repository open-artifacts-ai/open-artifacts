// The self tool's status, and `oa-bus status` rows, from the hub roster.
import { connect } from "node:net";
import { daemonStatus, LineDecoder } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

/** Any version: nothing gates on it. */
const GATE = "0.106.0";
const AT = "2026-10-29T12:00:00.000Z";

/** A daemon whose hub has said hello_ok and answers `list` (unless `silent`). */
async function bus(name: string, silent = false, server_version = GATE) {
  const h = await daemonHarness({ version: GATE, statusRosterMs: 300 });
  h.hubSock()?.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type !== "list" || silent) return;
    h.toDaemon({
      id: f.id,
      type: "roster",
      agents: [
        {
          bus_name: "other",
          kind: "pi",
          namespace: "ns",
          global: false,
          state: "live",
        },
        {
          bus_name: name,
          kind: "claude-code",
          namespace: "ns",
          global: false,
          state: "live",
          status: "working",
          status_label: "writing tests",
          status_at: AT,
        },
      ],
    });
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version,
  });
  await vi.waitFor(async () =>
    expect(
      (await daemonStatus({ path: h.socketPath, timeoutMs: 3000 })).hub_version,
    ).toBe(server_version),
  );
  return h;
}

describe("self with row", () => {
  it("the agent's own row's status, from one hub list", async () => {
    const h = await bus("A");
    const a = await h.adapter("A", { client_version: GATE });
    const before = h.of("list").length;
    const r = await a.request({ type: "self", row: true });
    expect(r).toMatchObject({
      type: "agent",
      agent: {
        name: "A",
        namespace: "ns",
        status: "working",
        status_label: "writing tests",
        status_at: AT,
      },
    });
    expect(h.of("list").slice(before)).toEqual([
      expect.objectContaining({ from_ref: "A" }),
    ]);
  });

  it("without row: no hub round trip and no status", async () => {
    const h = await bus("A");
    const a = await h.adapter("A", { client_version: GATE });
    const before = h.of("list").length;
    const r = await a.request({ type: "self" });
    expect(r.type === "agent" && r.agent).not.toHaveProperty("status");
    await new Promise((res) => setTimeout(res, 50));
    expect(h.of("list").length).toBe(before);
  });

  it("a hub that does not answer: the entry alone, once the roster wait ends", async () => {
    const h = await bus("A", true);
    const a = await h.adapter("A", { client_version: GATE });
    const r = await a.request({ type: "self", row: true });
    expect(r).toMatchObject({ type: "agent", agent: { name: "A" } });
    expect(r.type === "agent" && r.agent).not.toHaveProperty("status");
  });

});

/** A raw status request with `marker`, as `oa-bus status` sends it. */
function status(path: string, marker: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const decoder = new LineDecoder();
    sock.once("error", reject);
    sock.once("connect", () =>
      sock.write(
        `${JSON.stringify({ v: 1, id: "st", type: "status", client_version: marker })}\n`,
      ),
    );
    sock.on("data", (chunk) => {
      const [f] = decoder.push(chunk);
      if (f) {
        sock.destroy();
        resolve(f);
      }
    });
  });
}

describe("status rows", () => {
  const rowsOf = (st: unknown) =>
    (st as { namespaces: { agents: object[] }[] }).namespaces[0]?.agents;

  it("carry the status", async () => {
    const h = await bus("A");
    await h.adapter("A", { client_version: GATE });
    expect(rowsOf(await status(h.socketPath, GATE))).toEqual([
      expect.objectContaining({ name: "other" }),
      expect.objectContaining({
        name: "A",
        status: "working",
        status_label: "writing tests",
        status_at: AT,
      }),
    ]);
  });
});
