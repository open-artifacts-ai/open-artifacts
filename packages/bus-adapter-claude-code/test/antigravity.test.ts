// agy S2: the MCP server agy runs speaks for the conversation its hook last
// reported for the agy process above it. A fake process table and a scratch
// bus home only: no real agy runs.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hello } from "@oa/bus-ipc";
import { describe, expect, it } from "vitest";
import {
  AGY_NOT_JOINED,
  agyHello,
  agyStateDir,
  agyTitle,
  antigravityServer,
  findAgy,
  NOT_UNDER_AGY,
  nameFromTitle,
  type Proc,
  parseSessionStart,
  readAgyConversation,
  writeAgyConversation,
} from "../src/antigravity.ts";
import { TOOLS } from "../src/tools.ts";

const REF = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";

/** sh (300) under agy (200) under zsh (100); 400 is our server, under agy. */
const TABLE: Record<number, { ppid: number; name: string }> = {
  100: { ppid: 1, name: "-zsh" },
  200: { ppid: 100, name: "/Users/u/.local/bin/agy" },
  300: { ppid: 200, name: "/bin/sh" },
  400: { ppid: 200, name: "node" },
};
const proc: Proc = (pid) => TABLE[pid] ?? null;

const home = () => mkdtempSync(join(tmpdir(), "ob-agy-"));
const conv = { pid: 200, procStart: "t0", conversationId: REF, cwd: "/w" };

async function connected(
  deps: Parameters<typeof antigravityServer>[0],
): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await antigravityServer(deps).connect(a);
  const client = new Client({ name: "agy", version: "1.5.17" });
  await client.connect(b);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { text: string }[])[0]?.text;

describe("findAgy", () => {
  it("walks the parent chain to the nearest agy", () => {
    expect(findAgy(300, proc)).toBe(200);
    expect(findAgy(400, proc)).toBe(200);
    expect(findAgy(200, proc)).toBe(200);
  });

  it("finds none above a process agy did not start", () => {
    expect(findAgy(100, proc)).toBeUndefined();
    expect(findAgy(999, proc)).toBeUndefined();
  });

  it("stops at a loop in the table", () => {
    expect(findAgy(5, () => ({ ppid: 5, name: "x" }))).toBeUndefined();
  });
});

describe("parseSessionStart", () => {
  it("reads conversationId, cwd and workspacePaths", () => {
    const p = parseSessionStart(
      JSON.stringify({
        conversationId: REF,
        cwd: "/w/app",
        workspacePaths: ["/w", "rel"],
        transcriptPath: "/t",
        hookEventName: "SessionStart",
      }),
    );
    expect(p).toEqual({
      conversationId: REF,
      cwd: "/w/app",
      workspacePaths: ["/w"],
    });
  });

  it("falls back to the first workspace for the cwd", () => {
    expect(
      parseSessionStart(
        JSON.stringify({ conversationId: REF, workspacePaths: ["/w"] }),
      )?.cwd,
    ).toBe("/w");
  });

  it("refuses a payload without a conversation or a folder", () => {
    expect(parseSessionStart("not json")).toBeUndefined();
    expect(parseSessionStart("[]")).toBeUndefined();
    expect(parseSessionStart(JSON.stringify({ cwd: "/w" }))).toBeUndefined();
    expect(
      parseSessionStart(JSON.stringify({ conversationId: REF, cwd: "rel" })),
    ).toBeUndefined();
  });
});

describe("the conversation record", () => {
  it("round-trips, 0600, and drops records of agy processes that are gone", () => {
    const h = home();
    writeAgyConversation(h, { ...conv, pid: 777 }, () => true);
    writeAgyConversation(h, conv, (pid) => pid !== 777);
    expect(readAgyConversation(h, 200)).toEqual(conv);
    expect(statSync(join(agyStateDir(h), "200.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(agyStateDir(h))).toEqual(["200.json"]);
  });

  it("is never read through a symlink, nor for another pid", () => {
    const h = home();
    mkdirSync(agyStateDir(h), { recursive: true });
    const elsewhere = join(h, "x.json");
    writeFileSync(elsewhere, JSON.stringify(conv));
    symlinkSync(elsewhere, join(agyStateDir(h), "200.json"));
    expect(readAgyConversation(h, 200)).toBeUndefined();
    writeFileSync(join(agyStateDir(h), "201.json"), JSON.stringify(conv));
    expect(readAgyConversation(h, 201)).toBeUndefined();
  });
});

describe("names", () => {
  it("makes a bus name of a title, else none", () => {
    expect(nameFromTitle("Fix the Login Bug!")).toBe("fix-the-login-bug");
    expect(nameFromTitle("")).toBeUndefined();
    expect(nameFromTitle("?")).toBeUndefined();
  });

  it("reads agy's title read-only, and none when the store is missing", async () => {
    const db = join(home(), "conversation_summaries.db");
    const w = new DatabaseSync(db);
    w.exec(
      "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '')",
    );
    w.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(
      REF,
      "Bus check",
    );
    w.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(
      "other",
      "",
    );
    w.close();
    expect(await agyTitle(REF, db)).toBe("Bus check");
    expect(await agyTitle("other", db)).toBeUndefined();
    expect(await agyTitle(REF, join(home(), "none.db"))).toBeUndefined();
  });

  it("proposes agy until a title is known", () => {
    expect(agyHello(conv)).toMatchObject({
      kind: "antigravity",
      agent_ref: REF,
      pid: 200,
      cwd: "/w",
      proposed_name: "agy",
      attest: { proc_start: "t0" },
    });
    expect(agyHello({ ...conv, name: "bus-check" })?.proposed_name).toBe(
      "bus-check",
    );
  });
});

describe("oa-bus mcp antigravity", () => {
  const unused = () => Promise.reject(new Error("unused"));

  it("lists the bus tools", async () => {
    const client = await connected({
      busHome: home,
      procStart: () => "t0",
      connect: unused,
      proc,
      ppid: 200,
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    await client.close();
  });

  it("says hello for the conversation the hook last reported for its agy", async () => {
    const h = home();
    writeAgyConversation(h, conv);
    const hellos: Hello[] = [];
    const client = await connected({
      busHome: () => h,
      procStart: () => "t0",
      connect: (hello) => {
        hellos.push(hello);
        return Promise.reject(new Error("daemon down"));
      },
      proc,
      ppid: 200,
    });
    const r = await client.callTool({ name: "self", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("daemon down");
    expect(hellos[0]).toMatchObject({
      kind: "antigravity",
      agent_ref: REF,
      pid: 200,
      attest: { proc_start: "t0" },
    });
    // A /clear: the hook reports the new conversation, the next call uses it.
    const next = "5d1c9e2a-3b4f-4a6d-8e7f-0a1b2c3d4e5f";
    writeAgyConversation(h, { ...conv, conversationId: next });
    await client.callTool({ name: "self", arguments: {} });
    expect(hellos[1]?.agent_ref).toBe(next);
    await client.close();
  });

  it("refuses a server no agy started", async () => {
    const client = await connected({
      busHome: home,
      procStart: () => "t0",
      connect: unused,
      proc,
      ppid: 100,
    });
    const r = await client.callTool({ name: "list_agents", arguments: {} });
    expect(textOf(r)).toBe(NOT_UNDER_AGY);
    await client.close();
  });

  it("is not joined before the hook ran, or when the pid was reused", async () => {
    const h = home();
    let start = "t0";
    const client = await connected({
      busHome: () => h,
      procStart: () => start,
      connect: unused,
      proc,
      ppid: 200,
    });
    let r = await client.callTool({ name: "self", arguments: {} });
    expect(textOf(r)).toBe(AGY_NOT_JOINED);
    writeAgyConversation(h, conv);
    start = "t1";
    r = await client.callTool({ name: "self", arguments: {} });
    expect(textOf(r)).toBe(AGY_NOT_JOINED);
    await client.close();
  });
});
