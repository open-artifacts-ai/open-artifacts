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

describe("noSessionMessage", () => {
  it("names the real cause for busy, the install hint otherwise", () => {
    expect(noSessionMessage("busy", true)).toBe(BUSY_MESSAGE);
    expect(noSessionMessage("no-socket", true)).toContain("install");
    expect(noSessionMessage("no-session", false)).toContain("Claude Code");
  });
});
