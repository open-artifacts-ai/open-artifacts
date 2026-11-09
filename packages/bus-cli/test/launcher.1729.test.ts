import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

const HOST_NODE = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"].some(
  (d) => existsSync(`${d}/node`),
);

const tmp = () => mkdtempSync(join(tmpdir(), "ob-launcher-"));

/** A "node" that prints its name and arguments, and answers --version. */
const fakeNode = (dir: string, name: string, exit = 0, version = "v22.3.0") => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "node");
  writeFileSync(
    f,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit ${exit}; fi\necho "${name}:$*"\n`,
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
      "oa-bus: Node.js 22 or newer not found. Install it, then run: npx @open-artifacts/bus install",
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
    expect(r.err).toContain("or newer not found");
  });

  it("a recorded path with a quote or a dollar sign is one literal word", () => {
    const d = tmp();
    const recorded = fakeNode(join(d, "it's $HOME"), "quoted");
    expect(run({ recorded, path: "/usr/bin" }).out).toBe("quoted:a b c");
  });

  it("a recorded node below the floor is skipped, and so is an old one earlier on PATH", () => {
    const d = tmp();
    const recorded = fakeNode(join(d, "old"), "old", 0, "v20.11.1");
    fakeNode(join(d, "p1"), "p1", 0, "v18.0.0");
    fakeNode(join(d, "p2"), "p2");
    const r = run({
      recorded,
      path: `${join(d, "p1")}:${join(d, "p2")}`,
    });
    expect(r.out).toBe("p2:a b c");
  });

  it("only too-old nodes: the one line, exit 127", () => {
    const d = tmp();
    const recorded = fakeNode(join(d, "old"), "old", 0, "v20.11.1");
    const r = run({ recorded, path: join(d, "old") });
    expect(r.code).toBe(127);
    expect(r.err).toContain("22 or newer not found");
  });

  it("a relative PATH entry is never run", () => {
    const d = tmp();
    const bad = fakeNode(join(d, "repo/node_modules/.bin"), "REPO");
    const home = tmp();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const launcher = join(bin, "node");
    writeFileSync(launcher, launcherText(join(d, "gone/node"), []), {
      mode: 0o700,
    });
    const r = spawnSync(launcher, [], {
      cwd: join(d, "repo"),
      env: { PATH: "node_modules/.bin:.:", HOME: home },
      encoding: "utf8",
    });
    expect(bad).toBeTruthy();
    expect(r.stdout).toBe("");
    expect(r.status).toBe(127);
  });

  it("a PATH entry with a glob is one literal name, not expanded", () => {
    const d = tmp();
    fakeNode(join(d, "aa"), "aa");
    // "/…/a*" would glob to /…/aa if expanded.
    const r = run({
      recorded: join(d, "gone/node"),
      path: `${join(d, "a*")}`,
      usual: [],
    });
    expect(r.code).toBe(127);
  });

  it.skipIf(HOST_NODE)(
    "the default dirs text, executed: a node under $HOME/.local/bin is found",
    () => {
      const home = tmp();
      fakeNode(join(home, ".local/bin"), "home-local");
      const bin = join(home, "bin");
      mkdirSync(bin);
      const launcher = join(bin, "node");
      writeFileSync(launcher, launcherText("/gone/node"), { mode: 0o700 });
      const r = spawnSync(launcher, ["x"], {
        env: { PATH: "/nonexistent", HOME: home },
        encoding: "utf8",
      });
      // A host node in /usr/local/bin, /opt/homebrew/bin or /usr/bin may win first.
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("home-local:x");
    },
  );

  it("it execs: the node's pid is the launcher's", () => {
    const d = tmp();
    const node = join(d, "node-pid");
    mkdirSync(node);
    writeFileSync(
      join(node, "node"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.0.0; exit 0; fi\necho $$\n',
    );
    chmodSync(join(node, "node"), 0o755);
    const home = tmp();
    mkdirSync(join(home, "bin"));
    const launcher = join(home, "bin/node");
    writeFileSync(launcher, launcherText(join(node, "node"), []), {
      mode: 0o700,
    });
    // The launcher's pid is the child's: the wrapper is ours, via a pid file.
    const wrap = join(home, "wrap.sh");
    writeFileSync(
      wrap,
      `#!/bin/sh\necho $$ >"${home}/pid"\nexec "${launcher}"\n`,
      {
        mode: 0o700,
      },
    );
    const r = spawnSync(wrap, [], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe(
      readFileSync(join(home, "pid"), "utf8").trim(),
    );
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
