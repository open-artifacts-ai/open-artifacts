// #1525: `oa-bus namespace approve|list|revoke`, and the pending state in doctor.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { namespacesFile, readApprovals } from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

/** A ctx run from ~/code, with ~/code/ops setting namespace "team". */
function setup(over: { tty?: boolean; answer?: string } = {}) {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  const ops = join(ctx.userHome, "code/ops");
  mkdirSync(ops, { recursive: true });
  writeFileSync(
    join(ops, ".oa-bus.json"),
    JSON.stringify({ namespace: "team" }),
    {
      mode: 0o600,
    },
  );
  ctx.cwd = join(ctx.userHome, "code");
  const asked: string[] = [];
  ctx.stdinIsTTY = over.tty ?? true;
  ctx.readLine = async (q) => {
    asked.push(q);
    return over.answer ?? "y";
  };
  const run = (...argv: string[]) => main(["namespace", ...argv], () => ctx);
  const entries = () => readApprovals(namespacesFile(ctx.home)).entries;
  return { ctx, run, entries, ops, asked };
}

describe("namespace approve", () => {
  it("asks, then stores the realpath, 0600, and says running agents keep theirs", async () => {
    const { ctx, run, entries, ops, asked } = setup();
    expect(await run("approve", "ops")).toBe(0);
    expect(asked).toHaveLength(1);
    expect(entries()).toEqual([{ dir: ops, namespace: "team" }]);
    expect(statSync(namespacesFile(ctx.home)).mode & 0o777).toBe(0o600);
    const out = ctx.all().join("\n");
    expect(out).toContain("sets its namespace to team");
    expect(out).toContain("keep their namespace until they restart");
  });

  it("refuses with no TTY unless --yes, and names the command", async () => {
    const { ctx, run, entries, ops } = setup({ tty: false });
    expect(await run("approve", "ops")).toBe(1);
    expect(entries()).toEqual([]);
    const refusal = ctx.err().join("\n");
    expect(refusal).toContain(
      `Ask them to run this in a terminal: oa-bus namespace approve '${ops}'`,
    );
    expect(refusal).not.toContain("--yes");
    expect(await run("approve", "ops", "--yes")).toBe(0);
    expect(entries()).toEqual([{ dir: ops, namespace: "team" }]);
  });

  it("answering n changes nothing", async () => {
    const { run, entries } = setup({ answer: "n" });
    expect(await run("approve", "ops")).toBe(1);
    expect(entries()).toEqual([]);
  });

  it("an approved directory is reported, not rewritten", async () => {
    const { ctx, run, ops } = setup();
    await run("approve", "ops");
    const before = readFileSync(namespacesFile(ctx.home), "utf8");
    expect(await run("approve", ops)).toBe(0);
    expect(ctx.all().join("\n")).toContain("already approved");
    expect(readFileSync(namespacesFile(ctx.home), "utf8")).toBe(before);
  });

  it("a changed namespace replaces the old approval for that directory", async () => {
    const { run, entries, ops } = setup();
    await run("approve", "ops");
    writeFileSync(
      join(ops, ".oa-bus.json"),
      JSON.stringify({ namespace: "other" }),
    );
    chmodSync(join(ops, ".oa-bus.json"), 0o600);
    await run("approve", "ops");
    expect(entries()).toEqual([{ dir: ops, namespace: "other" }]);
  });

  it("through a symlink stores the real path and matches by identity", async () => {
    const { ctx, run, entries, ops } = setup();
    symlinkSync(ops, join(ctx.cwd, "link"));
    expect(await run("approve", "link")).toBe(0);
    expect(entries()).toEqual([{ dir: ops, namespace: "team" }]);
    expect(await run("approve", "ops")).toBe(0);
    expect(entries()).toHaveLength(1);
  });

  it("fails on a missing directory, a missing file, and a file with no namespace", async () => {
    const { ctx, run } = setup();
    expect(await run("approve", "nope")).toBe(1);
    mkdirSync(join(ctx.cwd, "empty"));
    expect(await run("approve", "empty")).toBe(1);
    writeFileSync(join(ctx.cwd, "empty/.oa-bus.json"), "{}", { mode: 0o600 });
    expect(await run("approve", "empty", "--yes")).toBe(1);
  });

  it("refuses an unusable namespaces.json and never overwrites it", async () => {
    const { ctx, run } = setup();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(namespacesFile(ctx.home), "{}", { mode: 0o664 });
    chmodSync(namespacesFile(ctx.home), 0o664);
    expect(await run("approve", "ops", "--yes")).toBe(1);
    expect(readFileSync(namespacesFile(ctx.home), "utf8")).toBe("{}");
  });
});

describe("the approvals log", () => {
  const log = (home: string) => join(home, "logs", "approvals.log");

  it("approve and revoke each append a line, 0600", async () => {
    const { ctx, run, ops } = setup();
    await run("approve", "ops");
    await run("revoke", "ops");
    const lines = readFileSync(log(ctx.home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(`^\\S+Z approve dir="${ops}" namespace="team" tty=yes$`),
    );
    expect(lines[1]).toMatch(/ revoke dir=.* namespace="team" tty=yes$/);
    expect(statSync(log(ctx.home)).mode & 0o777).toBe(0o600);
  });

  it("records a --yes without a terminal as tty=no; a refusal logs nothing", async () => {
    const { ctx, run } = setup({ tty: false });
    await run("approve", "ops");
    expect(() => readFileSync(log(ctx.home))).toThrow();
    await run("approve", "ops", "--yes");
    expect(readFileSync(log(ctx.home), "utf8")).toMatch(/tty=no\n$/);
  });
});

describe("namespace list and revoke", () => {
  it("lists none, then the approvals", async () => {
    const { ctx, run } = setup();
    expect(await run("list")).toBe(0);
    expect(ctx.all().join("\n")).toContain("No approved namespaces");
    await run("approve", "ops");
    expect(await run("list")).toBe(0);
    expect(ctx.all().join("\n")).toContain("1 approved namespace");
  });

  it("revoke removes by identity, even through a symlink", async () => {
    const { ctx, run, entries, ops } = setup();
    await run("approve", "ops");
    symlinkSync(ops, join(ctx.cwd, "link"));
    expect(await run("revoke", "link")).toBe(0);
    expect(entries()).toEqual([]);
    expect(await run("revoke", "ops")).toBe(0);
    expect(ctx.all().join("\n")).toContain("was not approved");
  });
});

describe("parse", () => {
  it("takes approve [dir] with --yes, revoke <dir> and list", () => {
    expect(parse(["namespace", "approve", "--yes"])).toMatchObject({
      cmd: "namespace",
      sub: "approve",
      dir: ".",
      yes: true,
    });
    expect(parse(["namespace", "approve", "x"])).toMatchObject({
      dir: "x",
      yes: false,
    });
    expect(parse(["namespace", "revoke", "x"])).toMatchObject({
      sub: "revoke",
      dir: "x",
    });
    expect(parse(["namespace", "list"])).toMatchObject({ sub: "list" });
    expect(() => parse(["namespace", "revoke"])).toThrow(/usage/);
    expect(() => parse(["namespace"])).toThrow(/usage/);
    expect(() => parse(["namespace", "list", "x"])).toThrow(/unexpected/);
    expect(() => parse(["namespace", "approve", "a", "b"])).toThrow(
      /unexpected/,
    );
  });
});

describe("doctor", () => {
  it("lists a pending namespace with the exact approve command", async () => {
    const { ctx, ops } = setup();
    ctx.cwd = ops;
    await doctor(ctx);
    const out = ctx.all().join("\n");
    expect(out).toContain(`Fix: oa-bus namespace approve '${ops}'`);
    expect(out).toContain("you have not approved");
  });

  it("is quiet once approved", async () => {
    const { ctx, run, ops } = setup();
    await run("approve", "ops");
    ctx.cwd = ops;
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("not approved");
  });
});
