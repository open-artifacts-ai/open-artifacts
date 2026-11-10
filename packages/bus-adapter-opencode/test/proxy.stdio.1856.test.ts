// The proxy as OpenCode runs it: a stdio MCP server in front of the instance.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_META } from "../src/tools.ts";

const ENTRY = fileURLToPath(new URL("../src/proxy-main.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("opencode proxy over stdio", () => {
  it("lists and calls through to /mcp with the token file, and no proof without a daemon", async () => {
    const seen: { method: string; auth?: string; proof?: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const m = JSON.parse(body) as { id: number; method: string };
        seen.push({
          method: m.method,
          auth: req.headers.authorization,
          proof: req.headers[LINK_PROOF_HEADER.toLowerCase()] as
            | string
            | undefined,
        });
        const result =
          m.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "x", version: "1" },
                instructions: "use me well",
              }
            : m.method === "tools/list"
              ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "pong" }] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    cleanup.push(() => new Promise((r) => server.close(() => r())));
    const instance = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "ob-px-"));
    const tokenFile = join(dir, "pat-token");
    writeFileSync(tokenFile, "file-token-value\n");
    // `opencode api` cannot answer here: the session is unknown, so the call is unlinked.
    writeFileSync(join(dir, "opencode"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "opencode"), 0o755);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-transform-types",
          "-e",
          `import(${JSON.stringify(ENTRY)}).then((m) => m.startProxy(${JSON.stringify({ instance, tokenFile })}))`,
        ],
        env: {
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          HOME: dir,
          OA_BUS_HOME: join(dir, "none"),
        },
        stderr: "ignore",
      }),
    );
    cleanup.push(() => client.close());
    expect(client.getInstructions()).toBe("use me well");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "ping",
    ]);
    const r = await client.callTool({
      name: "ping",
      arguments: {},
      _meta: { [SESSION_META]: "ses_none" },
    });
    expect(r.content).toEqual([{ type: "text", text: "pong" }]);
    expect(seen.map((s) => s.method)).toEqual([
      "initialize",
      "tools/list",
      "tools/call",
    ]);
    expect(seen.every((s) => s.auth === "Bearer file-token-value")).toBe(true);
    // No OpenCode and no daemon here: the call works, unlinked.
    expect(seen.every((s) => s.proof === undefined)).toBe(true);
  });
});
