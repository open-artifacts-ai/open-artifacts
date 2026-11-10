// #1570: a git remote that changes the derived namespace needs the #1525 approval; doctor shows the source.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  namespacesFile,
  readApprovals,
  remotesFile,
  resolveNamespace,
} from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: "ignore" });

function setup(answer = "y") {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".oa-bus");
  const repo = join(ctx.userHome, "code/app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "git@github.com:acme/app.git");
  ctx.cwd = repo;
  ctx.stdinIsTTY = true;
  const asked: string[] = [];
  ctx.readLine = async (q) => {
    asked.push(q);
    return answer;
  };
  // The daemon's first sighting.
  resolveNamespace(repo, {
    namespacesFile: namespacesFile(ctx.home),
    remotesFile: remotesFile(ctx.home),
  });
  const run = (...argv: string[]) => main(["namespace", ...argv], () => ctx);
  return { ctx, repo, run, asked };
}

describe("doctor", () => {
  it("shows the namespace and that it comes from the git remote", async () => {
    const { ctx } = setup();
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "Namespace github.com/acme/app (from the git remote)",
    );
  });

  it("lists a changed remote as pending with the approve command", async () => {
    const { ctx, repo } = setup();
    git(repo, "remote", "set-url", "origin", "git@github.com:evil/x.git");
    await doctor(ctx);
    const out = ctx.all().join("\n");
    expect(out).toContain(
      "Namespace github.com/acme/app (from the git remote)",
    );
    expect(out).toContain("not approved");
    expect(out).toContain(`Fix: oa-bus namespace approve '${repo}'`);
  });
});

describe("namespace approve after a remote change", () => {
  it("asks, stores the approval, and the new remote then applies", async () => {
    const { ctx, repo, run, asked } = setup();
    git(repo, "remote", "set-url", "origin", "git@github.com:evil/x.git");
    expect(await run("approve", repo)).toBe(0);
    expect(asked).toHaveLength(1);
    expect(ctx.all().join("\n")).toContain(
      "first got the namespace github.com/acme/app",
    );
    expect(readApprovals(namespacesFile(ctx.home)).entries).toEqual([
      { dir: repo, namespace: "github.com/evil/x" },
    ]);
    expect(
      resolveNamespace(repo, {
        namespacesFile: namespacesFile(ctx.home),
        remotesFile: remotesFile(ctx.home),
      }).namespace,
    ).toBe("github.com/evil/x");
  });

  it("answering n changes nothing", async () => {
    const { ctx, repo, run } = setup("n");
    git(repo, "remote", "set-url", "origin", "git@github.com:evil/x.git");
    expect(await run("approve", repo)).toBe(1);
    expect(readApprovals(namespacesFile(ctx.home)).entries).toEqual([]);
  });

  it("with an unchanged remote there is nothing to approve", async () => {
    const { repo, run } = setup();
    expect(await run("approve", repo)).toBe(1);
  });
});

describe("where a namespace comes from", () => {
  it("is worded for every source, in status and self", async () => {
    const { copy } = await import("../src/copy.ts");
    const { selfText } = await import("@oa/bus-ipc");
    const c = copy({ color: "none", dark: true, utf8: true });
    const want = {
      config: "an approved .oa-bus.json",
      git: "the git remote",
      dir: "the git folder's name",
      cwd: "the folder's name",
    } as const;
    for (const [source, text] of Object.entries(want))
      expect(c.namespaceSource(source as keyof typeof want)).toContain(text);
    expect(
      selfText({ name: "a", namespace: "n", namespace_source: "git" }),
    ).toContain('"namespace_source": "git"');
  });
});
