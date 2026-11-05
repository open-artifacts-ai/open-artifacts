// #1527: a group-writable file you own is read with a note; a refused file is
// listed with its reason and exact fix; the daemon tells status and self.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInfo, daemonStatus, StatusReply } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ConfigIssues,
  inspectGlobal,
  scanConfigFiles,
  shq,
} from "../src/config-issues.ts";
import { readGlobalDirs } from "../src/global.ts";
import { resolveNamespace } from "../src/namespace.ts";
import { isPrivateGroup, readOwnFile } from "../src/own-file.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "ob-1527-")));
const noGit = { gitRemote: () => null, gitRoot: () => null };
const me = process.getuid?.() ?? 0;
const myGid = process.getgid?.() ?? 0;
/** The user's private group, or a shared one, without reading /etc/group. */
const privateGroup = { gid: myGid, isPrivate: () => true };
const sharedGroup = { gid: myGid, isPrivate: () => false };

const write = (mode: number, text = JSON.stringify({ namespace: "mine" })) => {
  const dir = tmp();
  const file = join(dir, ".oa-bus.json");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return { dir, file };
};

describe("readOwnFile with allowGroupWrite", () => {
  it("accepts a group-writable file you own, with a note", () => {
    const { file } = write(0o664);
    const r = readOwnFile(file, me, {
      allowGroupWrite: true,
      group: privateGroup,
    });
    expect(r).toMatchObject({ state: "ok", note: "is writable by its group" });
  });

  it("stays strict by default", () => {
    const { file } = write(0o664);
    expect(readOwnFile(file, me)).toEqual({
      state: "unsafe",
      why: "is writable by others",
    });
  });

  it("refuses a world-writable file", () => {
    const { file } = write(0o666);
    expect(readOwnFile(file, me, { allowGroupWrite: true })).toEqual({
      state: "unsafe",
      why: "is writable by everyone",
    });
  });

  it("refuses another uid's file even at 0600", () => {
    const { file } = write(0o600);
    expect(readOwnFile(file, me + 1, { allowGroupWrite: true })).toEqual({
      state: "unsafe",
      why: "belongs to another user",
    });
  });

  it("refuses a symlink and a FIFO", () => {
    const { dir, file } = write(0o600);
    symlinkSync(file, join(dir, "l"));
    expect(readOwnFile(join(dir, "l"), me, { allowGroupWrite: true })).toEqual({
      state: "unsafe",
      why: "is a symlink",
    });
    execFileSync("mkfifo", [join(dir, "f")]);
    expect(readOwnFile(join(dir, "f"), me, { allowGroupWrite: true })).toEqual({
      state: "unsafe",
      why: "is not a regular file",
    });
  });
});

describe("namespace config", () => {
  it("uses a 0664 .oa-bus.json and lists it as noted", () => {
    const { dir, file } = write(0o664);
    const issues = new ConfigIssues();
    const log = vi.fn();
    const ns = resolveNamespace(dir, {
      ...noGit,
      log,
      issues,
      group: privateGroup,
    });
    expect(ns.namespace).toBe("mine");
    expect(issues.list()).toEqual([
      {
        file,
        state: "noted",
        reason: "is writable by its group",
        fix: `optional: run chmod g-w '${file}'`,
      },
    ]);
  });

  it("ignores a world-writable one, logs once, and lists the fix", () => {
    const { dir, file } = write(0o666);
    const issues = new ConfigIssues();
    const log = vi.fn();
    for (let i = 0; i < 3; i++)
      expect(
        resolveNamespace(dir, { ...noGit, log, issues }).namespace,
      ).not.toBe("mine");
    expect(log).toHaveBeenCalledTimes(1);
    expect(issues.list()).toEqual([
      {
        file,
        state: "refused",
        reason: "is writable by everyone",
        fix: `run chmod o-w '${file}'`,
      },
    ]);
  });

  it("drops an entry once the file is fixed", () => {
    const { dir, file } = write(0o666);
    const issues = new ConfigIssues();
    resolveNamespace(dir, { ...noGit, issues });
    chmodSync(file, 0o600);
    expect(issues.list()).toEqual([]);
  });

  it("gives another user's file the remove-or-chown fix", () => {
    const { dir, file } = write(0o600);
    const issues = new ConfigIssues();
    resolveNamespace(dir, { ...noGit, uid: me + 1, issues });
    expect(issues.list()[0]).toMatchObject({
      file,
      state: "refused",
      reason: "belongs to another user",
      fix: `remove it (rm '${file}') or take it over (chown "$USER" '${file}')`,
    });
  });
});

describe("scanConfigFiles", () => {
  it("lists a refused file from cwd up, and a refused global.json", () => {
    const { dir, file } = write(0o666);
    const home = tmp();
    const g = join(home, "global.json");
    writeFileSync(g, JSON.stringify({ dirs: [] }));
    chmodSync(g, 0o664);
    const out = scanConfigFiles(dir, { globalFile: g });
    expect(out.map((i) => [i.file, i.state])).toEqual([
      [file, "refused"],
      [g, "refused"],
    ]);
    expect(out[1]?.fix).toBe(`run chmod go-w '${g}'`);
  });
});

describe("the daemon tells status and self", () => {
  const setup = async () => {
    const { dir, file } = write(0o666);
    const h = await daemonHarness({ resolveNamespace: undefined });
    const a = await h.adapter("A", { cwd: dir });
    return { h, a, file };
  };

  it("status carries config_files", async () => {
    const { h, file } = await setup();
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.config_files).toEqual([
      {
        file,
        state: "refused",
        reason: "is writable by everyone",
        fix: `run chmod o-w '${file}'`,
      },
    ]);
  });

  it("self with row carries config_files; an internal self does not", async () => {
    const { a, file } = await setup();
    const r = await a.request({ type: "self", row: true });
    expect(r.type === "agent" && r.agent?.config_files?.[0]?.file).toBe(file);
    const plain = await a.request({ type: "self" });
    expect(plain.type === "agent" && plain.agent?.config_files).toBeUndefined();
  });
});

describe("an old adapter or CLI still decodes the new frames", () => {
  it("an AgentInfo without config_files parses a frame that has it", () => {
    const Old = z.object({
      name: z.string(),
      namespace: z.string(),
      kind: z.string(),
      live: z.boolean(),
      global: z.boolean(),
    });
    const agent = {
      name: "a",
      namespace: "n",
      kind: "claude-code",
      live: true,
      global: false,
      config_files: [{ file: "/x", state: "refused", reason: "r", fix: "f" }],
    };
    expect(Old.parse(agent)).not.toHaveProperty("config_files");
    expect(AgentInfo.parse(agent).config_files).toHaveLength(1);
    expect(
      AgentInfo.parse({ ...agent, config_files: undefined }),
    ).toBeDefined();
  });

  it("a status reply without config_files is still valid", () => {
    expect(
      StatusReply.safeParse({
        v: 1,
        id: "x",
        type: "status",
        pid: 1,
        version: "1",
        label: "l",
        hub: "connected",
        namespaces: [],
      }).success,
    ).toBe(true);
  });
});

describe("#1527 review: group-writable only for a user-private group", () => {
  it("a shared group is refused, with a chmod g-w fix", () => {
    const { file } = write(0o664);
    expect(
      readOwnFile(file, me, { allowGroupWrite: true, group: sharedGroup }),
    ).toEqual({ state: "unsafe", why: "is writable by a group others share" });
    const { dir } = write(0o664);
    const issues = new ConfigIssues();
    resolveNamespace(dir, { ...noGit, issues, group: sharedGroup });
    expect(issues.list()[0]).toMatchObject({
      state: "refused",
      fix: `run chmod g-w '${join(dir, ".oa-bus.json")}'`,
    });
  });

  it("a file in a group that is not the process's own group is refused", () => {
    const { file } = write(0o664);
    expect(
      readOwnFile(file, me, {
        allowGroupWrite: true,
        group: { gid: myGid + 1, isPrivate: () => true },
      }),
    ).toMatchObject({ state: "unsafe" });
  });

  const user = "alice";
  const line = (members: string) => `${user}:x:1000:${members}\nstaff:x:20:\n`;
  it("isPrivateGroup: the user's own group with no members", () => {
    expect(
      isPrivateGroup(
        1000,
        user,
        () => line(""),
        () => `${user}:x:1000:1000::/h:/bin/sh\n`,
      ),
    ).toBe(true);
  });
  it("isPrivateGroup: a group with members is not private", () => {
    expect(isPrivateGroup(1000, user, () => line("bob"))).toBe(false);
    expect(isPrivateGroup(1000, user, () => line(user))).toBe(false);
  });
  it("isPrivateGroup: another name, or no entry, is not private", () => {
    expect(isPrivateGroup(20, user, () => line(""))).toBe(false);
    expect(isPrivateGroup(77, user, () => line(""))).toBe(false);
  });
  const passwd = (extra = "") =>
    `${user}:x:1000:1000::/home/${user}:/bin/sh\n${extra}`;
  it("isPrivateGroup: another user with this primary gid is refused", () => {
    expect(
      isPrivateGroup(
        1000,
        user,
        () => line(""),
        () => passwd("bob:x:1001:1000::/home/bob:/bin/sh\n"),
      ),
    ).toBe(false);
    expect(
      isPrivateGroup(
        1000,
        user,
        () => line(""),
        () => passwd("bob:x:1001:1001::/home/bob:/bin/sh\n"),
      ),
    ).toBe(true);
  });
  it("isPrivateGroup: an unreadable /etc/passwd is refused", () => {
    expect(
      isPrivateGroup(
        1000,
        user,
        () => line(""),
        () => {
          throw new Error("EACCES");
        },
      ),
    ).toBe(false);
  });
  it("isPrivateGroup: an unreadable /etc/group is not private", () => {
    expect(
      isPrivateGroup(1000, user, () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });
});

describe("#1527 review: fixes are safe to paste", () => {
  const evil = "x$(touch pwn)`id` a'b\nc";
  it("shq single-quotes, escaping a single quote", () => {
    expect(shq("a'b")).toBe("'a'\\''b'");
    expect(shq("$(x) `y`")).toBe("'$(x) `y`'");
  });

  it("a path with $(), backticks, spaces, a quote and a newline is quoted in every fix", () => {
    const root = tmp();
    const dir = join(root, evil);
    mkdirSync(dir);
    const file = join(dir, ".oa-bus.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o666);
    const quoted = `'${file.replace(/'/g, "'\\''")}'`;
    const issues = new ConfigIssues();
    resolveNamespace(dir, { ...noGit, issues });
    expect(issues.list()[0]?.fix).toBe(`run chmod o-w ${quoted}`);
    chmodSync(file, 0o600);
    resolveNamespace(dir, { ...noGit, uid: me + 1, issues });
    expect(issues.list()[0]?.fix).toBe(
      `remove it (rm ${quoted}) or take it over (chown "$USER" ${quoted})`,
    );
  });
});

describe("#1527 review: self shows only the asking agent's chain", () => {
  it("two agents in different folders each see their own file, not the other's", async () => {
    const a = write(0o666);
    const b = write(0o666);
    const h = await daemonHarness({ resolveNamespace: undefined });
    const A = await h.adapter("A", { cwd: a.dir });
    const B = await h.adapter("B", { cwd: b.dir });
    const files = async (c: typeof A) => {
      const r = await c.request({ type: "self", row: true });
      return r.type === "agent"
        ? (r.agent?.config_files ?? []).map((f) => f.file)
        : [];
    };
    expect(await files(A)).toEqual([a.file]);
    expect(await files(B)).toEqual([b.file]);
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect((st.config_files ?? []).map((f) => f.file).sort()).toEqual(
      [a.file, b.file].sort(),
    );
  });
});

describe("global.json stays strict", () => {
  it("a group-writable global.json grants nothing and is listed with its fix", () => {
    const g = join(tmp(), "global.json");
    writeFileSync(g, JSON.stringify({ dirs: ["/"] }));
    chmodSync(g, 0o664);
    expect(readGlobalDirs(g)).toEqual({
      dirs: [],
      error: "is writable by others",
    });
    expect(inspectGlobal(g)).toEqual({
      file: g,
      state: "refused",
      reason: "is writable by others",
      fix: `run chmod go-w '${g}'`,
    });
  });
});
