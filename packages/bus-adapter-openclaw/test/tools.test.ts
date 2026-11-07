import { describe, expect, it } from "vitest";
import { toolsFor } from "../src/tools.ts";
import { Hub, newBus } from "./support.ts";

const ctx = { agentId: "main", sessionKey: "agent:main:main" };

describe("tools", () => {
  it("offers the five oabus_ tools with the MCP tools' descriptions and schemas", () => {
    const tools = toolsFor(newBus(new Hub()), ctx);
    expect(tools.map((t) => t.name)).toEqual([
      "oabus_list_agents",
      "oabus_send_message",
      "oabus_fetch",
      "oabus_self",
      "oabus_set_status",
    ]);
    const send = tools.find((t) => t.name === "oabus_send_message");
    expect(send?.description).toBe("Send a message to another agent by name.");
    expect(send?.parameters).toMatchObject({ required: ["to", "text"] });
  });

  it.each([
    ["a subagent", { sessionKey: "agent:main:subagent:x" }],
    ["an ACP session", { sessionKey: "agent:main:acp:x" }],
    ["no key", { sessionKey: undefined }],
    ["claude-cli", { activeModel: { provider: "claude-cli" } }],
  ])("offers none to %s", (_n, over) => {
    expect(toolsFor(newBus(new Hub()), { ...ctx, ...over })).toEqual([]);
  });

  it("connects on first use, per root, and runs a call on that link", async () => {
    const hub = new Hub();
    const bus = newBus(hub);
    const tools = toolsFor(bus, ctx);
    expect(hub.connects).toEqual([]);
    const list = tools.find((t) => t.name === "oabus_list_agents");
    const r = await list?.execute("c1", {});
    expect(r?.content[0]?.text).toContain("peer");
    await tools.find((t) => t.name === "oabus_self")?.execute("c2", {});
    expect(hub.connects).toHaveLength(1);
    toolsFor(bus, { ...ctx, sessionKey: "agent:main:telegram:dm:1" });
    await toolsFor(bus, {
      ...ctx,
      sessionKey: "agent:main:telegram:dm:1",
    })[0]?.execute("c3", {});
    expect(hub.connects).toHaveLength(2);
  });

  it("fails a call as an error, with the adapter's copy", async () => {
    const hub = new Hub();
    const bus = newBus(hub);
    const send = toolsFor(bus, ctx).find(
      (t) => t.name === "oabus_send_message",
    );
    await expect(send?.execute("c", { to: "", text: "" })).rejects.toThrow(
      "oa-bus: to and text are required",
    );
  });

  it("fails when the daemon is down, saying so", async () => {
    const hub = new Hub();
    hub.down = true;
    const tools = toolsFor(newBus(hub), ctx);
    await expect(tools[0]?.execute("c", {})).rejects.toThrow(
      /^oa-bus: .*not reachable/,
    );
  });

  it("refuses with a clear message once the root is marked as reporting no model calls", async () => {
    const hub = new Hub();
    const bus = newBus(hub);
    const c = {
      agentId: "main",
      sessionKey: "agent:main:main",
      trigger: "user",
    };
    bus.buildPrompt({ ...c, runId: "w" });
    await new Promise((r) => setTimeout(r, 5));
    hub.push({ id: "m1" });
    await new Promise((r) => setTimeout(r, 5));
    bus.buildPrompt({ ...c, runId: "r1" });
    bus.buildPrompt({ ...c, runId: "r2" });
    const self = toolsFor(bus, ctx).find((t) => t.name === "oabus_self");
    await expect(self?.execute("c", {})).rejects.toThrow(
      /does not report model calls/,
    );
  });
});
