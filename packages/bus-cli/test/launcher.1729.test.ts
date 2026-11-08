import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCli, launcherOf, launcherText } from "../src/steps/service.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ob-launcher-"));

/** A "node" that prints its name and arguments, and answers --version. */
const fakeNode = (dir: string, name: string, exit = 0) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "node");
  writeFileSync(
    f,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exit ${exit}; fi\necho "${name}:$*"\n`,
  );
  chmodSync(f, 0o755);
  return f;
};

/** Writes the launcher under a fresh home and runs it. */
const run = (opts: {
  recorded: string;
  path: string;
  usual?: string[];
  args?: string[];
  prep?: (bin: string) => void;
}) => {
  const home = tmp();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const launcher = join(bin, "node");
  writeFileSync(launcher, launcherText(opts.recorded, opts.usual ?? []), {
    mode: 0o700,
  });
  opts.prep?.(bin);
  const r = spawnSync(launcher, opts.args ?? ["a b", "c"], {
    env: { PATH: opts.path, HOME: home },
    encoding: "utf8",
  });
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.status };
};

describe("the node launcher (#1729)", () => {
  it("runs the node recorded at install while it works, with the arguments intact", () => {
    const d = tmp();
    const recorded = fakeNode(join(d, "with space"), "recorded");
    const onPath = fakeNode(join(d, "path"), "path");
    const r = run({
      recorded,
      path: `${join(d, "path")}:/usr/bin:/bin`,
    });
    expect(r).toEqual({ out: "recorded:a b c", err: "", code: 0 });
    expect(onPath).toBeTruthy();
  });

  it("recorded node gone: node on PATH", () => {
    const d = tmp();
    fakeNode(join(d, "path"), "path");
    const r = run({
      recorded: join(d, "gone/node"),
      path: `${join(d, "empty")}:${join(d, "path")}`,
    });
    expect(r).toEqual({ out: "path:a b c", err: "", code: 0 });
  });

  it("recorded node present but broken: falls through", () => {
    const d = tmp();
    const recorded = fakeNode(join(d, "old"), "old", 1);
    fakeNode(join(d, "path"), "path");
    const r = run({ recorded, path: join(d, "path") });
    expect(r.out).toBe("path:a b c");
  });

  it("recorded gone and PATH minimal (launchd, systemd): the usual places", () => {
    const d = tmp();
    fakeNode(join(d, "usual"), "usual");
    const r = run({
      recorded: join(d, "gone/node"),
      path: "/usr/bin:/bin",
      usual: [`"${join(d, "nothing")}"`, `"${join(d, "usual")}"`],
    });
    expect(r.out).toBe("usual:a b c");
  });

  it("no node anywhere: one clear line, non-zero, nothing on stdout", () => {
    const d = tmp();
    const r = run({
      recorded: join(d, "gone/node"),
      path: join(d, "empty"),
      usual: [`"${join(d, "nothing")}"`],
    });
    expect(r.code).toBe(127);
    expect(r.out).toBe("");
    expect(r.err).toBe(
      "oa-bus: Node.js not found. Install Node, then run: npx @open-artifacts/bus install",
    );
  });

  it("its own folder on PATH, even through a symlink, does not loop", () => {
    const d = tmp();
    const r = run({
      recorded: join(d, "gone/node"),
      path: join(d, "alias"),
      usual: [],
      prep: (bin) => symlinkSync(bin, join(d, "alias")),
    });
    expect(r.code).toBe(127);
    expect(r.err).toContain("Node.js not found");
  });

  it("a recorded path with a quote or a dollar sign is one literal word", () => {
    const d = tmp();
    const recorded = fakeNode(join(d, "it's $HOME"), "quoted");
    expect(run({ recorded, path: "/usr/bin" }).out).toBe("quoted:a b c");
  });

  it("installCli writes it executable under <home>/bin, owner-only", () => {
    const home = join(tmp(), ".oa-bus");
    installCli(home, { kind: "dev", main: "/m.ts", jiti: "j" }, "/x/node");
    const f = launcherOf(home);
    expect(f).toBe(join(home, "bin/node"));
    expect(statSync(f).mode & 0o777).toBe(0o700);
    expect(readFileSync(f, "utf8")).toContain("recorded='/x/node'");
  });

  it("reads no config and no token", () => {
    const text = launcherText("/x/node");
    expect(text).not.toMatch(/token|machine\.json|\bcat\b|\bsource\b/i);
  });
});
