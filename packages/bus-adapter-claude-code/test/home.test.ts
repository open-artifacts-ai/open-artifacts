// An empty OA_BUS_HOME is unset: the tool server dials ~/.oa-bus, never its cwd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProcStartOf, busHome } from "../src/session.ts";
import { daemonSocketPath, shortSocketDir } from "../src/socket-path.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A daemon at `path` (default <home>/.oa-bus/daemon.sock) that records each hello's agent_ref. */
async function daemonIn(
  home: string,
  path = join(home, ".oa-bus", "daemon.sock"),
) {
  mkdirSync(dirname(path), { mode: 0o700 });
  const hellos: string[] = [];
  const server: Server = createServer((s) => {
    s.on("error", () => {});
    createInterface({ input: s }).once("line", (l) => {
      hellos.push(String(JSON.parse(l).agent_ref));
      s.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  cleanup.push(() => new Promise((r) => server.close(() => r())));
  return hellos;
}

describe("busHome", () => {
  it("treats an empty OA_BUS_HOME as unset", () => {
    expect(busHome({ OA_BUS_HOME: "" })).toBe(join(homedir(), ".oa-bus"));
    expect(busHome({})).toBe(join(homedir(), ".oa-bus"));
  });

  it("is absolute, even when OA_BUS_HOME is relative", () => {
    expect(busHome({ OA_BUS_HOME: "rel/home" })).toBe(
      join(process.cwd(), "rel/home"),
    );
  });
});

describe("claude tool server", () => {
  it.each([
    [
      "an empty OA_BUS_HOME dials ~/.oa-bus/daemon.sock, not one in its cwd",
      false,
    ],
    ["a long OA_BUS_HOME dials the short socket folder (C15)", true],
  ])("%s", async (_what, long) => {
    const home = tmp("ob-h-");
    const obHome = long ? join(home, "x".repeat(110)) : "";
    if (long)
      cleanup.push(async () =>
        rmSync(shortSocketDir(obHome), { recursive: true, force: true }),
      );
    const hellos = await daemonIn(
      home,
      long ? daemonSocketPath(obHome) : undefined,
    );
    // The server's parent is this process: make it the Claude session.
    const sessions = tmp("ob-hs-");
    writeFileSync(
      join(sessions, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "s-home",
        procStart: claudeProcStartOf(process.pid),
        cwd: "/",
      }),
    );
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN],
        cwd: tmp("ob-hc-"),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          OA_BUS_HOME: obHome,
          OA_BUS_CLAUDE_SESSIONS_DIR: sessions,
        },
        stderr: "ignore",
      }),
    );
    cleanup.push(() => client.close());
    await client.callTool({ name: "list_agents", arguments: {} });
    expect(hellos).toEqual(["s-home"]);
  });
});
