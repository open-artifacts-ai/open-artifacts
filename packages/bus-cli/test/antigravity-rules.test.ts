// agy S4 (#3043): an Antigravity conversation gets the bus rules at its start
// from the plugin's SessionStart hook (`oa-bus agy-hello`), as one system
// message agy keeps in the conversation. No file holds them. Fake process
// table and daemon: no real agy runs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_RULES, BRIEF_RULES_MAX_BYTES } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type AgyHelloDeps,
  agyHello,
  agyHookOutput,
  agyWatchStep,
} from "../src/commands/agy-hello.ts";
import { fakeCtx } from "./fake.ts";

const REF = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const TABLE: Record<number, { ppid: number; name: string } | null> = {
  100: { ppid: 1, name: "/bin/zsh" },
  200: { ppid: 100, name: "/Users/u/.local/bin/agy" },
  300: { ppid: 200, name: "/bin/sh" },
};
const payload = (hookEventName: string) =>
  JSON.stringify({
    conversationId: REF,
    cwd: "/w/app",
    workspacePaths: ["/w"],
    // agy's payload carries the user's text: it must never reach the output.
    lastUserInput: "PEER-TEXT-NEVER-ECHOED",
    hookEventName,
  });
const injected = (rules: string) =>
  JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage: rules } }],
  });

const run = async (
  event: string,
  over: Partial<AgyHelloDeps> = {},
  ctx = fakeCtx(),
) => {
  const hello = vi.fn(async (_h: unknown, rules: boolean) => ({
    name: "agy",
    ...(rules ? { rules: BRIEF_RULES } : {}),
  }));
  expect(
    await agyHello(ctx, {
      stdin: async () => payload(event),
      proc: (pid) => TABLE[pid] ?? null,
      procStart: () => "t0",
      title: async () => undefined,
      hello,
      localRules: () => BRIEF_RULES,
      watcherLive: () => true,
      ppid: 300,
      ...over,
    }),
  ).toBe(0);
  return { out: ctx.out(), hello, ctx };
};

describe("the bus rules at an agy conversation's start (agy S4, #3043)", () => {
  it("SessionStart: asks the daemon on the hook's connection and injects its rules as one system message", async () => {
    const { out, hello } = await run("SessionStart");
    expect(hello).toHaveBeenCalledWith(expect.anything(), true);
    expect(out).toEqual([injected(BRIEF_RULES)]);
    expect(out.join("")).not.toContain("PEER-TEXT");
  });

  it("the daemon's own wording wins over the bundled text", async () => {
    const theirs = "When you're connected to the Open Artifacts bus: v2";
    const { out } = await run("SessionStart", {
      hello: async () => ({ name: "agy", rules: theirs }),
    });
    expect(out).toEqual([injected(theirs)]);
  });

  it("opted out: the daemon says none, and none goes out", async () => {
    const { out } = await run("SessionStart", {
      hello: async () => ({ name: "agy", rules: null }),
    });
    expect(out).toEqual(["{}"]);
  });

  it("no daemon: the bundled rules, unless install.json opted out", async () => {
    const down = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const on = await run("SessionStart", { hello: down });
    expect(on.out).toEqual([injected(BRIEF_RULES)]);
    // The real opt-out check: install.json's habits.optedOut.
    const ctx = fakeCtx();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "install.json"),
      JSON.stringify({ habits: { optedOut: true } }),
    );
    // No localRules given: the default reads the opt-out.
    await agyHello(ctx, {
      stdin: async () => payload("SessionStart"),
      proc: (pid) => TABLE[pid] ?? null,
      procStart: () => "t0",
      title: async () => undefined,
      ppid: 300,
      hello: down,
    });
    expect(ctx.out()).toEqual(["{}"]);
  });

  it("a daemon answer too long or empty is not sent: the bundled rules go instead", async () => {
    for (const bad of ["x".repeat(BRIEF_RULES_MAX_BYTES + 1), "  "]) {
      const { out } = await run("SessionStart", {
        hello: async () => ({ name: "agy", rules: bad }),
      });
      expect(out).toEqual([injected(BRIEF_RULES)]);
    }
  });

  it("PreInvocation never adds them, joined or not, and never asks the daemon for them", async () => {
    const joined = await run("PreInvocation");
    expect(joined.hello).toHaveBeenCalledWith(expect.anything(), false);
    expect(joined.out).toEqual(["{}"]);
    const refused = await run("PreInvocation", {
      hello: async () => {
        throw new Error("refused");
      },
    });
    expect(refused.out).toEqual(["{}"]);
  });

  it("no agy above the hook: the rules still go out at SessionStart, with no hello", async () => {
    const { out, hello } = await run("SessionStart", { ppid: 100 });
    expect(hello).not.toHaveBeenCalled();
    expect(out).toEqual([injected(BRIEF_RULES)]);
  });

  it("the output is agy's documented SessionStart shape, under the rules' byte bound", () => {
    const doc = JSON.parse(agyHookOutput(BRIEF_RULES));
    expect(doc).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: BRIEF_RULES } }],
    });
    expect(agyHookOutput(null)).toBe("{}");
    expect(agyHookOutput(undefined)).toBe("{}");
  });

  it("SessionStart with no watcher live combines rules and watcher step in one injectSteps", async () => {
    const line = "/h/.oa-bus/bin/oa-bus agy-watch";
    const both = await run("SessionStart", {
      watcherLive: () => false,
      watchLine: () => line,
    });
    expect(JSON.parse(both.out[0] as string)).toEqual({
      injectSteps: [
        { systemMessage: { systemMessage: BRIEF_RULES } },
        { systemMessage: { systemMessage: agyWatchStep(line) } },
      ],
    });
    // Opted out: only the watcher step goes out.
    const optedOut = await run("SessionStart", {
      hello: async () => ({ name: "agy", rules: null }),
      watcherLive: () => false,
      watchLine: () => line,
    });
    expect(JSON.parse(optedOut.out[0] as string)).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: agyWatchStep(line) } }],
    });
  });
});

describe("the hook's log line (agy S4)", () => {
  it("says which rules went out, never their text", async () => {
    const { readFileSync } = await import("node:fs");
    const line = async (over: Partial<AgyHelloDeps>) => {
      const { ctx } = await run("SessionStart", over);
      return readFileSync(join(ctx.home, "logs", "events.log"), "utf8");
    };
    expect(await line({})).toContain("code=rules_daemon");
    expect(
      await line({
        hello: async () => {
          throw new Error("down");
        },
      }),
    ).toContain("code=rules_bundled");
    const none = await line({
      hello: async () => ({ name: "agy", rules: null }),
    });
    expect(none).toContain("code=rules_none");
    expect(none).not.toContain("connected to the Open Artifacts bus");
  });
});
