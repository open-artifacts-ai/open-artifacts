import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAD_TEMPLATE_MAX_BYTES } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  type LeadTemplateResult,
  leadsDir,
  listLeadTemplateNames,
  loadLeadTemplate,
} from "../src/leads/templates.ts";
import type { GroupCheck } from "../src/own-file.ts";

/** The process's own group, standing as private: the fixtures' mode then depends on no umask. */
const PRIVATE: GroupCheck = { gid: process.getgid?.(), isPrivate: () => true };
const SHARED: GroupCheck = { gid: process.getgid?.(), isPrivate: () => false };
const HUB = "https://artifacts.example.com";
const BRIEF = `${HUB}/a/cZ3zRk6KxsHAc5tz`;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oa-leads-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const wt = join(root, "wt");
  const bin = join(root, "claude");
  for (const d of [home, repo, wt]) mkdirSync(d);
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  chmodSync(home, 0o700);
  const dir = leadsDir(home);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const tpl = {
    harness: "claude-code",
    binary: bin,
    repo,
    worktree: "new",
    worktree_root: wt,
    role_name: "OA Docs",
    brief: BRIEF,
    model: "opus",
    permission_cap: "ask",
  };
  const write = (name: string, v: unknown, mode = 0o600) => {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
    chmodSync(f, mode);
    return f;
  };
  const load = (
    name: string,
    over: { uid?: number | undefined; group?: GroupCheck } = {},
  ) =>
    loadLeadTemplate(name, { home, hubOrigin: HUB, group: PRIVATE, ...over });
  return { root, home, repo, wt, bin, dir, tpl, write, load };
}
const why = (r: LeadTemplateResult) =>
  r.state === "refused" ? r.why : `(${r.state})`;

describe("loading a lead template", () => {
  it("loads a good template and hashes the validated form", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    const r = await s.load("docs");
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.template.role_name).toBe("OA Docs");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    // The same template in another key order and layout hashes the same.
    s.write(
      "docs2",
      JSON.stringify(
        Object.fromEntries(Object.entries(s.tpl).reverse()),
        null,
        2,
      ),
    );
    const r2 = await s.load("docs2");
    expect(r2.state === "ok" && r2.hash).toBe(r.hash);
    // Any change to a value changes it.
    s.write("docs3", { ...s.tpl, permission_cap: "edits" });
    const r3 = await s.load("docs3");
    expect(r3.state === "ok" && r3.hash).not.toBe(r.hash);
  });

  it("is none when the folder or the file is missing", async () => {
    const s = setup();
    expect((await s.load("nope")).state).toBe("none");
    const bare = mkdtempSync(join(tmpdir(), "oa-leads-bare-"));
    expect(
      (await loadLeadTemplate("x", { home: bare, hubOrigin: HUB })).state,
    ).toBe("none");
  });

  it.each(["command", "args", "env", "shell", "unknown_key"])(
    "refuses the key %s",
    async (k) => {
      const s = setup();
      s.write("docs", { ...s.tpl, [k]: "x" });
      const r = await s.load("docs");
      expect(r.state).toBe("refused");
    },
  );

  it("refuses __proto__ and invalid JSON", async () => {
    const s = setup();
    s.write(
      "p",
      `{"__proto__":{"command":"x"},${JSON.stringify(s.tpl).slice(1)}`,
    );
    expect((await s.load("p")).state).toBe("refused");
    s.write("j", "{nope");
    expect(why(await s.load("j"))).toBe("is not valid JSON");
    s.write("arr", "[]");
    expect((await s.load("arr")).state).toBe("refused");
  });

  it.each(["bypassPermissions", "dangerously-skip-permissions", "yolo"])(
    "refuses the bypass-like cap %s",
    async (cap) => {
      const s = setup();
      s.write("docs", { ...s.tpl, permission_cap: cap });
      expect((await s.load("docs")).state).toBe("refused");
    },
  );

  it("refuses a symlinked file, even to a good template", async () => {
    const s = setup();
    const real = s.write("real", s.tpl);
    symlinkSync(real, join(s.dir, "link.json"));
    expect(why(await s.load("link"))).toMatch(/symlink/);
  });

  it("refuses a FIFO without hanging", async () => {
    const s = setup();
    execFileSync("mkfifo", [join(s.dir, "fifo.json")]);
    const r = await s.load("fifo");
    expect(r.state).toBe("refused");
    expect(why(r)).toMatch(/not a regular file/);
  });

  it("refuses another user's file", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    const uid = process.getuid?.() ?? 0;
    expect(why(await s.load("docs", { uid: uid + 1 }))).toMatch(/another user/);
  });

  it.each([
    [0o660, "group"],
    [0o620, "group"],
    [0o606, "world"],
    [0o666, "everyone"],
  ])("refuses a file with mode %o (%s-writable)", async (mode) => {
    const s = setup();
    s.write("docs", s.tpl, mode);
    expect(why(await s.load("docs"))).toMatch(/writable by others/);
  });

  it("does not relax for a private group: no allowGroupWrite here", async () => {
    const s = setup();
    s.write("docs", s.tpl, 0o664);
    expect((await s.load("docs")).state).toBe("refused");
  });

  it("refuses a leads folder that is a symlink or open to others", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    chmodSync(s.dir, 0o770);
    expect(why(await s.load("docs"))).toMatch(
      /folder is writable by others: run chmod 700 /,
    );
    chmodSync(s.dir, 0o700);
    expect((await s.load("docs")).state).toBe("ok");

    const t = setup();
    const elsewhere = join(t.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(join(elsewhere, "docs.json"), JSON.stringify(t.tpl), {
      mode: 0o600,
    });
    execFileSync("rm", ["-r", t.dir]);
    symlinkSync(elsewhere, t.dir);
    expect(why(await t.load("docs"))).toMatch(/folder is a symlink/);
  });

  it("refuses an oversize file unread", async () => {
    const s = setup();
    s.write(
      "big",
      JSON.stringify({ ...s.tpl, model: "x".repeat(LEAD_TEMPLATE_MAX_BYTES) }),
    );
    expect(why(await s.load("big"))).toMatch(/too large/);
  });

  it.each(["../docs", "..", "a/b", "config", ".x", "a\0b", ""])(
    "refuses the template name %j",
    async (name) => {
      const s = setup();
      // A real template outside the folder, reachable only by traversal.
      writeFileSync(join(s.home, "docs.json"), JSON.stringify(s.tpl), {
        mode: 0o600,
      });
      const r = await s.load(name);
      expect(r.state).toBe("refused");
    },
  );

  it.each(["relative/repo", "../repo", "/a/../b"])(
    "refuses the repo %j",
    async (repo) => {
      const s = setup();
      s.write("docs", { ...s.tpl, repo });
      expect((await s.load("docs")).state).toBe("refused");
    },
  );

  it("refuses a repo given through a symlink, and one that is missing", async () => {
    const s = setup();
    const alias = join(s.root, "alias");
    symlinkSync(s.repo, alias);
    s.write("docs", { ...s.tpl, repo: alias });
    expect(why(await s.load("docs"))).toMatch(/repo is not its own real path/);
    s.write("docs", { ...s.tpl, repo: join(s.root, "gone") });
    expect(why(await s.load("docs"))).toMatch(/repo does not exist/);
    // The worktree root is held to the same rule.
    s.write("docs", { ...s.tpl, worktree_root: alias });
    expect(why(await s.load("docs"))).toMatch(/worktree_root is not its own/);
  });

  it("refuses a folder named to run a command in tmux, and never runs it", async () => {
    const s = setup();
    const evil = join(s.root, "#(touch pwned)");
    mkdirSync(evil);
    s.write("docs", { ...s.tpl, repo: evil });
    expect((await s.load("docs")).state).toBe("refused");
    expect(existsSync(join(s.root, "pwned"))).toBe(false);
    expect(existsSync("pwned")).toBe(false);
  });

  it("refuses the root, a world-writable folder, and another user's", async () => {
    const s = setup();
    s.write("docs", { ...s.tpl, repo: "/" });
    expect(why(await s.load("docs"))).toMatch(
      /repo: must not be the root folder/,
    );
    s.write("docs", s.tpl);
    chmodSync(s.repo, 0o757);
    expect(why(await s.load("docs"))).toMatch(
      /repo is writable by everyone: run chmod 700 /,
    );
    chmodSync(s.repo, 0o700);
    chmodSync(s.wt, 0o777);
    expect(why(await s.load("docs"))).toMatch(
      /worktree_root is writable by everyone/,
    );
    chmodSync(s.wt, 0o700);
    expect((await s.load("docs")).state).toBe("ok");
    const uid = process.getuid?.() ?? 0;
    expect(why(await s.load("docs", { uid: uid + 1 }))).toMatch(/another user/);
  });

  it("allows group-write (775) in the process's own private group", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    chmodSync(s.repo, 0o775);
    chmodSync(s.wt, 0o775);
    expect((await s.load("docs", { group: PRIVATE })).state).toBe("ok");
  });

  it("refuses group-write (775) in a shared group, saying how to fix it", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    chmodSync(s.repo, 0o775);
    expect(why(await s.load("docs", { group: SHARED }))).toBe(
      `repo is writable by a group others share: run chmod 700 ${s.repo}`,
    );
    chmodSync(s.repo, 0o700);
    chmodSync(s.wt, 0o775);
    expect(why(await s.load("docs", { group: SHARED }))).toMatch(
      /worktree_root is writable by a group others share: run chmod 700 /,
    );
  });

  it("refuses group-write when the folder's group is not the process's own", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    chmodSync(s.repo, 0o775);
    const other: GroupCheck = {
      gid: (process.getgid?.() ?? 0) + 1,
      isPrivate: () => true,
    };
    expect(why(await s.load("docs", { group: other }))).toMatch(
      /repo is writable by a group others share/,
    );
  });

  it("a folder with no group-write is fine in any group", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    chmodSync(s.repo, 0o755);
    chmodSync(s.wt, 0o755);
    expect((await s.load("docs", { group: SHARED })).state).toBe("ok");
  });

  it("refuses a binary that is not named for its harness, such as /bin/sh", async () => {
    const s = setup();
    s.write("docs", { ...s.tpl, binary: "/bin/sh" });
    expect((await s.load("docs")).state).toBe("refused");
    s.write("docs", { ...s.tpl, harness: "codex" });
    expect((await s.load("docs")).state).toBe("refused");
  });

  it("refuses a binary owned by another user other than root", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    const uid = process.getuid?.() ?? 0;
    // The file is ours (uid), so claiming to be uid+1 makes it foreign; root-owned would pass.
    expect(why(await s.load("docs", { uid: uid + 1 }))).toMatch(/another user/);
  });

  it("refuses a binary that is group-writable, missing or not executable", async () => {
    const s = setup();
    chmodSync(s.bin, 0o775);
    s.write("docs", s.tpl);
    expect(why(await s.load("docs"))).toMatch(/binary is writable by others/);
    chmodSync(s.bin, 0o644);
    expect(why(await s.load("docs"))).toMatch(/not executable/);
    s.write("docs", { ...s.tpl, binary: join(s.root, "gone", "claude") });
    expect(why(await s.load("docs"))).toMatch(/binary does not exist/);
  });

  it.each([
    "file:///etc/passwd",
    "https://evil.example.net/a/cZ3zRk6KxsHAc5tz",
    "http://artifacts.example.com/a/cZ3zRk6KxsHAc5tz",
    "https://artifacts.example.com:8443/a/cZ3zRk6KxsHAc5tz",
    "https://artifacts.example.com.evil.net/a/cZ3zRk6KxsHAc5tz",
  ])("refuses the brief %s", async (brief) => {
    const s = setup();
    s.write("docs", { ...s.tpl, brief });
    expect((await s.load("docs")).state).toBe("refused");
  });

  it("refuses a brief on another host than this machine's hub", async () => {
    const s = setup();
    s.write("docs", {
      ...s.tpl,
      brief: "https://other.example.org/a/cZ3zRk6KxsHAc5tz",
    });
    expect(why(await s.load("docs"))).toMatch(/not on this machine's hub/);
  });

  it.each(["OpenBus", "open-bus", "OPEN BUS"])(
    "refuses the reserved role name %s",
    async (role_name) => {
      const s = setup();
      s.write("docs", { ...s.tpl, role_name });
      expect((await s.load("docs")).state).toBe("refused");
    },
  );

  it("never echoes control characters from a hostile key into the reason", async () => {
    const s = setup();
    s.write("docs", { ...s.tpl, "\u001b[31mred\u0007": 1 });
    const r = await s.load("docs");
    expect(r.state).toBe("refused");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
    expect(why(r)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("where templates come from", () => {
  it("only from <home>/leads: a template in a repo is never found", async () => {
    const s = setup();
    mkdirSync(join(s.repo, "leads"));
    writeFileSync(join(s.repo, "leads", "docs.json"), JSON.stringify(s.tpl), {
      mode: 0o600,
    });
    writeFileSync(join(s.repo, "docs.json"), JSON.stringify(s.tpl), {
      mode: 0o600,
    });
    expect((await s.load("docs")).state).toBe("none");
    expect(listLeadTemplateNames(s.home)).toEqual([]);
  });

  it("a repo's .oa-bus.json with template keys changes nothing", async () => {
    const s = setup();
    s.write("docs", s.tpl);
    const before = await s.load("docs");
    writeFileSync(
      join(s.repo, ".oa-bus.json"),
      JSON.stringify({
        ...s.tpl,
        harness: "codex",
        permission_cap: "edits",
        role_name: "Evil",
        leads: { docs: { ...s.tpl, permission_cap: "edits" } },
      }),
    );
    const after = await s.load("docs");
    expect(after).toEqual(before);
    expect(after.state === "ok" && after.template.permission_cap).toBe("ask");
    // And without a file in <home>/leads there is nothing to start from.
    expect((await s.load("evil")).state).toBe("none");
  });

  it("lists template names, bad names included, never config.json", () => {
    const s = setup();
    s.write("b", s.tpl);
    s.write("a", s.tpl);
    s.write("config", { enabled: true });
    s.write("not a name", s.tpl);
    writeFileSync(join(s.dir, "notes.txt"), "x");
    expect(listLeadTemplateNames(s.home)).toEqual(["a", "b", "not a name"]);
  });
});
