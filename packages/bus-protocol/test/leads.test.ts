import { describe, expect, it } from "vitest";
import {
  BusConfigSchema,
  briefOrigin,
  canonicalLeadTemplate,
  LEAD_PERMISSION_CAPS,
  LeadTemplateNameSchema,
  LeadTemplateSchema,
  leadTemplateHash,
  permissionWithin,
} from "../src/index.ts";

const base = {
  harness: "claude-code",
  binary: "/home/x/.local/bin/claude",
  repo: "/home/x/code/open-artifacts",
  worktree: "new",
  worktree_root: "/home/x/code",
  role_name: "OA Docs",
  brief: "https://artifacts.example.com/a/cZ3zRk6KxsHAc5tz",
  model: "opus",
  permission_cap: "ask",
};
const ok = (o: unknown) => LeadTemplateSchema.safeParse(o).success;
const withKey = (k: string, v: unknown) => ({ ...base, [k]: v });

describe("lead template schema", () => {
  it("accepts the documented template", () => {
    expect(ok(base)).toBe(true);
  });

  it.each(["command", "args", "env", "shell", "cwd", "flags", "extra"])(
    "refuses the key %s: a template cannot express a command",
    (k) => {
      expect(ok(withKey(k, "x"))).toBe(false);
      expect(ok(withKey(k, ["x"]))).toBe(false);
      expect(ok(withKey(k, { A: "b" }))).toBe(false);
    },
  );

  it("refuses __proto__ as a key, from JSON text as a file would arrive", () => {
    const text = JSON.stringify(base).replace(
      "{",
      '{"__proto__":{"command":"x"},',
    );
    const raw = JSON.parse(text);
    expect(Object.keys(raw)).toContain("__proto__");
    expect(ok(raw)).toBe(false);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it.each([
    "bypassPermissions",
    "dangerously-skip-permissions",
    "yolo",
    "bypass",
    "full",
    "auto",
    "acceptEdits",
    "plan",
    "ASK",
    "",
  ])("refuses the permission cap %j", (cap) => {
    expect(ok(withKey("permission_cap", cap))).toBe(false);
  });

  it("permissionWithin fails closed on an unknown value", () => {
    const within = permissionWithin as (a: string, b: string) => boolean;
    expect(within("bypass", "edits")).toBe(false);
    expect(within("ask", "bypass")).toBe(false);
    expect(within("bypass", "bypass")).toBe(false);
    expect(within("", "")).toBe(false);
    expect(within("read_only", "edits")).toBe(true);
  });

  it("has only read_only, ask and edits, lowest first", () => {
    expect([...LEAD_PERMISSION_CAPS]).toEqual(["read_only", "ask", "edits"]);
    expect(permissionWithin("read_only", "ask")).toBe(true);
    expect(permissionWithin("ask", "ask")).toBe(true);
    expect(permissionWithin("edits", "ask")).toBe(false);
  });

  it.each([
    "relative/repo",
    "./repo",
    "repo",
    "",
    "/home/x/../etc",
    "/home/x/./code",
    "/home//x",
    "/home/x/",
    "/home/x/..",
    "/home/x\0/y",
    "/home/x\n/y",
    "/home\\x",
    `/${"a".repeat(5000)}`,
  ])("refuses the repo path %j", (repo) => {
    expect(ok(withKey("repo", repo))).toBe(false);
  });

  it.each([
    "/home/x/#(touch x)",
    "/home/x/#{pane_id}",
    "/home/x/a#(touch /tmp/x)b/repo",
    "/home/x/$(id)",
    "/home/x/$HOME",
    "/home/x/`id`",
    "/home/x/a|b",
    "/home/x/a;b",
    "/home/x/a&b",
    "/home/x/a(b)",
    "/home/x/a'b",
    '/home/x/a"b',
    "/home/x/a*b",
    "/home/x/a?b",
    "/home/x/~",
    "/home/x/a%b",
    "/home/x/a{b}",
    "/home/x/a<b",
    "/home/x/a!b",
    "/home/x/-rf",
    "/home/x/ lead",
    "/home/x/lead /repo",
    "/home/x/lead ",
    "/home/x/a  ",
    "/home/x/caf\u00e9",
    "/home/x/cafe\u0301",
    "/home/x/a\u200bb",
    "/home/x/a\u202eb",
    "/home/x/\u0430pple",
    "/home/x/a\tb",
  ])(
    "refuses the folder %j: no character tmux or a shell would expand",
    (repo) => {
      expect(ok(withKey("repo", repo))).toBe(false);
      expect(ok(withKey("worktree_root", repo))).toBe(false);
    },
  );

  it("allows letters, digits, dot, underscore, hyphen and inner spaces in a segment", () => {
    expect(
      ok(withKey("repo", "/home/x/My Code/open-artifacts_2.v1/.hidden")),
    ).toBe(true);
  });

  it("refuses the root as a folder", () => {
    expect(ok(withKey("repo", "/"))).toBe(false);
    expect(ok(withKey("worktree_root", "/"))).toBe(false);
  });

  it.each([
    ["claude-code", "/usr/bin/claude", true],
    ["codex", "/usr/local/bin/codex", true],
    ["pi", "/home/x/.local/bin/pi", true],
    ["opencode", "/opt/opencode", true],
    ["claude-code", "/bin/sh", false],
    ["claude-code", "/bin/bash", false],
    ["claude-code", "/usr/bin/env", false],
    ["claude-code", "/usr/bin/codex", false],
    ["codex", "/usr/bin/claude", false],
    ["claude-code", "/home/x/claude/run", false],
    ["claude-code", "/home/x/claude.sh", false],
    ["claude-code", "/", false],
  ])("binary for %s at %s is allowed: %s", (harness, binary, allowed) => {
    expect(ok({ ...base, harness, binary })).toBe(allowed);
  });

  it.each(["binary", "worktree_root"])("applies the same to %s", (k) => {
    expect(ok(withKey(k, "../x"))).toBe(false);
    expect(ok(withKey(k, "/a/../b"))).toBe(false);
  });

  it("requires worktree_root exactly when worktree is new", () => {
    const { worktree_root: _, ...noRoot } = base;
    expect(ok(noRoot)).toBe(false);
    expect(ok({ ...noRoot, worktree: "none" })).toBe(true);
    expect(ok({ ...base, worktree: "none" })).toBe(false);
    expect(ok({ ...base, worktree: "elsewhere" })).toBe(false);
  });

  it.each([
    "file:///etc/passwd",
    "file://artifacts.example.com/a/cZ3zRk6KxsHAc5tz",
    "javascript:alert(1)",
    "ftp://artifacts.example.com/a/cZ3zRk6KxsHAc5tz",
    "https://user:pw@artifacts.example.com/a/cZ3zRk6KxsHAc5tz",
    "https://artifacts.example.com/a/cZ3zRk6KxsHAc5tz?x=1",
    "https://artifacts.example.com/a/cZ3zRk6KxsHAc5tz#frag",
    "https://artifacts.example.com/a/cZ3zRk6KxsHAc5tz/",
    "https://artifacts.example.com/a/short",
    "https://artifacts.example.com/p/cZ3zRk6KxsHAc5tz",
    "https://artifacts.example.com/a/../a/cZ3zRk6KxsHAc5tz",
    "HTTPS://ARTIFACTS.example.com/a/cZ3zRk6KxsHAc5tz",
    "/a/cZ3zRk6KxsHAc5tz",
    "",
  ])("refuses the brief %j", (brief) => {
    expect(ok(withKey("brief", brief))).toBe(false);
  });

  it("gives a brief's origin, for the daemon to compare with the hub's", () => {
    expect(briefOrigin(base.brief)).toBe("https://artifacts.example.com");
    expect(briefOrigin("http://localhost:8787/a/cZ3zRk6KxsHAc5tz")).toBe(
      "http://localhost:8787",
    );
  });

  it.each([
    "OpenBus",
    "open-bus",
    "Open Bus 2",
    "OPENBUS",
    "a@b",
    "x/y",
    "",
    " lead",
  ])("refuses the role name %j (reserved or not a bus name)", (role) => {
    expect(ok(withKey("role_name", role))).toBe(false);
  });

  it("refuses the instance's own sender name as a role name", async () => {
    const { INSTANCE_SENDER_NAME } = await import("../src/meta.ts");
    expect(ok(withKey("role_name", INSTANCE_SENDER_NAME))).toBe(false);
  });

  it("refuses an unknown harness and an odd model", () => {
    expect(ok(withKey("harness", "bash"))).toBe(false);
    expect(ok(withKey("model", "opus --flag"))).toBe(false);
    expect(ok(withKey("model", "-x"))).toBe(false);
    expect(ok(withKey("model", "a".repeat(65)))).toBe(false);
  });

  it("refuses non-objects", () => {
    for (const v of [null, [], "x", 1, [base]]) expect(ok(v)).toBe(false);
  });
});

describe("lead template names", () => {
  it.each(["oa-docs", "docs_1", "A", "a".repeat(64)])("accepts %j", (n) => {
    expect(LeadTemplateNameSchema.safeParse(n).success).toBe(true);
  });
  it.each([
    "",
    "../x",
    "..",
    ".",
    "a/b",
    "a\\b",
    ".hidden",
    "-x",
    "a.json",
    "a b",
    "a\0b",
    "a".repeat(65),
    "config",
    "Config",
    "__proto__x/",
  ])("refuses %j", (n) => {
    expect(LeadTemplateNameSchema.safeParse(n).success).toBe(false);
  });
});

describe("lead template hash", () => {
  const parse = (o: unknown) => LeadTemplateSchema.parse(o);

  it("is stable under key order and spacing", async () => {
    const shuffled = Object.fromEntries(Object.entries(base).reverse());
    const a = await leadTemplateHash(parse(base));
    const b = await leadTemplateHash(parse(shuffled));
    const c = await leadTemplateHash(
      parse(JSON.parse(JSON.stringify(shuffled, null, 4))),
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(canonicalLeadTemplate(parse(shuffled))).toBe(
      canonicalLeadTemplate(parse(base)),
    );
  });

  it("changes with any value, and with an optional key's presence", async () => {
    const h0 = await leadTemplateHash(parse(base));
    const variants: Record<string, unknown>[] = [
      { harness: "codex", binary: "/home/x/codex" },
      { binary: "/home/y/claude" },
      { repo: "/home/x/code/other" },
      { worktree_root: "/home/x/other" },
      { role_name: "OA Docs 2" },
      { brief: "https://artifacts.example.com/a/cZ3zRk6KxsHAc5tZ" },
      { model: "sonnet" },
      { permission_cap: "edits" },
    ];
    const seen = new Set([h0]);
    for (const v of variants)
      seen.add(await leadTemplateHash(parse({ ...base, ...v })));
    const { model: _m, ...noModel } = base;
    seen.add(await leadTemplateHash(parse(noModel)));
    expect(seen.size).toBe(variants.length + 2);
  });
});

describe("a repo's .oa-bus.json grants nothing", () => {
  it("refuses template keys, so a clone cannot carry a template", () => {
    expect(BusConfigSchema.safeParse(base).success).toBe(false);
    expect(
      BusConfigSchema.safeParse({ namespace: "github.com/a/b", ...base })
        .success,
    ).toBe(false);
    for (const k of ["leads", "templates", "lead_templates", "harness"])
      expect(BusConfigSchema.safeParse({ [k]: {} }).success).toBe(false);
  });
});
