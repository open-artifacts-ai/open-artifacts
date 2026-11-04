// A wedged daemon must not hang a tool call.
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connectDaemon } from "@oa/bus-ipc";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/tools.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** A daemon that welcomes the hello, then stalls (SIGSTOPped, wedged on the hub). */
async function stalledDaemon(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "ob-adv5a-")), "d.sock");
  const server = createServer((s) => {
    s.on("error", () => {});
    createInterface({ input: s }).once("line", () =>
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
    const client = await connectDaemon({
      path: await stalledDaemon(),
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
      const outcome = await Promise.race([
        callTool("list_agents", {}, client),
        new Promise((r) => setTimeout(() => r("hung"), 5_000)),
      ]);
      expect(outcome).toMatchObject({ isError: true });
      expect(JSON.stringify(outcome)).toMatch(/timed out/);
    } finally {
      client.close();
    }
  }, 10_000);
});
