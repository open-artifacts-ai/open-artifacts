// #1570: a git remote derives the namespace only as first recorded; a change needs the #1525 approval.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigIssues } from "../src/config-issues.ts";
import { remoteChange, resolveNamespace } from "../src/namespace.ts";
import { readRemotes } from "../src/namespaces.ts";
import { approvals } from "./approvals.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "ob-1570-")));

function setup() {
  const base = tmp();
  const root = join(base, "repo");
  mkdirSync(root);
  const remotes = join(base, "remotes.json");
  let url = "git@github.com:acme/app.git";
  const deps = (extra: object = {}) => ({
    gitRemote: () => url,
    gitRoot: () => root,
    remotesFile: remotes,
    namespacesFile: approvals(),
    ...extra,
  });
  return { root, remotes, deps, setUrl: (u: string) => (url = u) };
}

describe("the first git remote", () => {
  it("is recorded without an approval and gives its namespace", () => {
    const t = setup();
    const ns = resolveNamespace(t.root, t.deps());
    expect(ns).toMatchObject({
      namespace: "github.com/acme/app",
      source: "git",
    });
    expect(readRemotes(t.remotes).entries).toEqual([
      { dir: t.root, namespace: "github.com/acme/app" },
    ]);
  });

  it("is not written by a read-only caller", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps({ recordRemote: false }));
    expect(readRemotes(t.remotes).entries).toEqual([]);
  });

  it("does not pin when no record file is given", () => {
    const t = setup();
    const { remotesFile: _r, ...deps } = t.deps();
    expect(resolveNamespace(t.root, deps).namespace).toBe(
      "github.com/acme/app",
    );
    expect(readRemotes(t.remotes).entries).toEqual([]);
  });
});

describe("a changed git remote", () => {
  it("keeps the recorded namespace, logs once and waits as pending", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps());
    t.setUrl("git@github.com:victim/secrets.git");
    const issues = new ConfigIssues();
    const log = vi.fn();
    const deps = t.deps({ issues, log });
    expect(resolveNamespace(t.root, deps)).toMatchObject({
      namespace: "github.com/acme/app",
      source: "git",
    });
    resolveNamespace(t.root, deps);
    expect(log.mock.calls.filter(([m]) => /not approved/.test(m))).toHaveLength(
      1,
    );
    const [p] = issues.list(undefined, { pending: true });
    expect(p).toMatchObject({
      file: join(t.root, ".git"),
      state: "pending",
      fix: `oa-bus namespace approve '${t.root}'`,
    });
    expect(p?.reason).toContain('"github.com/victim/secrets"');
    expect(p?.reason).toContain('"github.com/acme/app"');
    // The record keeps the first namespace.
    expect(readRemotes(t.remotes).entries[0]?.namespace).toBe(
      "github.com/acme/app",
    );
  });

  it("takes effect once the user approved exactly that namespace for the folder", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps());
    t.setUrl("git@github.com:acme/renamed.git");
    const ok = approvals([t.root, "github.com/acme/renamed"]);
    const issues = new ConfigIssues();
    expect(
      resolveNamespace(t.root, t.deps({ namespacesFile: ok, issues })),
    ).toMatchObject({ namespace: "github.com/acme/renamed", source: "git" });
    expect(readRemotes(t.remotes).entries[0]?.namespace).toBe(
      "github.com/acme/renamed",
    );
    expect(issues.list(undefined, { pending: true })).toEqual([]);
  });

  it("is not covered by an approval of another namespace or another folder", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps());
    t.setUrl("git@github.com:evil/x.git");
    for (const file of [
      approvals([t.root, "something/else"]),
      approvals([tmp(), "github.com/evil/x"]),
    ])
      expect(
        resolveNamespace(t.root, t.deps({ namespacesFile: file })).namespace,
      ).toBe("github.com/acme/app");
  });

  it("clears the pending entry when the remote goes back", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps());
    t.setUrl("git@github.com:evil/x.git");
    const issues = new ConfigIssues();
    const deps = t.deps({ issues });
    resolveNamespace(t.root, deps);
    expect(issues.list(undefined, { pending: true })).toHaveLength(1);
    t.setUrl("git@github.com:acme/app.git");
    resolveNamespace(t.root, deps);
    expect(issues.list(undefined, { pending: true })).toEqual([]);
  });

  it("is found by remoteChange without recording anything", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps());
    expect(remoteChange(t.root, t.deps())).toBeUndefined();
    t.setUrl("git@github.com:evil/x.git");
    const before = readFileSync(t.remotes, "utf8");
    expect(remoteChange(t.root, t.deps())).toEqual({
      root: t.root,
      namespace: "github.com/evil/x",
      recorded: "github.com/acme/app",
    });
    expect(readFileSync(t.remotes, "utf8")).toBe(before);
  });

  it("gives no way around the pin through a .oa-bus.json that names the new namespace", () => {
    const t = setup();
    resolveNamespace(t.root, t.deps());
    t.setUrl("git@github.com:evil/x.git");
    writeConfig(t.root, "github.com/evil/x");
    const ns = resolveNamespace(t.root, t.deps());
    expect(ns).toMatchObject({
      namespace: "github.com/acme/app",
      source: "git",
    });
  });
});

describe("a folder without a git remote", () => {
  it("is not pinned", () => {
    const t = setup();
    const ns = resolveNamespace(t.root, t.deps({ gitRemote: () => null }));
    expect(ns.source).toBe("dir");
    expect(readRemotes(t.remotes).entries).toEqual([]);
  });
});

function writeConfig(dir: string, namespace: string) {
  writeFileSync(join(dir, ".oa-bus.json"), JSON.stringify({ namespace }), {
    mode: 0o600,
  });
}
