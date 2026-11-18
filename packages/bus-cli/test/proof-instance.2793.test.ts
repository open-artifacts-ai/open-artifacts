// #2793 S4: one sign-in proof per instance. A scratch HOME holds a fake
// ~/.claude.json; nothing real is read or written. The daemon half (a proof
// binds only on its own hub) is in packages/bus-daemon/test.
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInstance } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { add } from "../src/commands/add.ts";
import { mcpProof, type ProofDeps } from "../src/commands/mcp-proof.ts";
import { parse } from "../src/index.ts";
import { type AdapterDeps, installAdapters } from "../src/steps/adapters.ts";
import {
  helperInstance,
  isProofHelper,
  proofHelper,
} from "../src/steps/claude-proof.ts";
import {
  claudeProofChecks,
  instanceProofChecks,
} from "../src/steps/claude-proof-check.ts";
import { CODE, fakeCtx, TOKEN } from "./fake.ts";

const MAIN = "https://main.example.com";
const B = "https://b.example.com";
const BIN = "/usr/local/bin/oa-bus";
const MAIN_TOKEN = `oa_machine_${"c".repeat(28)}7f3a`;

const tree: Record<number, { ppid: number; name: string }> = {
  50: { ppid: 40, name: "sh" },
  40: { ppid: 30, name: "claude" },
  30: { ppid: 1, name: "zsh" },
};
const proofDeps = (over: Partial<ProofDeps> = {}): ProofDeps => ({
  proc: (pid) => tree[pid] ?? null,
  link: async () => true,
  random: () => Buffer.alloc(32, 7),
  ppid: 50,
  ...over,
});
const PROOF = Buffer.alloc(32, 7).toString("base64url");
const HASH = createHash("sha256").update(PROOF).digest("hex");

describe("oa-bus mcp-proof --instance", () => {
  it("parses the flag; without it the command is as it was", () => {
    expect(parse(["mcp-proof", "--instance", "b"])).toMatchObject({
      cmd: "mcp-proof",
      instance: "b",
    });
    expect(parse(["mcp-proof"])).not.toHaveProperty("instance");
  });

  it("tells the daemon the instance with the hash, never the proof", async () => {
    const link = vi.fn(async () => true);
    const ctx = fakeCtx();
    await mcpProof({ instance: "b" }, ctx, proofDeps({ link }));
    expect(link).toHaveBeenCalledWith(40, HASH, "b");
    expect(JSON.parse(ctx.raw())).toEqual({ "X-OA-Agent-Proof-Token": PROOF });
  });

  it("no flag, or main, is today's call exactly", async () => {
    for (const opts of [{}, { instance: "main" }]) {
      const link = vi.fn(async () => true);
      await mcpProof(opts, fakeCtx(), proofDeps({ link }));
      expect(link.mock.calls).toEqual([[40, HASH]]);
    }
  });

  it("a name that is not a valid instance name mints nothing and is not main", async () => {
    const link = vi.fn(async () => true);
    const ctx = fakeCtx();
    await mcpProof({ instance: "B/../x" }, ctx, proofDeps({ link }));
    expect(link).not.toHaveBeenCalled();
    expect(JSON.parse(ctx.raw())).toEqual({});
  });
});

describe("the --instance helper form", () => {
  it("is one of ours and names its instance", () => {
    const h = proofHelper([BIN], { instance: "b" });
    expect(h).toBe(`${BIN} mcp-proof --instance b`);
    expect(isProofHelper(h)).toBe(true);
    expect(helperInstance(h)).toBe("b");
    expect(helperInstance(proofHelper([BIN], {}))).toBeUndefined();
    const t = proofHelper([BIN], { instance: "b", tokenFile: "/t" });
    expect(helperInstance(t)).toBe("b");
  });
});

const claudeJson = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      numStartups: 3,
      mcpServers: {
        "open-artifacts": { type: "http", url: `${MAIN}/mcp` },
        "open-artifacts-b": { type: "http", url: `${B}/mcp` },
        other: { type: "stdio", command: "x" },
        elsewhere: { type: "http", url: "https://else.example.com/mcp" },
      },
      projects: {
        "/work/p": {
          hasTrustDialogAccepted: true,
          mcpServers: { b2: { type: "http", url: `${B}/mcp/` } },
        },
      },
      ...over,
    },
    null,
    2,
  )}\n`;

const approval = (host: string) =>
  vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/bus/device"))
      return Response.json({
        device_code: "d".repeat(43),
        user_code: CODE,
        verification_uri: `${host}/bus/approve`,
        expires_in: 600,
        interval: 5,
      });
    return Response.json({ status: "approved", machine_token: TOKEN });
  }) as unknown as typeof fetch;

function world(json: string | undefined) {
  const ctx = fakeCtx({ fetch: approval(B), stdinIsTTY: true }, true);
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({ hub: MAIN, label: "m", machine_token: MAIN_TOKEN }),
    { mode: 0o600 },
  );
  const file = join(ctx.userHome, ".claude.json");
  if (json !== undefined) writeFileSync(file, json);
  return { ctx, file, read: () => readFileSync(file, "utf8") };
}
const parsed = (t: string) =>
  JSON.parse(t) as {
    mcpServers: Record<string, { headersHelper?: string }>;
    projects: Record<
      string,
      { mcpServers: Record<string, { headersHelper?: string }> }
    >;
  };

describe("oa-bus add sets the --instance helper", () => {
  it("only in the entries at the new address, at user and local scope", async () => {
    const w = world(claudeJson());
    const before = parsed(w.read());
    expect(await add({ address: B, name: "b", noOpen: true }, w.ctx)).toBe(0);
    const after = parsed(w.read());
    const want = "oa-bus mcp-proof --instance b";
    expect(after.mcpServers["open-artifacts-b"]?.headersHelper).toBe(want);
    expect(after.projects["/work/p"]?.mcpServers.b2?.headersHelper).toBe(want);
    // Main's entry, the stdio entry and the other host's are as they were.
    for (const k of ["open-artifacts", "other", "elsewhere"])
      expect(after.mcpServers[k]).toEqual(before.mcpServers[k]);
    expect(w.ctx.out().join("\n")).toContain("2 entries for b");
    // The record keeps the originals for uninstall; main's marker is not set.
    const rec = JSON.parse(
      readFileSync(join(w.ctx.home, "install.json"), "utf8"),
    );
    expect(rec.claudeConfig).toBeUndefined();
    expect(rec.claudeProof).toHaveLength(2);
    expect(statSync(join(w.ctx.home, "install.json")).mode & 0o077).toBe(0);
  });

  it("a symlinked ~/.claude.json stays a symlink and its target gets the helper", async () => {
    const w = world(claudeJson());
    const real = `${w.file}.real`;
    renameSync(w.file, real);
    symlinkSync(real, w.file);
    expect(await add({ address: B, name: "b", noOpen: true }, w.ctx)).toBe(0);
    expect(lstatSync(w.file).isSymbolicLink()).toBe(true);
    expect(
      parsed(readFileSync(real, "utf8")).mcpServers["open-artifacts-b"]
        ?.headersHelper,
    ).toBe("oa-bus mcp-proof --instance b");
  });

  it("a foreign helper is left alone, with the usual note", async () => {
    const text = claudeJson();
    const j = JSON.parse(text);
    j.mcpServers["open-artifacts-b"].headersHelper = "my-own-helper";
    const w = world(`${JSON.stringify(j, null, 2)}\n`);
    const before = w.read();
    expect(await add({ address: B, name: "b", noOpen: true }, w.ctx)).toBe(0);
    expect(parsed(w.read()).mcpServers["open-artifacts-b"]?.headersHelper).toBe(
      "my-own-helper",
    );
    expect(w.ctx.out().join("\n")).toMatch(
      /left the headersHelper of open-artifacts-b \(user scope\).*not one oa-bus knows/,
    );
    // Only the local entry changed.
    expect(w.read()).not.toBe(before);
    expect(
      parsed(w.read()).projects["/work/p"]?.mcpServers.b2?.headersHelper,
    ).toBe("oa-bus mcp-proof --instance b");
  });

  it("another bus's helper is left alone, as claude-proof does today", async () => {
    const j = JSON.parse(claudeJson());
    j.mcpServers["open-artifacts-b"].headersHelper =
      "OA_BUS_HOME=/other/home oa-bus mcp-proof";
    const w = world(`${JSON.stringify(j, null, 2)}\n`);
    await add({ address: B, name: "b", noOpen: true }, w.ctx);
    expect(parsed(w.read()).mcpServers["open-artifacts-b"]?.headersHelper).toBe(
      "OA_BUS_HOME=/other/home oa-bus mcp-proof",
    );
    expect(w.ctx.out().join("\n")).toMatch(
      /belongs to the bus at \/other\/home/,
    );
  });

  it("no matching entry: one line says how to add it, and nothing is written", async () => {
    const j = JSON.parse(claudeJson());
    delete j.mcpServers["open-artifacts-b"];
    delete j.projects;
    const text = `${JSON.stringify(j, null, 2)}\n`;
    const w = world(text);
    expect(await add({ address: B, name: "b", noOpen: true }, w.ctx)).toBe(0);
    expect(w.read()).toBe(text);
    const lines = w.ctx.out().filter((l) => l.startsWith("Claude Code"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "claude mcp add --transport http open-artifacts-b https://b.example.com/mcp",
    );
    expect(lines[0]).not.toContain("—");
  });

  it("no ~/.claude.json at all: the same one line, and no file is created", async () => {
    const w = world(undefined);
    expect(await add({ address: B, name: "b", noOpen: true }, w.ctx)).toBe(0);
    expect(() => readFileSync(w.file)).toThrow();
    expect(w.ctx.out().filter((l) => l.startsWith("Claude Code"))).toHaveLength(
      1,
    );
  });
});

describe("install and doctor with an added instance", () => {
  const deps = (home: string): AdapterDeps => ({
    home,
    env: {},
    hub: MAIN,
    busBin: [BIN],
    assets: { pi: "PI", opencodePlugin: "JS" },
    which: (c) => c === "claude",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });

  it("main-only home: the helper text and the file are exactly what they were", async () => {
    const w = world(claudeJson());
    const before = w.read();
    await installAdapters(deps(w.ctx.userHome));
    const j = JSON.parse(before);
    j.mcpServers["open-artifacts"].headersHelper = `${BIN} mcp-proof`;
    // Only main's entry gained a helper, and it has no --instance in it.
    const after = parsed(w.read());
    expect(after.mcpServers["open-artifacts"]?.headersHelper).toBe(
      `${BIN} mcp-proof`,
    );
    expect(after.mcpServers["open-artifacts-b"]?.headersHelper).toBeUndefined();
    expect(JSON.parse(w.read())).toEqual(j);
    const once = w.read();
    await installAdapters(deps(w.ctx.userHome));
    expect(w.read()).toBe(once);
    expect(w.read()).not.toContain("--instance");
  });

  it("with an instance added: install links its entries too, and a second run changes nothing", async () => {
    const w = world(claudeJson());
    saveInstance(
      { name: "b", hub: B, machine_id: "", label: "m", machine_token: TOKEN },
      w.ctx.home,
    );
    await installAdapters(deps(w.ctx.userHome));
    const a = parsed(w.read());
    expect(a.mcpServers["open-artifacts"]?.headersHelper).toBe(
      `${BIN} mcp-proof`,
    );
    expect(a.mcpServers["open-artifacts-b"]?.headersHelper).toBe(
      `${BIN} mcp-proof --instance b`,
    );
    const once = w.read();
    await installAdapters(deps(w.ctx.userHome));
    expect(w.read()).toBe(once);
  });

  it("doctor checks each added instance's entries; main's lines are unchanged", async () => {
    const w = world(claudeJson());
    saveInstance(
      { name: "b", hub: B, machine_id: "", label: "m", machine_token: TOKEN },
      w.ctx.home,
    );
    const mainBefore = claudeProofChecks(w.ctx, MAIN);
    const missing = instanceProofChecks(w.ctx);
    expect(missing.map((c) => c.level)).toEqual(["fail", "fail"]);
    expect(missing[0]?.lines[0]).toMatch(
      /^Claude Code \(b\): the open-artifacts-b entry/,
    );
    await installAdapters(deps(w.ctx.userHome));
    expect(instanceProofChecks(w.ctx).map((c) => c.level)).toEqual([
      "pass",
      "pass",
    ]);
    // A main-form helper on the instance's entry is not good enough.
    const j = JSON.parse(w.read());
    j.mcpServers["open-artifacts-b"].headersHelper = `${BIN} mcp-proof`;
    writeFileSync(w.file, JSON.stringify(j, null, 2));
    expect(instanceProofChecks(w.ctx)[0]).toMatchObject({ level: "fail" });
    // Main's entries are judged on main's address only.
    expect(claudeProofChecks(w.ctx, MAIN)).not.toEqual(mainBefore);
    expect(
      claudeProofChecks(w.ctx, MAIN).every((c) => c.level !== "fail"),
    ).toBe(true);
  });

  it("a home with only main has no instance checks", () => {
    const w = world(claudeJson());
    expect(instanceProofChecks(w.ctx)).toEqual([]);
  });
});
