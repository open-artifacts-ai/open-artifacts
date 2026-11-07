import { describe, expect, it, vi } from "vitest";
import type { PluginApi } from "../src/api.ts";
import { registerBus } from "../src/register.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { caller, flush, Hub, newBus } from "./support.ts";

type Handler = (
  ev: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown;

/** An API like OpenClaw's: it records what register() asked for. */
function fakeApi(mode = "full") {
  const hooks: Record<string, Handler[]> = {};
  const tools: {
    factory: (ctx: Record<string, unknown>) => unknown;
    names?: string[];
  }[] = [];
  const api = {
    registrationMode: mode,
    registerTool: (factory: never, opts?: { names?: string[] }) =>
      tools.push({ factory, names: opts?.names }),
    on: (h: string, fn: Handler) => {
      hooks[h] = [...(hooks[h] ?? []), fn];
    },
  } as unknown as PluginApi;
  return { api, hooks, tools };
}

describe("register", () => {
  it("has no side effects: no link, and no work beyond registering", async () => {
    const hub = new Hub();
    const bus = newBus(hub);
    const a = fakeApi();
    registerBus(a.api, bus);
    await flush();
    expect(hub.connects).toEqual([]);
    expect(Object.keys(a.hooks).sort()).toEqual([
      "before_prompt_build",
      "model_call_ended",
    ]);
    expect(a.tools).toHaveLength(1);
    expect(a.tools[0]?.names).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toEqual([
      "oabus_list_agents",
      "oabus_send_message",
      "oabus_fetch",
      "oabus_self",
      "oabus_set_status",
    ]);
  });

  it("keeps one link, one queue and one ack when register runs again and again", async () => {
    const hub = new Hub();
    const bus = newBus(hub); // the process's one Bus
    const regs = ["full", "full", "tool-discovery"].map((m) => fakeApi(m));
    for (const r of regs) registerBus(r.api, bus);

    const ctx = { ...caller(), runId: "r1" };
    const fire = (name: string, ev: Record<string, unknown>) =>
      regs.flatMap((r) => r.hooks[name]?.map((h) => h(ev, ctx)));

    // Every registration's hook fires, as if OpenClaw ran them all.
    await Promise.all(fire("before_prompt_build", { prompt: "hi" }));
    await flush();
    expect(hub.connects).toHaveLength(1);
    hub.push({ id: "m1" });
    await flush();
    const results = (await Promise.all(
      fire("before_prompt_build", { prompt: "hi" }),
    )) as { prependContext?: string }[];
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.prependContext)).size).toBe(1);
    expect(results[0]?.prependContext).toContain("body of m1");
    fire("model_call_ended", {
      runId: "r1",
      sessionKey: ctx.sessionKey,
      outcome: "completed",
    });
    expect(hub.acks).toEqual(["m1"]);
    expect(hub.connects).toHaveLength(1);
  });

  it("reads the session key from the model_call_ended event when the context lacks it", async () => {
    const hub = new Hub();
    const bus = newBus(hub);
    const a = fakeApi();
    registerBus(a.api, bus);
    const ctx = caller();
    await a.hooks.before_prompt_build?.[0]?.({}, ctx);
    await flush();
    hub.push({ id: "m1" });
    await flush();
    await a.hooks.before_prompt_build?.[0]?.({}, ctx);
    a.hooks.model_call_ended?.[0]?.(
      { runId: "run-1", sessionKey: "agent:main:main", outcome: "completed" },
      { agentId: "main" },
    );
    expect(hub.acks).toEqual(["m1"]);
  });

  it("shares one Bus per process, across module loads", async () => {
    const { processBus } = await import("../src/singleton.ts");
    const first = processBus();
    vi.resetModules();
    const again = await import("../src/singleton.ts");
    expect(again.processBus()).toBe(first);
  });
});
