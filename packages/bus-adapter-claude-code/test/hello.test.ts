import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_VERSION, connectDaemon, serveDaemon } from "@oa/bus-ipc";
import { afterEach, describe, expect, it } from "vitest";
import { sessionHello } from "../src/session.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const session = (name: string) => ({
  pid: 1,
  sessionId: "s1",
  socketPath: null,
  peerToken: null,
  name,
});

describe("the Claude session's hello", () => {
  it("lists the mailbox cap: the daemon then sends away rows and the new refusals", () => {
    expect(sessionHello(session("n"), 1, "/w").caps).toEqual(["mailbox"]);
  });

  it.each([
    [
      "a 63-char name ending in an emoji",
      `${"a".repeat(63)}😀`,
      "a".repeat(63),
    ],
    ["a name with a lone surrogate", "bad\ud800name", "bad�name"],
  ])("%s still connects", async (_, name, proposed) => {
    const path = join(mkdtempSync(join(tmpdir(), "ob-hello-")), "d.sock");
    const seen: (string | undefined)[] = [];
    const served = await serveDaemon({
      path,
      onHello: (h) => {
        seen.push(h.proposed_name);
        return { bus_name: "b", namespace: "n", global: false };
      },
      onFrame: () => undefined,
    });
    closers.push(served.close);
    const c = await connectDaemon({
      path,
      hello: sessionHello(session(name), process.pid, "/repo"),
    });
    c.close();
    expect(seen).toEqual([proposed]);
  });
  it("carries the IPC marker (C23c)", () => {
    expect(sessionHello(session("x"), 1, "/").client_version).toBe(
      CLIENT_VERSION,
    );
  });
  it("an empty name proposes none", () => {
    expect(sessionHello(session(""), 1, "/").proposed_name).toBeUndefined();
  });
});
