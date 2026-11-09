// #1856 (part of #1822): per-session proof for OpenClaw. Each root makes a
// random proof when its link opens or reconnects, tells the daemon its hash on
// that link, and our before_tool_call hook adds it to calls to this instance's
// open-artifacts MCP tools only. Any failure leaves the root unlinked with
// every tool working. Waits are signals (a promise), never sleeps.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginApi } from "../src/api.ts";
import { registerBus } from "../src/register.ts";
import { toolsFor } from "../src/tools.ts";
import { caller, flush, Hub, newBus, online } from "./support.ts";

type Handler = (
  ev: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown;

const ARG = "_oa_agent_proof";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function setup(over: Parameters<typeof newBus>[1] = {}, hub: Hub = new Hub()) {
  const bus = newBus(hub, over);
  const hooks: Record<string, Handler[]> = {};
  registerBus(
    {
      registerTool: () => {},
      on: (h: string, fn: Handler) => {
        hooks[h] = [...(hooks[h] ?? []), fn];
      },
    } as unknown as PluginApi,
    bus,
  );
  /** A before_tool_call as OpenClaw runs it: the hook's `params` merge over the call's. */
  const call = async (
    toolName: string,
    runId: string | undefined,
    params: Record<string, unknown> = { a: 1 },
    ctx: Record<string, unknown> = {},
  ) => {
    const ev = { toolName, params, ...(runId ? { runId } : {}) };
    const out = (await hooks.before_tool_call?.[0]?.(ev, {
      toolName,
      agentId: "main",
      sessionKey: "agent:main:main",
      ...(runId ? { runId } : {}),
      ...ctx,
    })) as { params?: Record<string, unknown> } | undefined;
    return { out, ev };
  };
  return { bus, hub, hooks, call };
}

/** A user run on the main session: its prompt is built (the root is mapped), then its link is open. */
async function userRun(s: ReturnType<typeof setup>, runId = "run-1") {
  await online(s.bus, caller({ runId }));
  return runId;
}

describe("proof on open and reconnect", () => {
  it("makes a proof when the link opens and sends only its hash to the daemon", async () => {
    const s = setup();
    const run = await userRun(s);
    expect(s.hub.proofs).toHaveLength(1);
    const { out } = await s.call("open-artifacts__list_artifacts", run);
    const proof = out?.params?.[ARG] as string;
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.hub.proofs[0]?.hash).toBe(sha(proof));
    expect(s.hub.proofs[0]?.hash).not.toContain(proof);
  });

  it("makes a new proof on reconnect, and the old one is gone", async () => {
    const s = setup();
    const run = await userRun(s);
    const first = (await s.call("open-artifacts__get_artifact", run)).out
      ?.params?.[ARG] as string;
    // The daemon link drops; the next prompt reopens it.
    const old = s.hub.clients[0];
    if (!old) throw new Error("no client");
    old.close();
    s.bus.buildPrompt(caller({ runId: "run-2" }));
    await flush();
    expect(s.hub.proofs).toHaveLength(2);
    const second = (await s.call("open-artifacts__get_artifact", "run-2")).out
      ?.params?.[ARG] as string;
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(s.hub.proofs[1]?.hash).toBe(sha(second));
  });

  it("sends the hash on that root's own link, one per root", async () => {
    const s = setup();
    await userRun(s);
    await online(
      s.bus,
      caller({ runId: "run-b", sessionKey: "agent:main:direct:alice" }),
    );
    expect(s.hub.proofs.map((p) => p.ref)).toHaveLength(2);
    expect(new Set(s.hub.proofs.map((p) => p.ref)).size).toBe(2);
    const a = await s.call("open-artifacts__self", "run-1");
    const b = await s.call("open-artifacts__self", "run-b");
    expect(sha(a.out?.params?.[ARG] as string)).toBe(s.hub.proofs[0]?.hash);
    expect(sha(b.out?.params?.[ARG] as string)).toBe(s.hub.proofs[1]?.hash);
  });
});

describe("which tools get it", () => {
  it("only this instance's open-artifacts tools; never a look-alike server", async () => {
    const s = setup();
    const run = await userRun(s);
    for (const name of [
      "open-artifacts__publish_artifact",
      "open-artifacts__get_artifact",
    ])
      expect((await s.call(name, run)).out?.params).toHaveProperty(ARG);
    for (const name of [
      "other__publish_artifact",
      "open-artifacts-2__get_artifact",
      "open-artifacts2__get_artifact",
      "open_artifacts__get_artifact",
      "Open-Artifacts__get_artifact",
      "xopen-artifacts__get_artifact",
      "other__open-artifacts__x",
      "open-artifacts",
      "open-artifacts__resources_list",
      "open-artifacts__prompts_get",
      "oabus_send_message",
      "exec",
    ])
      expect((await s.call(name, run)).out, name).toBeUndefined();
  });

  it("also the instance's own server name when it is set", async () => {
    const s = setup({ mcpServers: () => ["open-artifacts", "oa-staging"] });
    const run = await userRun(s);
    expect(
      (await s.call("oa-staging__get_artifact", run)).out?.params,
    ).toHaveProperty(ARG);
    expect(
      (await s.call("oa-staging-evil__get_artifact", run)).out,
    ).toBeUndefined();
  });

  it("adds only the argument, never edits the model's own params", async () => {
    const s = setup();
    const run = await userRun(s);
    const params = { id: "x", [ARG]: "model-forged" };
    const { out, ev } = await s.call(
      "open-artifacts__get_artifact",
      run,
      params,
    );
    expect(Object.keys(out?.params ?? {})).toEqual([ARG]);
    expect(out?.params?.[ARG]).not.toBe("model-forged");
    expect(ev.params).toBe(params);
    expect(params).toEqual({ id: "x", [ARG]: "model-forged" });
  });

  it("is not in any tool schema the model sees", () => {
    const s = setup();
    for (const t of toolsFor(s.bus, {
      agentId: "main",
      sessionKey: "agent:main:main",
    }))
      expect(JSON.stringify(t.parameters)).not.toContain(ARG);
  });
});

describe("stays unlinked, every tool working", () => {
  const open = "open-artifacts__get_artifact";

  it("a daemon that did not list link gets no link_proof and no argument", async () => {
    const hub = new Hub();
    hub.welcomeCaps = undefined;
    const s = setup({}, hub);
    const run = await userRun(s);
    expect(hub.proofs).toHaveLength(0);
    expect((await s.call(open, run)).out).toBeUndefined();
  });

  it.each(["unbound", "error"] as const)(
    "a daemon that answers %s leaves no argument",
    async (answer) => {
      const hub = new Hub();
      hub.proofAnswer = answer;
      const s = setup({}, hub);
      const run = await userRun(s);
      expect(hub.proofs).toHaveLength(1);
      expect((await s.call(open, run)).out).toBeUndefined();
    },
  );

  it("a daemon that never answers does not hold the link or the tool", async () => {
    const hub = new Hub();
    hub.proofAnswer = "hang";
    const s = setup({ proofMs: 5 }, hub);
    await userRun(s);
    expect(hub.proofs).toHaveLength(1);
    expect(hub.clients[0]?.state).toBe("open");
    expect((await s.call(open, "run-1")).out).toBeUndefined();
  });

  it("a daemon that is down: the hook returns nothing and does not throw", async () => {
    const hub = new Hub();
    hub.down = true;
    const s = setup({}, hub);
    s.bus.buildPrompt(caller({ runId: "run-1" }));
    await flush();
    await expect(s.call(open, "run-1")).resolves.toMatchObject({
      out: undefined,
    });
  });

  it("a run the prompt hook never mapped (no runId, or an unknown one) is unlinked", async () => {
    const s = setup();
    await userRun(s);
    expect((await s.call(open, undefined)).out).toBeUndefined();
    expect((await s.call(open, "run-never-seen")).out).toBeUndefined();
  });

  it("a root that cannot be on the bus (a group, a subagent) is unmapped and unlinked", async () => {
    const s = setup();
    await online(
      s.bus,
      caller({ runId: "g", sessionKey: "agent:main:telegram:group:42" }),
    );
    await online(
      s.bus,
      caller({ runId: "sub", sessionKey: "agent:main:subagent:abc" }),
    );
    expect(s.hub.proofs).toHaveLength(0);
    expect((await s.call(open, "g")).out).toBeUndefined();
    expect((await s.call(open, "sub")).out).toBeUndefined();
  });

  it("a non-user run (a heartbeat on the main session) gets no proof", async () => {
    const s = setup();
    await userRun(s);
    s.bus.buildPrompt(caller({ runId: "hb", trigger: "heartbeat" }));
    expect((await s.call(open, "hb")).out).toBeUndefined();
    // And a user run's id never carries over to the heartbeat's tool calls.
    expect((await s.call(open, "run-1")).out).toBeUndefined();
  });

  it("a runtime this adapter does not claim is unmapped and unlinked", async () => {
    const s = setup();
    await online(
      s.bus,
      caller({ runId: "cx", modelProviderId: "openai-codex" }),
    );
    expect((await s.call(open, "cx")).out).toBeUndefined();
  });

  it("a failing hook body never throws into OpenClaw (a throw blocks the tool call)", async () => {
    const s = setup({
      mcpServers: () => {
        throw new Error("boom");
      },
    });
    const run = await userRun(s);
    await expect(s.call(open, run)).resolves.toMatchObject({ out: undefined });
    await expect(
      Promise.resolve(
        s.hooks.before_tool_call?.[0]?.(null as never, null as never),
      ),
    ).resolves.toBeUndefined();
  });
});
