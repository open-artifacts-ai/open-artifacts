// #2110: an inject timer that fires before the socket's 'connect' proves
// nothing about the session. It is a retryable timeout, never "closed".
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InjectError } from "@oa/bus-adapter-claude-code";
import { describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ code: "ETIMEDOUT" as string | undefined }));
vi.mock("@oa/bus-adapter-claude-code", async (orig) => ({
  ...(await orig<typeof import("@oa/bus-adapter-claude-code")>()),
  inject: async () => {
    const { InjectError: IE } = await vi.importActual<
      typeof import("@oa/bus-adapter-claude-code")
    >("@oa/bus-adapter-claude-code");
    throw new IE("injection timed out", false, mode.code);
  },
}));

const { ClaudeTransport } = await import("../src/transports/claude.ts");

const agent = {
  ref: "s1",
  kind: "claude-code",
  proposedName: "a",
  busName: "a",
  namespace: "n",
  global: true,
  pid: 1,
  cwd: "/",
  live: true,
} as const;
const mail = { msg_id: "m1", from_name: "peer", namespace: "n", body: "x" };

const transport = () => {
  const d = mkdtempSync(join(tmpdir(), "ob-2110-"));
  return new ClaudeTransport({
    socketsDir: join(d, "s"),
    heldFile: join(d, "held.json"),
    target: () => ({ socketPath: join(d, "c.sock"), peerToken: "tok" }),
  });
};

describe("#2110 inject timeout", () => {
  it("a timeout before connect is a retryable timeout, not closed", async () => {
    const t = transport();
    expect(await t.deliver(agent, mail)).toEqual({
      ok: false,
      reason: "timeout",
    });
    await t.close();
  });

  it("nothing listening (refused) is still closed", async () => {
    mode.code = "ECONNREFUSED";
    const t = transport();
    expect(await t.deliver(agent, mail)).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(new InjectError("x", false).connected).toBe(false);
    await t.close();
  });
});
