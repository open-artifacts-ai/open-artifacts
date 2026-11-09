import { describe, expect, it } from "vitest";
import { toolsFor } from "../src/tools.ts";
import { Hub, newBus } from "./support.ts";

const ctx = { agentId: "main", sessionKey: "agent:main:main" };

describe("tools", () => {
  it("offers the oabus_ tools with the MCP tools' descriptions and schemas", () => {
    const tools = toolsFor(newBus(new Hub()), ctx);
    expect(tools.map((t) => t.name)).toEqual([
      "oabus_list_agents",
      "oabus_send_message",
      "oabus_fetch",
      "oabus_self",
      "oabus_set_status",
      "oabus_follow",
      "oabus_unfollow",
      "oabus_following",
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
    toolsFor(bus, { ...ctx, sessionKey: "agent:main:telegram:direct:1" });
    await toolsFor(bus, {
      ...ctx,
      sessionKey: "agent:main:telegram:direct:1",
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

  it("refuse during a heartbeat run on the main session, and work again on the next user run", async () => {
    const hub = new Hub();
    const bus = newBus(hub);
    const c = { agentId: "main", sessionKey: "agent:main:main" };
    const self = () => toolsFor(bus, ctx).find((t) => t.name === "oabus_self");
    bus.buildPrompt({ ...c, trigger: "heartbeat", runId: "hb1" });
    await expect(self()?.execute("c", {})).rejects.toThrow(
      /only a run started by a user message/,
    );
    expect(hub.connects).toEqual([]);
    bus.buildPrompt({ ...c, trigger: "user", runId: "u1" });
    await expect(self()?.execute("c", {})).resolves.toBeDefined();
  });

  it("offers none on stock openai, which runs on the Codex runtime", () => {
    const bus = newBus(new Hub());
    expect(
      toolsFor(bus, {
        ...ctx,
        activeModel: { provider: "openai" },
        config: { models: { providers: {} } },
      }),
    ).toEqual([]);
  });

  it.each(["agent:main:telegram:group:42", "agent:main:slack:channel:C1"])(
    "offers none in %s",
    (sessionKey) => {
      expect(toolsFor(newBus(new Hub()), { ...ctx, sessionKey })).toEqual([]);
    },
  );
});
