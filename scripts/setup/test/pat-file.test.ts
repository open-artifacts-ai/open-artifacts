import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realFs } from "../src/cf.ts";
import { run } from "../src/index.ts";
import { homeOf, hostSlug, patTokenFile } from "../src/secret-file.ts";
import { agentConfig } from "../src/steps/agent-config.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const HOME = "/home/test";
const FILE = `${HOME}/.open-artifacts/app-example-com-pat-token`;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);

describe("host slug (Backend's secretFile rule)", () => {
  it.each([
    ["staging.open-artifacts.com", "staging-open-artifacts-com"],
    ["Artifacts.Terrazul.com.:8443", "artifacts-terrazul-com-8443"],
    ["xn--bcher-kva.example", "xn-bcher-kva-example"],
    [`${"a".repeat(70)}.example.com`, `${"a".repeat(70)}-example-com`],
    ["...", "instance"],
  ])("%s -> %s", (host, slug) => {
    expect(hostSlug(host)).toBe(slug);
  });
  it("the file lives under ~/.open-artifacts, as an absolute path", () => {
    expect(patTokenFile("/h", "staging.open-artifacts.com")).toBe(
      "/h/.open-artifacts/staging-open-artifacts-com-pat-token",
    );
  });
  it("an unset or empty HOME falls back to the OS home", () => {
    expect(homeOf({})).toBe(homedir());
    expect(homeOf({ HOME: "" })).toBe(homedir());
    expect(homeOf({ HOME: "/x" })).toBe("/x");
  });
});

describe("#2: the minted PAT goes to a file, not stdout", () => {
  const go = async (extra: string[] = []) => {
    const w = world({ env: { HOME } });
    expect(await run([...HOSTS, ...extra], w.deps, ROOT)).toBe(0);
    return w;
  };

  it("writes the 0600 file and reports data.tokenFile, never data.token", async () => {
    const w = await go();
    const d = line(w, "owner-token").data;
    expect(d.tokenFile).toBe(FILE);
    expect(d).not.toHaveProperty("token");
    const pat = (w.files.get(FILE) ?? "").trim();
    expect(pat).toMatch(/^oa_pat_/);
    expect(w.secretWrites).toEqual([FILE]);
    // canary: the token is in the file only
    const hay = [
      ...w.lines,
      ...[...w.files].filter(([k]) => k !== FILE).map(([, v]) => v),
      ...w.argv,
      ...w.prompts,
    ].join("\n");
    expect(hay).not.toContain(pat);
  });

  it("--print-token restores data.token", async () => {
    const w = await go(["--print-token"]);
    const d = line(w, "owner-token").data;
    expect(d.token).toBe((w.files.get(FILE) ?? "").trim());
    expect(d.tokenFile).toBe(FILE);
  });

  it("--ci writes no file and prints no token, even with --print-token", async () => {
    const w = world({ env: { HOME } });
    const ci = [...HOSTS.filter((a) => a !== "--yes"), "--ci", "--print-token"];
    expect(await run(ci, w.deps, ROOT)).toBe(0);
    expect(w.secretWrites).toEqual([]);
    const d = line(w, "owner-token").data;
    expect(d).not.toHaveProperty("token");
    expect(d).not.toHaveProperty("tokenFile");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("#2: snippets never put a token in a command: OAuth clients get only the URL", async () => {
    const w = await go();
    const cfg = line(w, "agent-config").data;
    const pat = (w.files.get(FILE) ?? "").trim();
    const sn = cfg.snippets;
    expect(sn.claudeCode).toBe(
      "claude mcp add --transport http -s user open-artifacts https://app.example.com/mcp",
    );
    expect(JSON.parse(sn.cursor).mcpServers["open-artifacts"]).toEqual({
      url: "https://app.example.com/mcp",
    });
    expect(JSON.parse(sn.opencode).mcp["open-artifacts"]).not.toHaveProperty(
      "headers",
    );
    for (const k of ["claudeCode", "cursor", "opencode"])
      expect(sn[k], k).not.toMatch(/\$\(cat|--header|OA_TOKEN|oa_pat_/);
    expect(JSON.stringify(cfg)).not.toContain(pat);
    expect(JSON.stringify(cfg)).not.toContain("~/.open-artifacts");
    // the token-file fallback is a config reference, with an absolute path
    expect(sn.opencodeToken).toContain(`{file:${FILE}}`);
    expect(sn.opencodeToken).not.toContain("{env:OA_TOKEN}");
  });

  it("#2: Codex is launched with OA_TOKEN from the absolute file; no shell-profile edits", async () => {
    const w = await go();
    const codex = (
      line(w, "agent-config").data.configs as { client: string; note: string }[]
    ).find((c) => c.client === "Codex CLI");
    expect(codex?.note).toContain(`OA_TOKEN="$(cat ${FILE})" codex`);
    expect(codex?.note).toContain("Don't edit shell profiles");
    expect(codex?.note).not.toMatch(/export OA_TOKEN|exported/);
  });

  it("#2: --ci snippets reference no token file", async () => {
    const w = world({ env: { HOME } });
    const ci = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
    expect(await run(ci, w.deps, ROOT)).toBe(0);
    const cfg = line(w, "agent-config").data;
    expect(JSON.stringify(cfg)).not.toContain("pat-token");
    expect(cfg).not.toHaveProperty("tokenFile");
    expect(cfg.snippets).not.toHaveProperty("opencodeToken");
  });

  it("a write failure is an error that names the file, not the token", async () => {
    const w = world({ env: { HOME } });
    w.deps.fs = {
      ...(w.deps.fs as object),
      writeSecret: () => {
        throw new Error("EACCES");
      },
    } as never;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const l = line(w, "owner-token");
    expect(l.message).toContain(FILE);
    expect(l.message).toContain("previous token is unchanged");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });
});

describe("#2: agent-config needs no token", () => {
  it("without a token file it prints the OAuth snippets and says the fallback comes later", async () => {
    const w = world({ env: { HOME } });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.files.delete(FILE);
    w.lines.length = 0;
    expect(await run(HOSTS, w.deps, ROOT, [agentConfig])).toBe(0);
    const cfg = line(w, "agent-config").data;
    expect(cfg.snippets.claudeCode).toBe(
      "claude mcp add --transport http -s user open-artifacts https://app.example.com/mcp",
    );
    expect(cfg.snippets).not.toHaveProperty("opencodeToken");
    expect(cfg).not.toHaveProperty("tokenFile");
    expect(cfg.tokenNote).toMatch(/fallback snippets appear once/);
  });
});

describe("#2: rotation keeps the old token valid until the new file is saved", () => {
  const first = async (w: W) => {
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
  };
  it("a write failure on --new-owner-token leaves the old token valid and its file intact", async () => {
    const w = world({ env: { HOME } });
    await first(w);
    const old = w.files.get(FILE);
    const oldId = w.state().ownerTokenId;
    const fs = w.deps.fs as unknown as { writeSecret: () => void };
    fs.writeSecret = () => {
      throw new Error("ENOSPC");
    };
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(1);
    expect(w.files.get(FILE)).toBe(old);
    expect(w.state().ownerTokenId).toBe(oldId);
    const live = w.db.tokens.filter((t) => !t.revoked_at);
    expect(live.map((t) => t.id)).toEqual([oldId]);
  });
  it("on success the old row is revoked only after the file is written", async () => {
    const w = world({ env: { HOME } });
    await first(w);
    const oldId = w.state().ownerTokenId;
    let revokedAtWrite: boolean | undefined;
    const fs = w.deps.fs as unknown as {
      writeSecret: (p: string, d: string) => void;
    };
    const real = fs.writeSecret;
    fs.writeSecret = (p, d) => {
      revokedAtWrite = Boolean(
        w.db.tokens.find((t) => t.id === oldId)?.revoked_at,
      );
      real(p, d);
    };
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(0);
    expect(revokedAtWrite).toBe(false);
    expect(w.db.tokens.find((t) => t.id === oldId)?.revoked_at).toBeTruthy();
  });
  it("a live row with a missing file is todo, with a note (--check shows it), and a plain rerun re-mints", async () => {
    const w = world({ env: { HOME } });
    await first(w);
    w.files.delete(FILE);
    const check = [...HOSTS.filter((a) => a !== "--yes"), "--check"];
    await run(check, w.deps, ROOT);
    const l = line(w, "owner-token");
    expect(l.status).toBe("todo");
    expect(l.message).toContain(
      "the token file is missing; rerun with --new-owner-token",
    );
    w.lines.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.files.has(FILE)).toBe(true);
  });

  it("#2: a revoke failure is action_required; the rerun retries it, revokes and clears pendingRevokeTokenId", async () => {
    const w = world({ env: { HOME } });
    await first(w);
    const oldId = w.state().ownerTokenId;
    const real = w.deps.exec;
    let failing = true;
    w.deps.exec = async (cmd, args, opts) =>
      failing && args.join(" ").includes("SET revoked_at")
        ? { code: 1, stdout: "", stderr: "D1 down" }
        : real(cmd, args, opts);
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(2);
    const st = w.state();
    expect(st.pendingRevokeTokenId).toBe(st.ownerTokenId);
    expect(w.db.tokens.find((t) => t.id === oldId)?.revoked_at).toBeUndefined();
    failing = false;
    w.lines.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.db.tokens.find((t) => t.id === oldId)?.revoked_at).toBeTruthy();
    expect(w.state().pendingRevokeTokenId).toBeUndefined();
    expect(line(w, "owner-token").message).toContain(
      "revoked the previous owner token",
    );
  });
  it("#2: a failed write whose cleanup revoke also fails names the orphaned id and the dashboard", async () => {
    const w = world({ env: { HOME } });
    await first(w);
    const fs = w.deps.fs as unknown as { writeSecret: () => void };
    fs.writeSecret = () => {
      throw new Error("ENOSPC");
    };
    const real = w.deps.exec;
    w.deps.exec = async (cmd, args, opts) =>
      args.join(" ").includes("SET revoked_at")
        ? { code: 1, stdout: "", stderr: "D1 down" }
        : real(cmd, args, opts);
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(1);
    const l = line(w, "owner-token");
    const orphan = w.db.tokens.at(-1)?.id as string;
    expect(l.message).toContain(orphan);
    expect(l.message).toContain("Settings → Connections");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });
  it("#2: --upgrade with a live row and no file adds the note", async () => {
    const w = world({ env: { HOME } });
    await first(w);
    w.files.delete(FILE);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(line(w, "owner-token").message).toContain(
      `no token file at ${FILE}; pass --new-owner-token if a client needs one`,
    );
  });
});

const docs = (f: string) =>
  readFileSync(
    join(import.meta.dirname, `../../../apps/landing/src/content/docs/${f}`),
    "utf8",
  );

describe("#23: setup.md says never to ask for or paste a token in chat", () => {
  const md = docs("setup.md");
  it("has the chat rule and names the slugged file", () => {
    expect(md).toContain("Never ask for or paste a token in chat.");
    expect(md).toContain("~/.open-artifacts/<host-slug>-pat-token");
    expect(md).toMatch(/every run of other characters/);
  });
});

describe("#22: the docs have no OA_TOKEN export or shell-profile guidance", () => {
  for (const f of ["setup.md", "connect-agents.md"])
    it(f, () => {
      const md = docs(f);
      expect(md).not.toMatch(
        /export OA_TOKEN|read -rs OA_TOKEN|unset OA_TOKEN/,
      );
      expect(md).not.toMatch(
        /exported from the file|start .* from a shell that/i,
      );
      expect(md).not.toMatch(/\.zshrc|\.bashrc|\.profile|export .*>>/);
      expect(md).not.toMatch(/\{env:OA_TOKEN\}|\$\{env:OA_TOKEN\}/);
    });
  it("connect-agents.md puts OAuth first and reads the PAT file for the token variant", () => {
    const md = docs("connect-agents.md");
    expect(md).toContain(
      "claude mcp add --transport http -s user open-artifacts https://artifacts.example.com/mcp",
    );
    expect(md).toContain("{file:<token file>}");
    expect(md).toContain('OA_TOKEN="$(cat <token file>)" codex');
  });
});

describe("realFs.writeSecret", () => {
  it("#2: refuses a symlinked ~/.open-artifacts", () => {
    const d = mkdtempSync(join(tmpdir(), "oa-pat-"));
    const real = join(d, "real");
    mkdirSync(real);
    symlinkSync(real, join(d, ".open-artifacts"));
    expect(() =>
      realFs.writeSecret?.(join(d, ".open-artifacts", "x-pat-token"), "t"),
    ).toThrow(/not a plain directory/);
  });
  it("leaves no temp file behind and keeps the old file when the write fails", () => {
    const d = mkdtempSync(join(tmpdir(), "oa-pat-"));
    const f = join(d, ".open-artifacts", "x-pat-token");
    realFs.writeSecret?.(f, "old\n");
    // a directory in the way of the rename makes it fail after the temp write
    const f2 = join(d, ".open-artifacts", "dir-pat-token");
    mkdirSync(f2);
    expect(() => realFs.writeSecret?.(f2, "new\n")).toThrow();
    expect(readFileSync(f, "utf8")).toBe("old\n");
    expect(
      readdirSync(join(d, ".open-artifacts")).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  const dir = () => mkdtempSync(join(tmpdir(), "oa-pat-"));

  it("creates the directory 0700 and the file 0600", () => {
    const f = join(dir(), ".open-artifacts", "x-pat-token");
    realFs.writeSecret?.(f, "secret\n");
    expect(readFileSync(f, "utf8")).toBe("secret\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(f, "..")).mode & 0o777).toBe(0o700);
  });

  it("replaces an existing file (even a loose or symlinked one) with a fresh 0600 file", () => {
    const d = dir();
    const f = join(d, ".open-artifacts", "x-pat-token");
    mkdirSync(join(d, ".open-artifacts"), { mode: 0o755 });
    const target = join(d, "elsewhere");
    writeFileSync(target, "keep", { mode: 0o644 });
    symlinkSync(target, f);
    realFs.writeSecret?.(f, "new\n");
    expect(lstatSync(f).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readFileSync(f, "utf8")).toBe("new\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, ".open-artifacts")).mode & 0o777).toBe(0o700);
  });
});

describe("#2: the dashboard tab is Settings → Connections", () => {
  const dash = readFileSync(
    join(
      import.meta.dirname,
      "../../../apps/dashboard/src/settings/SettingsLayout.tsx",
    ),
    "utf8",
  );
  it("matches the dashboard's tab label", () => {
    expect(dash).toMatch(/label: "Connections"/);
  });
  it("no setup source or doc says Settings → Tokens", () => {
    for (const f of [
      "scripts/setup/src/index.ts",
      "scripts/setup/src/steps/agent-config.ts",
      "scripts/setup/src/steps/owner-token.ts",
      "apps/landing/src/content/docs/setup.md",
      "apps/landing/src/content/docs/connect-agents.md",
    ])
      expect(
        readFileSync(join(import.meta.dirname, "../../..", f), "utf8"),
        f,
      ).not.toContain("Settings → Tokens");
  });
});
