import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coveringEntry,
  folderHomeLookup,
  foldersFile,
  readFolders,
  readSuggestion,
  unmappedFolderNote,
  writeFolders,
} from "../src/folders.ts";
import { saveInstance } from "../src/instances.ts";
import { resolveNamespace } from "../src/namespace.ts";
import {
  isApproved,
  namespacesFile,
  readApprovals,
  writeApprovals,
} from "../src/namespaces.ts";

const TOKEN = `oa_machine_${"a".repeat(28)}7f3a`;
const made: string[] = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ob-fold-")));
  made.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const withMain = (h: string) =>
  writeFileSync(
    join(h, "machine.json"),
    JSON.stringify({ hub: "https://m.example.com", machine_token: TOKEN }),
    { mode: 0o600 },
  );
const addInst = (h: string, name: string, hub: string) =>
  saveInstance(
    { name, hub, machine_id: "", label: "l", machine_token: TOKEN },
    h,
  );
const multi = () => {
  const h = scratch();
  withMain(h);
  addInst(h, "work", "https://w.example.com");
  return h;
};

describe("folderHomeLookup (#2793 S2)", () => {
  it("single-instance home: every folder is main and no folders.json is written", () => {
    const h = scratch();
    withMain(h);
    const look = folderHomeLookup(h);
    expect(look("/any/where")).toEqual({ instance: "main" });
    expect(look(scratch())).toEqual({ instance: "main" });
    expect(existsSync(foldersFile(h))).toBe(false);
  });

  it("two instances and no mapping: unmapped", () => {
    const h = multi();
    expect(folderHomeLookup(h)(scratch())).toEqual({ unmapped: true });
  });

  it("a mapped folder covers everything below it; the longest prefix wins", () => {
    const h = multi();
    const a = scratch();
    const b = join(a, "deep");
    const c = join(b, "deeper");
    mkdirSync(c, { recursive: true });
    writeFolders({ map: { [a]: "work", [b]: "main" }, no: {}, seen: {} }, h);
    const look = folderHomeLookup(h);
    expect(look(a)).toEqual({ instance: "work" });
    expect(look(c)).toEqual({ instance: "main" });
    expect(look(`${a}-sibling`)).toEqual({ unmapped: true });
  });

  it("routes a registered worktree through its primary checkout unless mapped directly", () => {
    const h = multi();
    const primary = scratch();
    const checkout = join(scratch(), "side checkout");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", primary, ...args]);
    git("init", "-q");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.org",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    git("worktree", "add", "-q", "--detach", checkout);
    const nested = join(checkout, "nested");
    mkdirSync(nested);
    const map = { [primary]: "work" };
    writeFolders({ map, no: {}, seen: {} }, h);
    const look = folderHomeLookup(h);
    expect(look(nested)).toEqual({ instance: "work" });
    writeFolders({ map: { ...map, [checkout]: "main" }, no: {}, seen: {} }, h);
    expect(look(nested)).toEqual({ instance: "main" });
  });

  it("an entry naming an instance that is gone counts as unmapped", () => {
    const h = multi();
    const a = scratch();
    writeFolders({ map: { [a]: "gone" }, no: {}, seen: {} }, h);
    expect(folderHomeLookup(h)(a)).toEqual({ unmapped: true });
  });

  it("folders.json is 0600 and an unsafe or broken file maps nothing", () => {
    const h = multi();
    const a = scratch();
    writeFolders({ map: { [a]: "work" }, no: {}, seen: {} }, h);
    expect(statSync(foldersFile(h)).mode & 0o777).toBe(0o600);
    writeFileSync(foldersFile(h), "{not json", { mode: 0o600 });
    expect(folderHomeLookup(h)(a)).toEqual({ unmapped: true });
    expect(readFolders(h)).toEqual({ map: {}, no: {}, seen: {} });
  });

  it("coveringEntry compares whole path segments", () => {
    const f = { map: { "/a/b": "x" }, no: {}, seen: {} };
    expect(coveringEntry(f, "/a/bc")).toBeUndefined();
    expect(coveringEntry(f, "/a/b/c")?.name).toBe("x");
  });

  it("the unmapped note is said once per folder, never for a mapped one", () => {
    const h = multi();
    const a = scratch();
    const b = scratch();
    writeFolders({ map: { [b]: "work" }, no: {}, seen: {} }, h);
    expect(unmappedFolderNote(a, h)).toBe(
      "This folder is not connected to a bus instance. Run npx @open-artifacts/bus use in this folder.",
    );
    expect(unmappedFolderNote(a, h)).toBeUndefined();
    expect(unmappedFolderNote(b, h)).toBeUndefined();
  });
});

describe("repo suggestion (#2793 S2)", () => {
  const put = (dir: string, body: unknown) =>
    writeFileSync(join(dir, ".oa-bus.json"), JSON.stringify(body), {
      mode: 0o600,
    });

  it("reads one https host[:port] and returns it canonical", () => {
    const d = scratch();
    put(d, { instance: "https://Work.Example.com:8443" });
    expect(readSuggestion(d)).toBe("https://work.example.com:8443");
  });

  it.each([
    "http://w.example.com",
    "https://w.example.com/path",
    "https://u:p@w.example.com",
    "https://w.example.com?x=1",
    "https://w.example.com#f",
    "https://w.example.com?",
    "w.example.com",
    "https://w.example.com/ ",
  ])("refuses the whole file for %s", (bad) => {
    const d = scratch();
    put(d, { namespace: "team", instance: bad });
    expect(readSuggestion(d)).toBeUndefined();
    // The same file also gives no namespace, as an invalid file does today.
    const log = vi.fn();
    expect(
      resolveNamespace(d, { gitRemote: () => null, gitRoot: () => null, log })
        .source,
    ).toBe("cwd");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/invalid/));
  });

  it("a Cyrillic lookalike comes back in xn-- form", () => {
    const d = scratch();
    put(d, { instance: "https://аrtifacts.example.com" });
    expect(readSuggestion(d)).toMatch(/^https:\/\/xn--/);
  });

  it("ignores a file others can write, as the namespace file is", () => {
    const d = scratch();
    put(d, { instance: "https://w.example.com" });
    expect(readSuggestion(d, { uid: (process.getuid?.() ?? 0) + 1 })).toBe(
      undefined,
    );
  });

  it("a file deeper than the mapped folder is ignored", () => {
    const top = scratch();
    const deep = join(top, "a", "b");
    mkdirSync(deep, { recursive: true });
    put(deep, { instance: "https://deep.example.com" });
    put(top, { instance: "https://top.example.com" });
    expect(readSuggestion(deep)).toBe("https://deep.example.com");
    expect(readSuggestion(deep, { below: top })).toBe(
      "https://top.example.com",
    );
  });
});

describe("namespace approvals are kept per instance (#2793 S2)", () => {
  it("a namespace approved on one instance is still unapproved on another", () => {
    const h = scratch();
    const dir = join(scratch(), "r");
    mkdirSync(dir);
    writeFileSync(join(dir, ".oa-bus.json"), '{"namespace":"team"}', {
      mode: 0o600,
    });
    writeApprovals([{ dir, namespace: "team" }], h, "work");
    expect(namespacesFile(h)).toBe(join(h, "namespaces.json"));
    expect(namespacesFile(h, "work")).toBe(join(h, "namespaces.work.json"));
    const on = (instance: string) =>
      resolveNamespace(dir, {
        gitRemote: () => null,
        gitRoot: () => null,
        namespacesFile: namespacesFile(h, instance),
      }).namespace;
    expect(on("work")).toBe("team");
    expect(on("other")).toBe("r");
    expect(on("main")).toBe("r");
    expect(
      isApproved(
        dir,
        "team",
        readApprovals(namespacesFile(h, "other")).entries,
      ),
    ).toBe(false);
    expect(existsSync(join(h, "namespaces.json"))).toBe(false);
  });
});
