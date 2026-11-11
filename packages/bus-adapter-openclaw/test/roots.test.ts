import { describe, expect, it } from "vitest";
import {
  directShape,
  nameOf,
  normalizeSessionKey,
  REFUSED_PROVIDERS,
  refusal,
  resolveRoot,
  runtimeRefused,
} from "../src/roots.ts";
import { resolveStateDir } from "../src/state-dir.ts";

const S = "/home/u/.openclaw";
const ok = { agentId: "main", sessionKey: "agent:main:main", trigger: "user" };
const hook = { needTrigger: true, runtime: true };

describe("roots", () => {
  it("is stable, and a key's case does not change it", () => {
    const a = resolveRoot(ok, S, hook);
    const b = resolveRoot({ ...ok, sessionKey: "Agent:Main:MAIN" }, S, hook);
    expect(a).toMatchObject({ ok: true });
    expect(a.ok && b.ok && a.root.ref === b.root.ref).toBe(true);
    if (a.ok) expect(a.root.ref).toMatch(/^oa-[0-9a-f]{40}$/);
  });

  it("differs by state dir, agent and key", () => {
    const ref = (s: string, key: string) => {
      const r = resolveRoot({ ...ok, sessionKey: key }, s, hook);
      return r.ok ? r.root.ref : "";
    };
    const base = ref(S, "agent:main:main");
    expect(ref("/home/u/.openclaw-eileen", "agent:main:main")).not.toBe(base);
    expect(ref(S, "agent:other:main")).not.toBe(base);
    expect(ref(S, "agent:main:telegram:direct:42")).not.toBe(base);
  });

  it("names the agent from the agent id and the key", () => {
    const r = resolveRoot(ok, S, hook);
    const t = resolveRoot(
      { ...ok, sessionKey: "agent:main:telegram:direct:42" },
      S,
      hook,
    );
    expect(r.ok && r.root.proposedName).toBe("openclaw-main");
    expect(t.ok && t.root.proposedName).toBe(
      "openclaw-main-telegram:direct:42",
    );
  });

  it("keeps the display name as typed, and lowercases only the identity", () => {
    const a = resolveRoot(
      {
        ...ok,
        agentId: "Eileen",
        sessionKey: "agent:Eileen:Telegram:direct:Café Chat",
      },
      S,
      hook,
    );
    const b = resolveRoot(
      { ...ok, sessionKey: "agent:eileen:telegram:direct:café chat" },
      S,
      hook,
    );
    expect(a.ok && a.root.proposedName).toBe(
      "openclaw-Eileen-Telegram:direct:Café Chat",
    );
    expect(a.ok && b.ok && a.root.ref === b.root.ref).toBe(true);
  });

  it("strips controls, trims, caps at 64 without splitting a pair", () => {
    const c = resolveRoot(
      { ...ok, sessionKey: "agent:main:direct:a\u0007b" },
      S,
      hook,
    );
    expect(c.ok && c.root.proposedName).toBe("openclaw-main-direct:ab");
    const long = resolveRoot(
      { ...ok, sessionKey: `agent:main:direct:${"x".repeat(53)}😀😀` },
      S,
      hook,
    );
    const n = long.ok ? long.root.proposedName : "";
    expect(n.length).toBeLessThanOrEqual(64);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(n)).toBe(false);
  });

  it("nameOf falls back to the kind", () => {
    expect(nameOf("\u0001  ")).toBe("openclaw");
  });

  it.each([
    ["a subagent", "agent:main:subagent:abc", refusal.subagent],
    ["a nested subagent", "agent:main:subagent:a:subagent:b", refusal.subagent],
    ["an ACP session", "agent:main:acp:codex", refusal.acp],
    ["a cron run", "agent:main:cron:nightly", refusal.cron],
    ["a missing key", undefined, refusal.noKey],
    ["an empty key", "  ", refusal.noKey],
    ["an unknown key", "main", refusal.badKey],
    ["an unknown key shape", "agent:main", refusal.badKey],
  ])("refuses %s", (_n, key, reason) => {
    expect(resolveRoot({ ...ok, sessionKey: key }, S, hook)).toEqual({
      ok: false,
      reason,
    });
  });

  it("refuses a subagent key whatever its case", () => {
    expect(
      resolveRoot({ ...ok, sessionKey: "AGENT:main:SubAgent:x" }, S, hook),
    ).toMatchObject({ ok: false });
  });

  it.each(["cron", "heartbeat", "hook", "memory", undefined])(
    "refuses trigger %s in a hook",
    (trigger) => {
      expect(resolveRoot({ ...ok, trigger }, S, hook)).toEqual({
        ok: false,
        reason: refusal.trigger,
      });
    },
  );

  it("does not ask a tool factory for a trigger", () => {
    expect(
      resolveRoot({ ...ok, trigger: undefined }, S, {
        needTrigger: false,
        runtime: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([...REFUSED_PROVIDERS, "Claude-CLI"])(
    "refuses the %s runtime",
    (modelProviderId) => {
      expect(resolveRoot({ ...ok, modelProviderId }, S, hook)).toEqual({
        ok: false,
        reason: refusal.runtime,
      });
    },
  );

  it("takes an ordinary provider", () => {
    expect(
      resolveRoot(
        { ...ok, modelProviderId: "anthropic", modelId: "claude" },
        S,
        hook,
      ),
    ).toMatchObject({ ok: true });
  });

  it("keeps a ref a daemon accepts however odd the key", () => {
    const r = resolveRoot(
      { ...ok, sessionKey: `agent:main:direct:${"é/ ".repeat(80)}` },
      S,
      hook,
    );
    expect(r.ok && r.root.ref).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(r.ok && r.root.proposedName.length).toBeLessThanOrEqual(64);
  });
});

describe("state dir", () => {
  const none = () => false;
  const home = () => "/home/u";
  it("is OPENCLAW_STATE_DIR first", () => {
    expect(
      resolveStateDir({ OPENCLAW_STATE_DIR: "/x/state" }, home, none),
    ).toBe("/x/state");
  });
  it("expands ~ against OPENCLAW_HOME", () => {
    expect(
      resolveStateDir(
        { OPENCLAW_STATE_DIR: "~/s", OPENCLAW_HOME: "/h2" },
        home,
        none,
      ),
    ).toBe("/h2/s");
  });
  it("ignores OPENCLAW_PROFILE: only --profile, which sets the state dir, moves it", () => {
    expect(resolveStateDir({ OPENCLAW_PROFILE: "eileen" }, home, none)).toBe(
      "/home/u/.openclaw",
    );
  });
  it("is ~/.openclaw, or a legacy dir only when that alone exists", () => {
    const env = { HOME: "/home/u" };
    expect(resolveStateDir(env, home, none)).toBe("/home/u/.openclaw");
    expect(resolveStateDir(env, home, (p) => p === "/home/u/.clawdbot")).toBe(
      "/home/u/.clawdbot",
    );
    expect(resolveStateDir(env, home, () => true)).toBe("/home/u/.openclaw");
  });
  it("follows OPENCLAW_HOME", () => {
    expect(
      resolveStateDir({ OPENCLAW_HOME: "/tmp/t", HOME: "/home/u" }, home, none),
    ).toBe("/tmp/t/.openclaw");
  });
});

describe("only the main session and direct chats (S5)", () => {
  const key = (k: string) => resolveRoot({ ...ok, sessionKey: k }, S, hook);
  it.each([
    "agent:main:main",
    "agent:main:direct:alice",
    "agent:main:telegram:direct:42",
    "agent:main:signal:work:direct:+15555550123",
    "agent:eileen:main",
  ])("allows %s", (k) => {
    expect(key(k)).toMatchObject({ ok: true });
  });

  it.each([
    "agent:main:telegram:group:42",
    "agent:main:slack:channel:C123",
    "agent:main:discord:work:group:9",
    "agent:main:matrix:channel:!Room:example.org",
    "agent:main:signal:group:AbC123",
    "agent:main:slack:room:r1",
    "agent:main:telegram:direct:42:thread:9",
    "agent:main:telegram:group:42:thread:9",
    "agent:main:gw1",
    "agent:main:s9",
    "agent:main:webhook:abc",
    "agent:main:direct:",
    "agent:main:telegram:direct:",
    "main",
  ])("refuses %s", (k) => {
    expect(key(k)).toEqual({ ok: false, reason: refusal.badKey });
  });

  it("takes the configured main key, and only that one", () => {
    const cfg = { session: { mainKey: "home" } };
    const k = (sessionKey: string) =>
      resolveRoot({ ...ok, sessionKey }, S, { ...hook, config: cfg });
    expect(k("agent:main:home")).toMatchObject({ ok: true });
    expect(k("agent:main:work")).toMatchObject({ ok: false });
  });

  it("directShape is what the keys of buildAgentPeerSessionKey look like", () => {
    expect(directShape("main")).toBe(true);
    expect(directShape("direct:x")).toBe(true);
    expect(directShape("telegram:direct:x")).toBe(true);
    expect(directShape("telegram:work:direct:x")).toBe(true);
    expect(directShape("telegram:group:direct:x")).toBe(false);
    expect(directShape("group:direct:x")).toBe(false);
    expect(directShape("")).toBe(false);
  });
});

describe("the key as OpenClaw normalizes it (nit)", () => {
  it("lowercases ordinary keys", () => {
    expect(normalizeSessionKey("Agent:Main:TELEGRAM:Direct:Alice")).toBe(
      "agent:main:telegram:direct:alice",
    );
  });
  it("keeps the case of a Signal group id and a Matrix channel or group tail", () => {
    expect(normalizeSessionKey("Agent:Main:Signal:Group:AbC=/xY")).toBe(
      "agent:main:signal:group:AbC=/xY",
    );
    expect(
      normalizeSessionKey("agent:main:matrix:channel:!AbC:Example.org"),
    ).toBe("agent:main:matrix:channel:!AbC:Example.org");
    expect(
      normalizeSessionKey("agent:main:matrix:group:!AbC:Ex.org:thread:$EvT"),
    ).toBe("agent:main:matrix:group:!AbC:Ex.org:thread:$EvT");
  });
});

describe("the model route (B1)", () => {
  const stock = { models: { providers: {} } };
  it("refuses stock openai: OpenClaw runs it on the Codex runtime by default", () => {
    expect(runtimeRefused("openai", stock)).toBe(true);
    expect(runtimeRefused("OpenAI", undefined)).toBe(true);
    expect(
      runtimeRefused("openai", {
        models: {
          providers: { openai: { baseUrl: "https://api.openai.com/v1" } },
        },
      }),
    ).toBe(true);
  });
  it("allows openai behind a custom base URL, which bypasses the Codex default", () => {
    expect(
      runtimeRefused("openai", {
        models: {
          providers: { OpenAI: { baseUrl: "https://llm.example.com/v1" } },
        },
      }),
    ).toBe(false);
  });
  it("refuses a config that names the Codex runtime anywhere", () => {
    expect(
      runtimeRefused("anthropic", {
        agents: { list: [{ id: "a", agentRuntime: { id: "codex" } }] },
      }),
    ).toBe(true);
    expect(
      runtimeRefused("anthropic", {
        agents: { list: [{ agentRuntime: { id: "openclaw" } }] },
      }),
    ).toBe(false);
  });
  it("refuses the other runtimes by provider id, and allows the rest", () => {
    for (const p of REFUSED_PROVIDERS)
      expect(runtimeRefused(p, stock)).toBe(true);
    for (const p of ["anthropic", "fakeprov", "google", undefined])
      expect(runtimeRefused(p, stock)).toBe(false);
  });
  it("resolveRoot refuses an openai route at prompt time, and not when only the key is wanted", () => {
    const c = { ...ok, modelProviderId: "openai" };
    expect(resolveRoot(c, S, { ...hook, config: stock })).toEqual({
      ok: false,
      reason: refusal.runtime,
    });
    expect(
      resolveRoot(c, S, { needTrigger: false, runtime: false, config: stock }),
    ).toMatchObject({ ok: true });
  });
});
