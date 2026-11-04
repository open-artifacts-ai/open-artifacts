// I8: `.oa-bus.json` is checked by path, then read by path again.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNamespace } from "../src/namespace.ts";

const hook: { onRead?: (path: string) => void } = {};
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof path === "string") hook.onRead?.(path);
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFileSync,
  };
});
afterEach(() => {
  hook.onRead = undefined;
});

describe("I8: a planted .oa-bus.json", () => {
  it("a symlink swapped between the owner check and the read never makes an agent global", () => {
    // In a shared parent such as /tmp, another user owns the symlink: it
    // points at a file of ours for the check, then at theirs for the read.
    const p = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ob-i8-ns-")));
    fs.mkdirSync(join(p, "proj"));
    const ours = join(p, "ours.json");
    fs.writeFileSync(ours, "{}", { mode: 0o644 });
    fs.chmodSync(ours, 0o644);
    // Stand-in for another user's file: one the check refuses on its own.
    const theirs = join(p, "theirs.json");
    fs.writeFileSync(theirs, '{"global":true,"namespace":"attacker"}');
    fs.chmodSync(theirs, 0o666);
    const link = join(p, ".oa-bus.json");
    fs.symlinkSync(ours, link);
    const deps = { gitRemote: () => null, gitRoot: () => null };
    hook.onRead = (path) => {
      if (path !== link) return;
      fs.unlinkSync(link);
      fs.symlinkSync(theirs, link);
    };
    const ns = resolveNamespace(join(p, "proj"), deps);
    expect(ns.global).toBe(false);
    expect(ns.namespace).not.toBe("attacker");
  });

  it("a FIFO named .oa-bus.json never hangs the walk", () => {
    const p = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ob-i8-ns-")));
    fs.mkdirSync(join(p, "proj"));
    execFileSync("mkfifo", [join(p, ".oa-bus.json")]);
    const deps = { gitRemote: () => null, gitRoot: () => null };
    expect(resolveNamespace(join(p, "proj"), deps).global).toBe(false);
  });
});
