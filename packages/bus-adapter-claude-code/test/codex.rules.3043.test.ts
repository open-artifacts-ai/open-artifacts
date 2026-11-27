import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BRIEF_RULES } from "@oa/bus-ipc";
import { afterEach, describe, expect, it } from "vitest";
import { codexServer } from "../src/codex.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

const makeHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-codex-mcp-rules-"));
  dirs.push(dir);
  return dir;
};

async function initializeCodex(busHome: string): Promise<Client> {
  const server = codexServer({
    busHome,
    connect: () =>
      Promise.reject(new Error("connect should not be called on initialize")),
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "codex-mcp-client", version: "0.165.0" });
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex MCP server initialize instructions (#3043)", () => {
  it("sends BRIEF_RULES when rules are enabled", async () => {
    const home = makeHome();
    const client = await initializeCodex(home);
    expect(client.getInstructions()).toBe(BRIEF_RULES);
  });

  it("omits instructions when install.json opts out", async () => {
    const home = makeHome();
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ habits: { optedOut: true } }),
      { mode: 0o600 },
    );
    const client = await initializeCodex(home);
    expect(client.getInstructions()).toBeUndefined();
  });
});
