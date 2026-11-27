import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BRIEF_RULES, BRIEF_RULES_MAX_BYTES } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { serverOptions } from "../src/rules.ts";
import { createServer } from "../src/server.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

const makeHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-opencode-rules-"));
  dirs.push(dir);
  return dir;
};

async function initializeClient(home: string): Promise<Client> {
  const server = createServer(home);
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "opencode-test", version: "0.1.0" });
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

describe("OpenCode oa_bus serverOptions (#3043)", () => {
  it("passes BRIEF_RULES first and within the byte budget when install.json is absent", () => {
    const home = makeHome();
    const opts = serverOptions(home);
    const leadLine = BRIEF_RULES.split("\n")[0] ?? "";
    expect(opts.instructions).toBe(BRIEF_RULES);
    expect(opts.instructions?.startsWith(leadLine)).toBe(true);
    expect(
      Buffer.byteLength(opts.instructions ?? "", "utf8"),
    ).toBeLessThanOrEqual(BRIEF_RULES_MAX_BYTES);
  });

  it("omits instructions when install.json opts out", () => {
    const home = makeHome();
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ habits: { optedOut: true } }),
      { mode: 0o600 },
    );
    const opts = serverOptions(home);
    expect("instructions" in opts).toBe(false);
    expect(opts.instructions).toBeUndefined();
  });

  it("sends BRIEF_RULES on MCP initialize when enabled and omits it when opted out", async () => {
    const enabledHome = makeHome();
    const enabledClient = await initializeClient(enabledHome);
    expect(enabledClient.getInstructions()).toBe(BRIEF_RULES);

    const optedOutHome = makeHome();
    writeFileSync(
      join(optedOutHome, "install.json"),
      JSON.stringify({ habits: { optedOut: true } }),
      { mode: 0o600 },
    );
    const optedOutClient = await initializeClient(optedOutHome);
    expect(optedOutClient.getInstructions()).toBeUndefined();
  });

  it("picks up changed opt-out state in a fresh server (simulated auto-update)", async () => {
    const home = makeHome();
    const installFile = join(home, "install.json");
    writeFileSync(installFile, JSON.stringify({ habits: { optedOut: true } }), {
      mode: 0o600,
    });
    const before = await initializeClient(home);
    expect(before.getInstructions()).toBeUndefined();

    rmSync(installFile);
    const after = await initializeClient(home);
    expect(after.getInstructions()).toBe(BRIEF_RULES);
  });
});
