import { HelloRefused } from "@oa/bus-ipc";
import { describe, expect, it } from "vitest";
import {
  BUSY_MESSAGE,
  type ConnectDeps,
  connectOutcome,
  noSessionMessage,
} from "../src/connect.ts";
import { type ClaudeSession, ProcStartUnknownError } from "../src/session.ts";

const session = { pid: 1, sessionId: "s", name: "n" } as ClaudeSession;
const deps = (o: Partial<ConnectDeps<string>> = {}): ConnectDeps<string> => ({
  findSession: () => session,
  socketDirProblem: () => null,
  socketExists: () => true,
  connect: async () => "client",
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
    expect((await connectOutcome(deps({ findSession: () => null }))).kind).toBe(
      "no-session",
    );
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
    expect(noSessionMessage({ kind: "no-socket" }, true)).toContain("install");
    expect(noSessionMessage({ kind: "no-session" }, false)).toContain(
      "Claude Code",
    );
  });
});
