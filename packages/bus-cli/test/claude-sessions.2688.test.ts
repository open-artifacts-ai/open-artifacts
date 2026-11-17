// #2688: doctor and status say which live Claude sessions are not linked and
// why; `oa-bus mcp-proof` still exits 0 but logs its cause. Stubs only: a
// fake daemon status, a fake process table, a throwaway home.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { mcpProof, type ProofDeps } from "../src/commands/mcp-proof.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { type Fake, fakeCtx, status, TOKEN } from "./fake.ts";

const HUB = "https://bus.example.com";
const SECRET = "oa_pat_NOT_A_REAL_TOKEN";
const session = (
  name: string,
  state: "linked" | "unlinked" | "starting",
  cause?: "no_helper_call" | "proof_timed_out" | "proof_refused",
) => ({
  name,
  cwd: "/work/app",
  state,
  ...(cause ? { cause } : {}),
});

function ctxWith(
  reply: ReturnType<typeof status> | "down",
  over: Parameters<typeof fakeCtx>[0] = {},
): Fake {
  const ctx = fakeCtx({
    nodeVersion: "v22.11.0",
    which: (c) => c === "claude",
    exec: vi.fn(async () => ({ code: 0, stdout: "2.1.318", stderr: "" })),
    status:
      reply === "down"
        ? vi.fn(async () => {
            throw Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            });
          })
        : vi.fn(async () => reply),
    ...over,
  });
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: "l",
      machine_token: TOKEN,
    }),
  );
  return ctx;
}
const sessionLines = (ctx: Fake) =>
  ctx
    .all()
    .filter((l) =>
      /Claude Code: |Likely cause|Fix:|Other causes|^ {3}/.test(l),
    );

describe("doctor, live Claude sessions", () => {
  it("passes when every live session is linked", async () => {
    const ctx = ctxWith(
      status({
        claude_sessions: [
          session("a-1", "linked"),
          session("b-2", "linked"),
          session("c-3", "starting"),
        ],
      }),
    );
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "Claude Code: all 2 live sessions are linked.",
    );
    expect(ctx.all().join("\n")).not.toContain("is not linked");
  });

  it("fails for an unlinked live session with its name, folder, cause and fix", async () => {
    const ctx = ctxWith(
      status({
        claude_sessions: [
          session("a-1", "linked"),
          session("lost-9", "unlinked", "no_helper_call"),
        ],
      }),
    );
    expect(await doctor(ctx)).toBe(1);
    const all = ctx.all().join("\n");
    expect(all).toContain(
      "Claude Code: the session lost-9 in /work/app is not linked.",
    );
    expect(all).toContain("Likely cause: its helper never reported");
    expect(all).toContain("Fix: restart the session");
    expect(all).toContain("a different member");
    expect(all).toContain("CLAUDE_CONFIG_DIR");
    expect(all).not.toContain("live sessions are linked");
  });

  it("names the cause the daemon saw", async () => {
    for (const [cause, text] of [
      ["proof_timed_out", "expired"],
      ["proof_refused", "did not match this session"],
    ] as const) {
      const ctx = ctxWith(
        status({ claude_sessions: [session("s", "unlinked", cause)] }),
      );
      await doctor(ctx);
      expect(sessionLines(ctx).join("\n")).toContain(text);
    }
  });

  it("lists recent unbound daemon calls with their cause", async () => {
    const ctx = ctxWith(
      status({
        claude_sessions: [],
        unbound_proofs: [
          { at: Date.UTC(2026, 10, 17, 9, 30), cause: "no_live_record" },
        ],
      }),
    );
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "recent helper runs that linked nothing",
    );
    expect(ctx.all().join("\n")).toContain("no live session record appeared");
  });

  it("with the daemon down, fails: no session can link", async () => {
    const ctx = ctxWith("down");
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all().join("\n")).toContain(
      "Claude Code: the daemon is down, so no session can link.",
    );
  });

  it("says when the daemon is too old to tell", async () => {
    const reply = status();
    delete reply.claude_sessions;
    const ctx = ctxWith(reply);
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "this daemon is too old to say which sessions are linked",
    );
  });

  it("warns on an sse entry for the instance", async () => {
    const ctx = ctxWith(status({ claude_sessions: [] }));
    writeFileSync(
      join(ctx.userHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          oa: { type: "sse", url: `${HUB}/mcp` },
          other: { type: "sse", url: "https://elsewhere.test/mcp" },
        },
      }),
    );
    await doctor(ctx);
    const all = ctx.all().join("\n");
    expect(all).toContain(
      "the oa entry is an sse entry, which can't be linked.",
    );
    expect(all).not.toContain("the other entry");
  });
});

describe("status, live Claude sessions", () => {
  it("lists each unlinked session as a failure", async () => {
    const ctx = ctxWith(
      status({
        claude_sessions: [session("lost-9", "unlinked", "proof_refused")],
      }),
    );
    await statusCmd(ctx);
    expect(ctx.err().join("\n")).toContain(
      "Claude Code: the session lost-9 in /work/app is not linked.",
    );
  });

  it("says nothing about sessions when all are linked", async () => {
    const ctx = ctxWith(status({ claude_sessions: [session("a", "linked")] }));
    await statusCmd(ctx);
    expect(ctx.err().join("\n")).not.toContain("is not linked");
  });
});

describe("oa-bus mcp-proof logs why it linked nothing", () => {
  const tree: Record<number, { ppid: number; name: string }> = {
    50: { ppid: 40, name: "sh" },
    40: { ppid: 30, name: "claude" },
    30: { ppid: 1, name: "zsh" },
  };
  const deps = (over: Partial<ProofDeps> = {}): ProofDeps => ({
    proc: (pid) => tree[pid] ?? null,
    link: async () => true,
    random: () => Buffer.alloc(32, 7),
    ppid: 50,
    ...over,
  });
  const log = (ctx: Fake) => {
    try {
      return readFileSync(join(ctx.home, "logs", "events.log"), "utf8");
    } catch {
      return "";
    }
  };
  const tokenFile = (ctx: Fake) => {
    const f = join(ctx.userHome, "token");
    writeFileSync(f, `${SECRET}\n`);
    return f;
  };

  it("a linked run logs nothing", async () => {
    const ctx = fakeCtx();
    await mcpProof({}, ctx, deps());
    expect(log(ctx)).toBe("");
  });

  it("no live record: exits 0, prints the headers, logs the cause", async () => {
    const ctx = fakeCtx();
    const f = tokenFile(ctx);
    expect(
      await mcpProof({ tokenFile: f }, ctx, deps({ link: async () => false })),
    ).toBe(0);
    expect(JSON.parse(ctx.raw())).toEqual({
      Authorization: `Bearer ${SECRET}`,
    });
    expect(log(ctx)).toMatch(/ mcp_proof_unbound reason=no_live_record\n$/);
  });

  it("no claude ancestor, and a daemon that did not answer", async () => {
    const a = fakeCtx();
    expect(await mcpProof({}, a, deps({ proc: () => null }))).toBe(0);
    expect(log(a)).toContain("reason=no_claude_ancestor");
    const b = fakeCtx();
    expect(
      await mcpProof(
        {},
        b,
        deps({
          link: async () => {
            throw new Error("daemon did not answer link_proof");
          },
        }),
      ),
    ).toBe(0);
    expect(log(b)).toContain("reason=daemon_unreachable");
  });

  it("neither the log nor doctor shows a proof, a hash or the token", async () => {
    const ctx = ctxWith("down");
    const f = tokenFile(ctx);
    // The helper's own run (its stdout is Claude's, not doctor's).
    const helper = fakeCtx({ home: ctx.home, userHome: ctx.userHome });
    await mcpProof({ tokenFile: f }, helper, deps({ link: async () => false }));
    const proof = Buffer.alloc(32, 7).toString("base64url");
    const hash = "d8e0c2b5"; // any sha256 prefix would do; the log holds the cause only
    expect(log(ctx)).not.toContain(SECRET);
    expect(log(ctx)).not.toContain(proof);
    expect(log(ctx)).not.toContain(hash);
    // Even with no daemon, doctor shows what the helper logged.
    await doctor(ctx);
    const all = ctx.all().join("\n");
    expect(all).toContain("the daemon knew no live session for the process");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(proof);
  });
});
