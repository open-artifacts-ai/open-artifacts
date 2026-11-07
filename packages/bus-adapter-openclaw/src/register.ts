import type { PluginApi } from "./api.ts";
import type { Bus } from "./bus.ts";
import { TOOL_NAMES, toolsFor } from "./tools.ts";

/**
 * Wires the tools and hooks onto one registration. OpenClaw runs register()
 * several times per process (the spike saw it three times, in different
 * modes), so this does nothing but register: no link, timer or file. The Bus
 * it points at is the process's one, and connects on first use.
 */
export function registerBus(api: PluginApi, bus: Bus): void {
  api.registerTool((ctx) => toolsFor(bus, ctx), { names: TOOL_NAMES });
  api.on("before_prompt_build", (_ev, ctx) => bus.promptBuild(ctx));
  api.on("model_call_ended", (ev, ctx) => {
    bus.modelCallEnded(
      { ...ctx, sessionKey: ev.sessionKey ?? ctx.sessionKey },
      { runId: ev.runId ?? ctx.runId, outcome: ev.outcome },
    );
  });
}
