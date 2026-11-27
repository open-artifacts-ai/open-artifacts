import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexHookOutput } from "../src/commands/rules.ts";
import { parse } from "../src/index.ts";
import {
  codexHookCommand,
  installCodexHook,
  uninstallCodexHook,
} from "../src/steps/codex.ts";

import * as files from "../src/steps/skill.ts";

const dirs: string[] = [];
const makeDir = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-codex-rules-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("oa-bus rules codex-hook (#3043)", () => {
  it("parses rules codex-hook and rejects invalid subcommands", () => {
    expect(parse(["rules", "codex-hook"])).toMatchObject({
      cmd: "rules",
      sub: "codex-hook",
    });
    expect(() => parse(["rules"])).toThrow(/rules codex-hook/);
    expect(() => parse(["rules", "other"])).toThrow(/rules codex-hook/);
    expect(() => parse(["rules", "codex-hook", "extra"])).toThrow(
      /unexpected argument/,
    );
  });

  it("prints the SessionStart JSON with whatever rules the daemon currently answers", async () => {
    const out = await codexHookOutput(async () => "RULES v2");
    expect(out).not.toContain("\n");
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "RULES v2",
      },
    });
  });

  it("prints nothing when opted out (null) or empty", async () => {
    expect(await codexHookOutput(async () => null)).toBe("");
    expect(await codexHookOutput(async () => "")).toBe("");
  });

  it("prints nothing when asking the daemon throws or times out", async () => {
    expect(
      await codexHookOutput(async () => {
        throw new Error("daemon down");
      }),
    ).toBe("");
  });
});

describe("Codex hooks.json management (#3043)", () => {
  const cmd1 = codexHookCommand(["/usr/local/bin/oa-bus"]);
  const cmd2 = codexHookCommand(["/opt/oa/bin/oa-bus"]);

  it("creates a fresh hooks.json with our SessionStart group", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    const r = installCodexHook(file, cmd1);
    expect(r).toEqual({ status: "added" });
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume",
            hooks: [{ type: "command", command: cmd1, timeout: 10 }],
          },
        ],
      },
    });
  });

  it("preserves existing SessionStart hooks and other events", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    const otherGroup = {
      matcher: "startup",
      hooks: [
        {
          type: "command",
          command: "/bin/wrapper rules codex-hook",
          timeout: 5,
        },
      ],
    };
    const before = {
      hooks: {
        SessionStart: [otherGroup],
        Stop: [{ hooks: [{ type: "command", command: "/bin/stop" }] }],
      },
      extra: true,
    };
    writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`);

    const r = installCodexHook(file, cmd1);
    expect(r).toEqual({ status: "added" });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.extra).toBe(true);
    expect(after.hooks.Stop).toEqual(before.hooks.Stop);
    expect(after.hooks.SessionStart).toEqual([
      otherGroup,
      {
        matcher: "startup|resume",
        hooks: [{ type: "command", command: cmd1, timeout: 10 }],
      },
    ]);
  });

  it("is a no-op with no write on re-install when unchanged", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    expect(installCodexHook(file, cmd1)).toEqual({ status: "added" });
    const beforeIno = statSync(file).ino;
    expect(installCodexHook(file, cmd1)).toEqual({ status: "unchanged" });
    expect(statSync(file).ino).toBe(beforeIno);
  });

  it("replaces our hook command in place when the bin path moves", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    expect(installCodexHook(file, cmd1)).toEqual({ status: "added" });
    expect(installCodexHook(file, cmd2)).toEqual({ status: "updated" });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.hooks.SessionStart).toHaveLength(1);
    expect(doc.hooks.SessionStart[0].hooks[0].command).toBe(cmd2);
  });

  it.each(["install", "update"] as const)(
    "recovers an owner write failure on %s and leaves an identical user hook",
    (op) => {
      const dir = makeDir();
      const path = join(dir, "hooks.json");
      const ledger = join(dir, "records");
      mkdirSync(ledger);
      const record = join(ledger, "owner");
      if (op === "update") installCodexHook(path, cmd1, record);
      const write = files.writeAtomic;
      const failure = vi
        .spyOn(files, "writeAtomic")
        .mockImplementation((path, text) => {
          if (path === record) throw new Error("test ownership write failed");
          return write(path, text);
        });
      try {
        expect(() => installCodexHook(path, cmd2, record)).toThrow();
      } finally {
        failure.mockRestore();
      }
      installCodexHook(path, cmd2, record);
      const doc = JSON.parse(readFileSync(path, "utf8"));
      const userGroup = structuredClone(doc.hooks.SessionStart[0]);
      userGroup.hooks.push({ type: "command", command: "/bin/user-hook" });
      doc.hooks.SessionStart.push(userGroup);
      writeFileSync(path, JSON.stringify(doc));
      expect(uninstallCodexHook(path, record).removed).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart).toEqual(
        [userGroup],
      );
    },
  );

  it.each([true, false])(
    "uninstall recovers an interrupted rename, staged file present = %s",
    (pending) => {
      const dir = makeDir();
      const path = join(dir, "hooks.json");
      const record = join(dir, "owner");
      const stage = "00000000-0000-4000-8000-000000000000";
      const group = (command: string) => ({
        matcher: "startup|resume",
        hooks: [{ type: "command", command, timeout: 10 }],
      });
      const userGroup = group(cmd2);
      writeFileSync(
        path,
        JSON.stringify({
          hooks: { SessionStart: [userGroup, group(pending ? cmd1 : cmd2)] },
        }),
      );
      writeFileSync(
        record,
        JSON.stringify({
          stage,
          before: { group: 1, command: cmd1 },
          after: { group: 1, command: cmd2 },
        }),
      );
      if (pending) writeFileSync(`${path}.oa-${stage}.tmp`, "{}");
      expect(uninstallCodexHook(path, record).removed).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart).toEqual(
        [userGroup],
      );
      expect(existsSync(`${path}.oa-${stage}.tmp`)).toBe(false);
    },
  );

  it("uninstall removes only our hook and cleans up emptied containers", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    const otherGroup = {
      matcher: "startup",
      hooks: [
        {
          type: "command",
          command: "/bin/wrapper rules codex-hook",
          timeout: 5,
        },
      ],
    };
    writeFileSync(
      file,
      `${JSON.stringify({ hooks: { SessionStart: [otherGroup] } }, null, 2)}\n`,
    );
    installCodexHook(file, cmd1);

    expect(uninstallCodexHook(file)).toEqual({ removed: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hooks: { SessionStart: [otherGroup] },
    });
    expect(uninstallCodexHook(file)).toEqual({ removed: false });

    // When ours is the only hook, the now-empty file is deleted instead of writing {}.
    const solo = join(dir, "solo.json");
    installCodexHook(solo, cmd1);
    expect(uninstallCodexHook(solo)).toEqual({ removed: true });
    expect(existsSync(solo)).toBe(false);
  });

  it("keeps existing user group at index 0 and appends ours at index 1", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    const userGroup = {
      matcher: "startup",
      hooks: [{ type: "command", command: "/bin/user-first", timeout: 5 }],
    };
    writeFileSync(
      file,
      `${JSON.stringify({ hooks: { SessionStart: [userGroup] } }, null, 2)}\n`,
    );

    expect(installCodexHook(file, cmd1)).toEqual({ status: "added" });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.hooks.SessionStart[0]).toEqual(userGroup);
    expect(after.hooks.SessionStart[1]).toEqual({
      matcher: "startup|resume",
      hooks: [{ type: "command", command: cmd1, timeout: 10 }],
    });
  });

  it("returns a re-trust note on uninstall when our group is not the last SessionStart group", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    const afterGroup = {
      matcher: "startup",
      hooks: [{ type: "command", command: "/bin/user-after", timeout: 5 }],
    };
    installCodexHook(file, cmd1);
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup|resume",
                hooks: [{ type: "command", command: cmd1, timeout: 10 }],
              },
              afterGroup,
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(uninstallCodexHook(file)).toEqual({
      removed: true,
      note: "Codex may ask you to trust the hooks listed after the Open Artifacts bus hook again.",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hooks: { SessionStart: [afterGroup] },
    });
  });

  it("preserves existing indentation and trailing newline on install and uninstall", () => {
    const dir = makeDir();
    const userGroup = {
      matcher: "startup",
      hooks: [{ type: "command", command: "/bin/user-hook", timeout: 5 }],
    };

    // 4-space indentation, no trailing newline
    const fourSpace = join(dir, "four.json");
    const fourBefore = JSON.stringify(
      { hooks: { SessionStart: [userGroup] } },
      null,
      4,
    );
    writeFileSync(fourSpace, fourBefore);
    expect(installCodexHook(fourSpace, cmd1)).toEqual({ status: "added" });
    const fourInstalled = readFileSync(fourSpace, "utf8");
    expect(fourInstalled.endsWith("\n")).toBe(false);
    expect(fourInstalled).toContain('\n    "hooks": {');
    expect(uninstallCodexHook(fourSpace)).toEqual({ removed: true });
    expect(readFileSync(fourSpace, "utf8")).toBe(fourBefore);

    // Tab indentation, with trailing newline
    const tabFile = join(dir, "tab.json");
    const tabBefore = `${JSON.stringify(
      { hooks: { SessionStart: [userGroup] } },
      null,
      "\t",
    )}\n`;
    writeFileSync(tabFile, tabBefore);
    expect(installCodexHook(tabFile, cmd1)).toEqual({ status: "added" });
    const tabInstalled = readFileSync(tabFile, "utf8");
    expect(tabInstalled.endsWith("\n")).toBe(true);
    expect(tabInstalled).toContain('\n\t"hooks": {');
    expect(uninstallCodexHook(tabFile)).toEqual({ removed: true });
    expect(readFileSync(tabFile, "utf8")).toBe(tabBefore);
  });

  it("keeps hooks.json on uninstall when other top-level keys remain", () => {
    const dir = makeDir();
    const file = join(dir, "extra.json");
    writeFileSync(file, `${JSON.stringify({ extra: true }, null, 2)}\n`);
    expect(installCodexHook(file, cmd1)).toEqual({ status: "added" });
    expect(uninstallCodexHook(file)).toEqual({ removed: true });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ extra: true });
  });

  it("leaves invalid JSON untouched and reports a warning", () => {
    const dir = makeDir();
    const file = join(dir, "hooks.json");
    writeFileSync(file, "{ not json");
    const r = installCodexHook(file, cmd1);
    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("refuses a symlinked hooks.json without modifying its target", () => {
    const dir = makeDir();
    const target = join(dir, "real.json");
    const link = join(dir, "hooks.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);

    const r = installCodexHook(link, cmd1);
    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("{}\n");

    const u = uninstallCodexHook(link);
    expect(u.removed).toBe(false);
    expect(u.note).toMatch(/symlink/);
  });

  it("shell-quotes binary paths with spaces", () => {
    const cmd = codexHookCommand(["/path with spaces/node", "/my bin/cli.js"]);
    expect(cmd).toBe(
      "'/path with spaces/node' '/my bin/cli.js' rules codex-hook",
    );
  });
});
