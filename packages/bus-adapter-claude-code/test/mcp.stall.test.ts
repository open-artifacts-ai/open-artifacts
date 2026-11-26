// A wedged daemon must not hang a tool call.
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connectDaemon } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool } from "../src/tools.ts";

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** A daemon that welcomes the hello, then stalls (SIGSTOPped, wedged on the hub). */
async function stalledDaemon(onRequest: () => void): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "ob-adv5a-")), "d.sock");
  const server = createServer((s) => {
    s.on("error", () => {});
    const lines = createInterface({ input: s });
    // The first line is the hello; every later one is a request left unanswered.
    lines.on("line", () => onRequest());
    lines.once("line", () =>
      s.write(
        `${JSON.stringify({
          v: 1,
          id: "hello",
          type: "welcome",
          agent_ref: "sX",
          bus_name: "a",
          namespace: "ns",
          global: false,
        })}\n`,
      ),
    );
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  servers.push(server);
  return path;
}

describe("claude mcp server against a stalled daemon", () => {
  it("a tool call against a stalled daemon returns isError instead of hanging", async () => {
    let requested!: () => void;
    const requestSeen = new Promise<void>((r) => {
      requested = r;
    });
    let lines = 0;
    const path = await stalledDaemon(() => {
      if (++lines === 2) requested();
    });
    const client = await connectDaemon({
      path,
      hello: {
        v: 1,
        id: "hello",
        type: "hello",
        kind: "claude-code",
        agent_ref: "sX",
        pid: process.pid,
        cwd: process.cwd(),
        attest: {},
      },
      requestTimeoutMs: 200,
    });
    try {
      // The request timeout runs on fake time: the call stays pending until
      // 200 ms have elapsed, then settles as an error. It never hangs.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const call = callTool("list_agents", {}, client);
      let done = false;
      void call.then(() => {
        done = true;
      });
      await requestSeen;
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await call;
      expect(done).toBe(true);
      expect(outcome).toMatchObject({ isError: true });
      expect(JSON.stringify(outcome)).toMatch(/timed out/);
    } finally {
      client.close();
    }
  });
});
