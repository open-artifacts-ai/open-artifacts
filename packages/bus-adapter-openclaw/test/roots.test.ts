import { describe, expect, it } from "vitest";
import { REFUSED_PROVIDERS, refusal, resolveRoot } from "../src/roots.ts";
import { resolveStateDir } from "../src/state-dir.ts";

const S = "/home/u/.openclaw";
const ok = { agentId: "main", sessionKey: "agent:main:main", trigger: "user" };
const hook = { needTrigger: true };

describe("roots", () => {
  it("is stable, and a key's case does not change it", () => {
    const a = resolveRoot(ok, S, hook);
    const b = resolveRoot({ ...ok, sessionKey: "Agent:Main:MAIN" }, S, hook);
    expect(a).toMatchObject({ ok: true });
    expect(a).toEqual(b);
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
    expect(ref(S, "agent:main:telegram:dm:42")).not.toBe(base);
  });

  it("names the agent from the agent id and the key", () => {
    const r = resolveRoot(ok, S, hook);
    const t = resolveRoot(
      { ...ok, sessionKey: "agent:main:telegram:dm:42" },
      S,
      hook,
    );
    expect(r.ok && r.root.proposedName).toBe("openclaw-main");
    expect(t.ok && t.root.proposedName).toBe("openclaw-main-telegram-dm-42");
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
      resolveRoot({ ...ok, trigger: undefined }, S, { needTrigger: false }),
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
        { ...ok, modelProviderId: "openai", modelId: "gpt-5.5" },
        S,
        hook,
      ),
    ).toMatchObject({ ok: true });
  });

  it("keeps a ref a daemon accepts however odd the key", () => {
    const r = resolveRoot(
      { ...ok, sessionKey: `agent:main:${"é/ ".repeat(80)}` },
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
      resolveStateDir(
        { OPENCLAW_STATE_DIR: "/x/state", OPENCLAW_PROFILE: "p" },
        home,
        none,
      ),
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
  it("is the profile's dir without a state dir", () => {
    expect(resolveStateDir({ OPENCLAW_PROFILE: "eileen" }, home, none)).toBe(
      "/home/u/.openclaw-eileen",
    );
    expect(resolveStateDir({ OPENCLAW_PROFILE: "default" }, home, none)).toBe(
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
