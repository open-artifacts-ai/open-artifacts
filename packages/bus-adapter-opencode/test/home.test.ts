// An empty OA_BUS_HOME is unset: the tool server dials ~/.oa-bus, never its cwd.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_META } from "../src/tools.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("opencode tool server with an empty OA_BUS_HOME", () => {
  it("dials ~/.oa-bus/daemon.sock, not one in its cwd", async () => {
    const home = tmp("ob-oh-");
    mkdirSync(join(home, ".oa-bus"), { mode: 0o700 });
    const hellos: string[] = [];
    const server: Server = createServer((s) => {
      s.on("error", () => {});
      createInterface({ input: s }).once("line", (l) => {
        hellos.push(String(JSON.parse(l).agent_ref));
        s.destroy();
      });
    });
    await new Promise<void>((r) =>
      server.listen(join(home, ".oa-bus", "daemon.sock"), () => r()),
    );
    cleanup.push(() => new Promise((r) => server.close(() => r())));
    // `opencode api session.get` answers with a root session.
    const bin = tmp("ob-ob-");
    writeFileSync(
      join(bin, "opencode"),
      `#!/bin/sh\necho '{"data":{"id":"ses_home","directory":"/"}}'\n`,
    );
    chmodSync(join(bin, "opencode"), 0o755);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        // @oa/bus-adapter-claude-code uses parameter properties; the shipped build is bundled.
        args: ["--experimental-transform-types", MAIN],
        cwd: tmp("ob-oc-"),
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: home,
          OA_BUS_HOME: "",
        },
        stderr: "ignore",
      }),
    );
    cleanup.push(() => client.close());
    await client.callTool({
      name: "list_agents",
      arguments: {},
      _meta: { [SESSION_META]: "ses_home" },
    });
    expect(hellos).toEqual(["ses_home"]);
  });
});
