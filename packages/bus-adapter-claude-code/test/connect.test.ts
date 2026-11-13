import { HelloRefused } from "@oa/bus-ipc";
import { describe, expect, it } from "vitest";
import {
  BUSY_MESSAGE,
  type ConnectDeps,
  connectOutcome,
  noSessionMessage,
  RESTARTING_MESSAGE,
} from "../src/connect.ts";
import {
  type ClaudeSession,
  type NoSessionReason,
  ProcStartUnknownError,
} from "../src/session.ts";

const session = { pid: 1, sessionId: "s", name: "n" } as ClaudeSession;
const deps = (o: Partial<ConnectDeps<string>> = {}): ConnectDeps<string> => ({
  findSession: () => ({ ok: true, session }),
  socketDirProblem: () => null,
  socketExists: () => true,
  connect: async () => "client",
  sleep: async () => {},
  ...o,
});

describe("connectOutcome", () => {
  it("ok", async () => {
    expect(await connectOutcome(deps())).toEqual({
      kind: "ok",
      client: "client",
    });
  });
  it("no session", async () => {
    expect(
      (
        await connectOutcome(
          deps({ findSession: () => ({ ok: false, reason: "none" }) }),
        )
      ).kind,
    ).toBe("no-session");
  });
  it("no socket", async () => {
    expect(
      (await connectOutcome(deps({ socketExists: () => false }))).kind,
    ).toBe("no-socket");
  });
  it("hello failure is busy", async () => {
    const out = await connectOutcome(
      deps({
        connect: async () => {
          throw new Error("daemon did not answer hello");
        },
      }),
    );
    expect(out.kind).toBe("busy");
  });
  it("a ps timeout while finding the session is busy", async () => {
    const out = await connectOutcome(
      deps({
        findSession: () => {
          throw new ProcStartUnknownError(1);
        },
      }),
    );
    expect(out.kind).toBe("busy");
  });
});

const failing = (e: unknown) =>
  deps({
    connect: async () => {
      throw e;
    },
  });
const coded = (code: string) =>
  Object.assign(new Error(code), { code }) as Error;

describe("connect failure kinds", () => {
  it("ECONNREFUSED and ENOENT are no-socket", async () => {
    for (const c of ["ECONNREFUSED", "ENOENT"])
      expect((await connectOutcome(failing(coded(c)))).kind).toBe("no-socket");
  });
  it("ETIMEDOUT and ECONNRESET are busy", async () => {
    for (const c of ["ETIMEDOUT", "ECONNRESET"])
      expect((await connectOutcome(failing(coded(c)))).kind).toBe("busy");
  });
  it("a hello refusal carries the daemon's reason", async () => {
    const out = await connectOutcome(
      failing(new HelloRefused({ type: "error", message: "nope" } as never)),
    );
    expect(out).toEqual({ kind: "refused", reason: "nope" });
    expect(noSessionMessage(out as never, true)).toContain("nope");
  });
});

describe("noSessionMessage", () => {
  it("names the real cause for busy, the install hint otherwise", () => {
    expect(noSessionMessage({ kind: "busy" }, true)).toBe(BUSY_MESSAGE);
    expect(
      noSessionMessage({ kind: "no-socket", seen: false }, true),
    ).toContain("install");
    expect(noSessionMessage({ kind: "no-socket", seen: true }, true)).toBe(
      RESTARTING_MESSAGE,
    );
    expect(
      noSessionMessage({ kind: "no-session", reason: "none" }, false),
    ).toContain("Claude Code");
  });
});

describe("daemon restart (#2364)", () => {
  it("re-attaches when the old socket refuses and the new daemon is up", async () => {
    let calls = 0;
    const out = await connectOutcome(
      deps({
        connect: async () => {
          calls += 1;
          if (calls < 3) throw coded("ECONNREFUSED");
          return "new-daemon";
        },
      }),
    );
    expect(out).toEqual({ kind: "ok", client: "new-daemon" });
    expect(calls).toBe(3);
  });
  it("finds a socket that is missing briefly", async () => {
    let looks = 0;
    const out = await connectOutcome(
      deps({
        socketExists: () => {
          looks += 1;
          return looks > 2;
        },
      }),
    );
    expect(out.kind).toBe("ok");
  });
  it("looks the session up again on every attempt", async () => {
    let finds = 0;
    let calls = 0;
    await connectOutcome(
      deps({
        findSession: () => {
          finds += 1;
          return { ok: true, session };
        },
        connect: async () => {
          calls += 1;
          if (calls < 2) throw coded("ECONNREFUSED");
          return "c";
        },
      }),
    );
    expect(finds).toBe(2);
  });
  it("a socket that only refuses ends as restarting, not install", async () => {
    const out = await connectOutcome(failing(coded("ECONNREFUSED")));
    expect(out).toEqual({ kind: "no-socket", seen: true });
    expect(noSessionMessage(out as never, true)).toBe(RESTARTING_MESSAGE);
  });
  it("no daemon at all keeps the install hint, after a bounded wait", async () => {
    const sleeps: number[] = [];
    const out = await connectOutcome(
      deps({
        socketExists: () => false,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(out).toEqual({ kind: "no-socket", seen: false });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
    expect(noSessionMessage(out as never, true)).toContain("install");
  });
  it("no session does not wait", async () => {
    let slept = 0;
    await connectOutcome(
      deps({
        findSession: () => ({ ok: false, reason: "none" }),
        sleep: async () => {
          slept += 1;
        },
      }),
    );
    expect(slept).toBe(0);
  });
});

describe("no-session reasons (#2364)", () => {
  const reasons: NoSessionReason[] = [
    "none",
    "unreadable",
    "not_session",
    "no_proc_start",
    "proc_start_mismatch",
    "proc_start_unknown",
    "socket_dir",
  ];
  it("each reason is named in the message under Claude, never the install hint", () => {
    for (const reason of reasons) {
      const m = noSessionMessage({ kind: "no-session", reason }, true);
      expect(m).toContain(`(${reason})`);
      expect(m).toContain("/mcp");
      expect(m).not.toContain("install");
    }
  });
  it("an unreadable file that becomes readable recovers within the wait", async () => {
    let looks = 0;
    const out = await connectOutcome(
      deps({
        findSession: () => {
          looks += 1;
          return looks < 3
            ? { ok: false, reason: "unreadable" }
            : { ok: true, session };
        },
      }),
    );
    expect(out.kind).toBe("ok");
  });
  it("a stable reason does not wait; a recoverable one waits, then reports", async () => {
    for (const [reason, sleeps] of [
      ["none", 0],
      ["not_session", 0],
      ["unreadable", 10],
      ["proc_start_mismatch", 10],
    ] as const) {
      let slept = 0;
      const out = await connectOutcome(
        deps({
          findSession: () => ({ ok: false, reason }),
          sleep: async () => {
            slept += 1;
          },
        }),
      );
      expect(out).toEqual({ kind: "no-session", reason });
      expect(slept).toBe(sleeps);
    }
  });
});
