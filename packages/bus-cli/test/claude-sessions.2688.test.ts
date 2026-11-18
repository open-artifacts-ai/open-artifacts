// #2688: doctor and status say which live Claude sessions are not linked and
// why; `oa-bus mcp-proof` still exits 0 but logs its cause. Stubs only: a
// fake daemon status, a fake process table, a throwaway home.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusReply } from "@oa/bus-ipc";
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
  /** The ~/.claude.json: by default a user-scope entry for the instance. */
  claudeJson: object = {
    mcpServers: { oa: { type: "http", url: `${HUB}/mcp` } },
  },
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
  writeFileSync(join(ctx.userHome, ".claude.json"), JSON.stringify(claudeJson));
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

  it("with the daemon down, adds no second failure: the daemon check already says so", async () => {
    const ctx = ctxWith("down");
    expect(await doctor(ctx)).toBe(1);
    const all = ctx.all().join("\n");
    expect(all).toContain("Daemon is not running");
    expect(all).not.toContain("so no session can link");
  });

  it("a session with no entry for the instance is not judged: one info line, no failure", async () => {
    const ctx = ctxWith(
      status({
        claude_sessions: [
          session("conn-1", "unlinked", "no_helper_call"),
          session("conn-2", "unlinked", "no_helper_call"),
        ],
      }),
      {},
      // A connector user: no entry at all, and another project's local entry.
      {
        projects: {
          "/elsewhere": {
            mcpServers: { oa: { type: "http", url: `${HUB}/mcp` } },
          },
        },
      },
    );
    await doctor(ctx);
    const all = ctx.all().join("\n");
    expect(all).not.toContain("is not linked");
    expect(all).toContain(
      "2 live Claude sessions have no entry for this instance, so they aren't checked.",
    );
  });

  it("judges a session when an entry applies to its folder: user, local, or project scope", async () => {
    const unlinked = status({
      claude_sessions: [session("s", "unlinked", "no_helper_call")],
    });
    const entry = { type: "http", url: `${HUB}/mcp` };
    const local = ctxWith(
      unlinked,
      {},
      {
        projects: { "/work/app": { mcpServers: { oa: entry } } },
      },
    );
    await doctor(local);
    expect(local.all().join("\n")).toContain("is not linked");
    // Project scope: .mcp.json in the session's own folder.
    const proj = ctxWith(unlinked, {}, {});
    const dir = mkdtempSync(join(tmpdir(), "ob-sess-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { x: entry } }),
    );
    const ps = ctxWith(
      status({
        claude_sessions: [
          { ...session("s", "unlinked", "no_helper_call"), cwd: dir },
        ],
      }),
      {},
      {},
    );
    await doctor(ps);
    expect(ps.all().join("\n")).toContain("is not linked");
    await doctor(proj);
    expect(proj.all().join("\n")).not.toContain("is not linked");
  });

  it("prints a cause code it does not know as it is, and a newer state is not a failure", async () => {
    const reply = {
      ...status(),
      claude_sessions: [
        session("a", "unlinked", "brand_new_cause" as never),
        { name: "b", cwd: "/work/app", state: "paused" },
      ],
      unbound_proofs: [{ at: Date.now(), cause: "future_cause" }],
    };
    // A newer daemon's codes parse.
    expect(
      StatusReply.safeParse({ ...reply, v: 1, id: "status", type: "status" })
        .success,
    ).toBe(true);
    const ctx = ctxWith(reply);
    await doctor(ctx);
    const all = ctx.all().join("\n");
    expect(all).toContain("the daemon reports brand_new_cause");
    expect(all).toContain("the daemon reports future_cause");
    expect(all).not.toContain("the session b");
  });

  it("never prints a newline or control character from a name, a folder or an entry name", async () => {
    const ctx = ctxWith(
      status({
        claude_sessions: [
          {
            name: "a\nFix: run evil",
            cwd: "/work/app\u2028x",
            state: "unlinked",
          },
        ],
      }),
    );
    // The folder is `/work/app\u2028x`: give it an entry so it is judged.
    writeFileSync(
      join(ctx.userHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "o\na": { type: "sse", url: `${HUB}/mcp` },
          oa: { type: "http", url: `${HUB}/mcp` },
        },
      }),
    );
    await doctor(ctx);
    for (const l of ctx.all()) expect(l).not.toMatch(/[\n\u2028]/);
    const all = ctx.all().join("|");
    expect(all).toContain("a?Fix: run evil");
    expect(all).toContain("the o?a entry is an sse entry");
  });

  it("an invalid hub address does not stop doctor", async () => {
    const ctx = ctxWith(status({ claude_sessions: [] }));
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: "::not a url::",
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    await expect(doctor(ctx)).resolves.toBeTypeOf("number");
  });

  it("lists only unbound daemon calls from the last day", async () => {
    const now = fakeCtx().now();
    const ctx = ctxWith(
      status({
        claude_sessions: [],
        unbound_proofs: [
          { at: now - 3 * 86_400_000, cause: "no_process_start" },
          { at: now, cause: "process_mismatch" },
        ],
      }),
    );
    await doctor(ctx);
    const all = ctx.all().join("\n");
    expect(all).toContain("did not match the session");
    expect(all).not.toContain("start time could not be read");
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
    expect(log(ctx)).toMatch(
      / mcp_proof_unbound reason=process_not_matched\n$/,
    );
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
    // A process-table error is not the daemon's.
    const c = fakeCtx();
    expect(
      await mcpProof(
        {},
        c,
        deps({
          proc: () => {
            throw new Error("ps failed");
          },
        }),
      ),
    ).toBe(0);
    expect(log(c)).toContain("reason=process_table_error");
  });

  it("an unwritable home still prints the headers and exits 0", async () => {
    const ctx = fakeCtx();
    // The bus home is a file, so the log folder can't be made.
    rmSync(ctx.home, { recursive: true, force: true });
    writeFileSync(ctx.home, "not a folder");
    const f = tokenFile(ctx);
    expect(
      await mcpProof({ tokenFile: f }, ctx, deps({ link: async () => false })),
    ).toBe(0);
    expect(JSON.parse(ctx.raw())).toEqual({
      Authorization: `Bearer ${SECRET}`,
    });
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
    expect(all).toContain(
      "the daemon could not match the process to a live session",
    );
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(proof);
  });
});
