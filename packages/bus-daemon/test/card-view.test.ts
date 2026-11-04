// AC5c: the self tool's role and status, and `oa-bus status` rows, from the hub roster.
import { connect } from "node:net";
import { daemonStatus, LineDecoder } from "@oa/bus-ipc";
import { AGENT_CARD_MIN_CLIENT } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const GATE = AGENT_CARD_MIN_CLIENT;
const AT = "2026-10-29T12:00:00.000Z";

/**
 * A daemon at the gate whose hub has said hello_ok and answers `list` with
 * `name` holding lane-6 (unless `silent`).
 */
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
          role: "lane-7",
        },
        {
          bus_name: name,
          kind: "claude-code",
          namespace: "ns",
          global: false,
          state: "live",
          role: "lane-6",
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

describe("self with card (AC5c)", () => {
  it("at the gate: the agent's own row's role and status, from one hub list", async () => {
    const h = await bus("A");
    const a = await h.adapter("A", { client_version: GATE });
    const before = h.of("list").length;
    const r = await a.request({ type: "self", card: true });
    expect(r).toMatchObject({
      type: "agent",
      agent: {
        name: "A",
        namespace: "ns",
        role: "lane-6",
        status: "working",
        status_label: "writing tests",
        status_at: AT,
      },
      daemon_version: GATE,
    });
    expect(h.of("list").slice(before)).toEqual([
      expect.objectContaining({ from_ref: "A" }),
    ]);
  });

  it("without card: no hub round trip and no card fields", async () => {
    const h = await bus("A");
    const a = await h.adapter("A", { client_version: GATE });
    const before = h.of("list").length;
    const r = await a.request({ type: "self" });
    expect(r.type === "agent" && r.agent).not.toHaveProperty("role");
    await new Promise((res) => setTimeout(res, 50));
    expect(h.of("list").length).toBe(before);
  });

  it("below the gate: no hub round trip and nothing new", async () => {
    const h = await bus("A");
    const a = await h.adapter("A", { client_version: "0.53.0" });
    const before = h.of("list").length;
    const r = await a.request({ type: "self", card: true });
    expect(r.type === "agent" && r.agent).not.toHaveProperty("role");
    expect(r.type === "agent" && r.agent).not.toHaveProperty("status");
    await new Promise((res) => setTimeout(res, 50));
    expect(h.of("list").length).toBe(before);
  });

  it("a hub that does not answer: the entry alone, once the roster wait ends", async () => {
    const h = await bus("A", true);
    const a = await h.adapter("A", { client_version: GATE });
    const r = await a.request({ type: "self", card: true });
    expect(r).toMatchObject({ type: "agent", agent: { name: "A" } });
    expect(r.type === "agent" && r.agent).not.toHaveProperty("role");
  });

  it("a hub below the gate is not asked", async () => {
    const h = await bus("A", false, "0.50.0");
    const a = await h.adapter("A", { client_version: GATE });
    const before = h.of("list").length;
    const r = await a.request({ type: "self", card: true });
    expect(r.type === "agent" && r.agent).not.toHaveProperty("role");
    expect(h.of("list").length).toBe(before);
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

describe("status rows (AC5c)", () => {
  const rowsOf = (st: unknown) =>
    (st as { namespaces: { agents: object[] }[] }).namespaces[0]?.agents;

  it("at the gate, carry the role and status", async () => {
    const h = await bus("A");
    await h.adapter("A", { client_version: GATE });
    expect(rowsOf(await status(h.socketPath, GATE))).toEqual([
      expect.objectContaining({ name: "other", role: "lane-7" }),
      expect.objectContaining({
        name: "A",
        role: "lane-6",
        status: "working",
        status_label: "writing tests",
        status_at: AT,
      }),
    ]);
  });

  it("below the gate, carry none of them", async () => {
    const h = await bus("A");
    await h.adapter("A", { client_version: GATE });
    for (const row of rowsOf(await status(h.socketPath, "0.53.0")) ?? []) {
      expect(row).not.toHaveProperty("role");
      expect(row).not.toHaveProperty("status");
      expect(row).not.toHaveProperty("status_label");
      expect(row).not.toHaveProperty("status_at");
    }
    expect(rowsOf(await status(h.socketPath, "0.53.0"))).toHaveLength(2);
  });
});
