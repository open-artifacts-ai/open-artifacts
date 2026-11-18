// #2793 S2: approvals follow the folder's instance.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  namespacesFile,
  readApprovals,
  resolveNamespace,
  writeFolders,
} from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const hub = (h: string) =>
  JSON.stringify({
    hub: h,
    machine_id: "m1",
    label: "x",
    machine_token: `oam_${"a".repeat(40)}`,
  });

function setup(mapped: boolean) {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  mkdirSync(join(ctx.home, "instances"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.home, "machine.json"), hub("https://a.example.com"), {
    mode: 0o600,
  });
  writeFileSync(
    join(ctx.home, "instances", "work.json"),
    hub("https://b.example.com"),
    { mode: 0o600 },
  );
  const ops = join(ctx.userHome, "code/ops");
  mkdirSync(ops, { recursive: true });
  writeFileSync(
    join(ops, ".oa-bus.json"),
    JSON.stringify({ namespace: "team" }),
    {
      mode: 0o600,
    },
  );
  if (mapped)
    writeFolders({ map: { [ops]: "work" }, no: {}, seen: {} }, ctx.home);
  ctx.cwd = join(ctx.userHome, "code");
  ctx.stdinIsTTY = true;
  ctx.readLine = async () => "y";
  return {
    ctx,
    ops,
    run: (...a: string[]) => main(["namespace", ...a], () => ctx),
  };
}

describe("namespace approvals per instance (#2793)", () => {
  it("approve in a work-mapped folder writes namespaces.work.json only", async () => {
    const { ctx, ops, run } = setup(true);
    expect(await run("approve", "ops")).toBe(0);
    expect(readApprovals(namespacesFile(ctx.home, "work")).entries).toEqual([
      { dir: ops, namespace: "team" },
    ]);
    expect(existsSync(namespacesFile(ctx.home))).toBe(false);
    expect(ctx.all().join("\n")).toContain("on work");
    const ns = resolveNamespace(ops, {
      namespacesFile: namespacesFile(ctx.home),
    });
    expect(ns.namespace).not.toBe("team");
    // revoke reads the same file
    expect(await run("revoke", "ops")).toBe(0);
    expect(readApprovals(namespacesFile(ctx.home, "work")).entries).toEqual([]);
  });

  it("an unmapped folder with several instances is refused", async () => {
    const { ctx, run } = setup(false);
    expect(await run("approve", "ops")).toBe(1);
    expect(ctx.all().join("\n")).toContain("use here first");
    expect(existsSync(namespacesFile(ctx.home))).toBe(false);
  });
});
