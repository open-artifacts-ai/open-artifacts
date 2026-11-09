// #1822: the Claude Code half of session links. The helper prints the proof
// header (and the old token Authorization line, never one for OAuth); install
// adds it to the user-scope entry and uninstall puts the bytes back.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CMD } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { mcpProof, type ProofDeps } from "../src/commands/mcp-proof.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { parse } from "../src/index.ts";
import {
  type AdapterDeps,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { HUB as FAKE_HUB, fakeCtx, status, TOKEN as TOKEN_ } from "./fake.ts";

const HUB = "https://oa.example.com";
const BIN = "/usr/local/bin/oa-bus";
const TOKEN_FILE = "~/.open-artifacts/oa-example-com-pat-token";
const TOKEN_HELPER = `T=$(cat ${TOKEN_FILE}) && printf '{"Authorization":"Bearer %s"}' "$T"`;
const SECRET = "oa_pat_NOT_A_REAL_TOKEN";

// Claude's process tree: helper shell -> claude -> tmux.
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

const run = async (tokenFile: string | undefined, deps: ProofDeps) => {
  const ctx = fakeCtx();
  const code = await mcpProof(tokenFile ? { tokenFile } : {}, ctx, deps);
  return { code, out: ctx.raw(), err: ctx.err() };
};
const tokenFile = () => {
  const d = mkdtempSync(join(tmpdir(), "ob-proof-"));
  const f = join(d, "token");
  writeFileSync(f, `${SECRET}\n`);
  return f;
};

describe("oa-bus mcp-proof output", () => {
  it("a token entry gets the proof and its Authorization line", async () => {
    const link = vi.fn(async () => true);
    const f = tokenFile();
    const r = await run(f, proofDeps({ link }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      Authorization: `Bearer ${SECRET}`,
      "X-OA-Agent-Proof-Token": PROOF,
    });
    // The daemon gets the Claude pid (not the shell's) and the hash, never the proof.
    expect(link).toHaveBeenCalledWith(
      40,
      createHash("sha256").update(PROOF).digest("hex"),
    );
    expect(PROOF).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("an OAuth entry gets the proof and never an Authorization line", async () => {
    const r = await run(undefined, proofDeps());
    expect(JSON.parse(r.out)).toEqual({ "X-OA-Agent-Proof-Token": PROOF });
  });

  it("fails open with the daemon down: the old output, exit 0", async () => {
    const down = proofDeps({
      link: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(JSON.parse((await run(tokenFile(), down)).out)).toEqual({
      Authorization: `Bearer ${SECRET}`,
    });
    const oauth = await run(undefined, down);
    expect(oauth.code).toBe(0);
    expect(JSON.parse(oauth.out)).toEqual({});
  });

  it("the real client with no daemon socket also fails open", async () => {
    const ctx = fakeCtx();
    const f = tokenFile();
    const code = await mcpProof({ tokenFile: f }, ctx);
    expect(code).toBe(0);
    expect(JSON.parse(ctx.raw())).toEqual({ Authorization: `Bearer ${SECRET}` });
  });

  it("prints no proof when no Claude process is above it, or the daemon did not bind", async () => {
    const none = await run(undefined, proofDeps({ ppid: 30 }));
    expect(JSON.parse(none.out)).toEqual({});
    const unbound = await run(
      undefined,
      proofDeps({ link: async () => false }),
    );
    expect(JSON.parse(unbound.out)).toEqual({});
  });

  it("a second run makes a new proof", async () => {
    let n = 0;
    const d = proofDeps({ random: () => Buffer.alloc(32, ++n) });
    const a = JSON.parse((await run(undefined, d)).out);
    const b = JSON.parse((await run(undefined, d)).out);
    expect(a["X-OA-Agent-Proof-Token"]).not.toBe(b["X-OA-Agent-Proof-Token"]);
  });

  it("is parsed as a command with its token file", () => {
    expect(parse(["mcp-proof", "--token-file", "/t"])).toMatchObject({
      cmd: "mcp-proof",
      tokenFile: "/t",
    });
    expect(parse(["mcp-proof"])).toMatchObject({ cmd: "mcp-proof" });
  });
});

const setup = (claudeJson: string | undefined) => {
  const h = mkdtempSync(join(tmpdir(), "ob-proof-inst-"));
  const file = join(h, ".claude.json");
  if (claudeJson !== undefined) writeFileSync(file, claudeJson);
  const deps: AdapterDeps = {
    home: h,
    env: {},
    hub: HUB,
    busBin: [BIN],
    assets: { pi: "PI", opencodePlugin: "JS" },
    which: (c) => c === "claude",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { h, file, deps, read: () => readFileSync(file, "utf8") };
};
const entry = (e: object) =>
  `${JSON.stringify({ numStartups: 3, mcpServers: { "open-artifacts": e, other: { type: "stdio", command: "x" } } }, null, 2)}`;
const OAUTH = { type: "http", url: `${HUB}/mcp` };
const TOKEN = { type: "http", url: `${HUB}/mcp`, headersHelper: TOKEN_HELPER };
const helperOf = (text: string) =>
  JSON.parse(text).mcpServers["open-artifacts"].headersHelper as string;

describe("oa-bus install and uninstall, Claude entry", () => {
  for (const [name, e, want] of [
    ["OAuth", OAUTH, `${BIN} mcp-proof`],
    ["token", TOKEN, `${BIN} mcp-proof --token-file ${TOKEN_FILE}`],
  ] as const)
    it(`${name}: install adds the helper, uninstall restores the bytes`, async () => {
      const s = setup(entry(e));
      const original = s.read();
      await installAdapters(s.deps);
      expect(helperOf(s.read())).toBe(want);
      // Nothing else in the file moved.
      expect(JSON.parse(s.read()).numStartups).toBe(3);
      await uninstallAdapters(s.deps);
      expect(s.read()).toBe(original);
    });

  it("a second install is a no-op", async () => {
    for (const e of [OAUTH, TOKEN]) {
      const s = setup(entry(e));
      await installAdapters(s.deps);
      const once = s.read();
      const rec = readFileSync(join(s.h, ".oa-bus/install.json"), "utf8");
      await installAdapters(s.deps);
      expect(s.read()).toBe(once);
      expect(readFileSync(join(s.h, ".oa-bus/install.json"), "utf8")).toBe(rec);
    }
  });

  it("leaves a helper it does not know, and another instance's entry", async () => {
    const custom = entry({ ...OAUTH, headersHelper: "my-own-helper" });
    const s = setup(custom);
    await installAdapters(s.deps);
    expect(s.read()).toBe(custom);
    const other = entry({ type: "http", url: "https://elsewhere.test/mcp" });
    const t = setup(other);
    await installAdapters(t.deps);
    expect(t.read()).toBe(other);
  });

  it("no config file: nothing is created", async () => {
    const s = setup(undefined);
    await installAdapters(s.deps);
    expect(() => readFileSync(s.file)).toThrow();
  });
});

describe("oa-bus status, Claude entry", () => {
  const line = async (e: object | undefined, link: boolean, install = false) => {
    const ctx = fakeCtx({
      status: vi.fn(async () => status(link ? { link: true } : {})),
    });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: FAKE_HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN_,
      }),
    );
    if (e) {
      writeFileSync(join(ctx.userHome, ".claude.json"), entry(e));
      if (install)
        await installAdapters({
          home: ctx.userHome,
          env: {},
          hub: FAKE_HUB,
          busBin: [BIN],
          assets: { pi: "PI", opencodePlugin: "JS" },
          which: (c) => c === "claude",
          exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        });
    }
    await statusCmd(ctx);
    return ctx.out().filter((l) => l.startsWith("Claude Code"));
  };
  const mine = { type: "http", url: `${FAKE_HUB}/mcp` };

  it("says whether the entry has the helper", async () => {
    expect(await line(mine, true, true)).toEqual([
      "Claude Code: shows as yourself on pages.",
    ]);
    expect(await line(mine, true)).toEqual([
      `Claude Code: run ${BUS_CMD} install to show as yourself on pages.`,
    ]);
    expect(await line(undefined, true)).toEqual([]);
  });

  it("an old daemon says to update", async () => {
    expect(await line(mine, false, true)).toEqual([
      "Claude Code: update to show as yourself on pages.",
    ]);
  });
});
