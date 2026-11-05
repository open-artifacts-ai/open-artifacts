import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// B16 docs adversarial review: the llms.txt loop must work for an agent with
// no TTY that reads stdout as JSON lines and branches on the exit code.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const llms = readFileSync(join(dist, "llms.txt"), "utf8");
const setupMd = readFileSync(join(dist, "docs/setup.md"), "utf8");

// The documented invocation, e.g. `pnpm oa:setup` or `pnpm -s oa:setup`.
const invocation = (
  llms.match(
    /(pnpm(?: -[a-z-]+)* oa:setup) --json(?: --yes)? --app-host/,
  )?.[1] ?? "pnpm oa:setup"
).split(" ");

describe("B16 setup docs adversarial", () => {
  // pnpm prints its "> open-artifacts@ oa:setup" banners and ELIFECYCLE
  // errors to stdout, so the documented command's stdout isn't JSON lines.
  // An invalid --name fails in arg parsing, before any Cloudflare call.
  it("the documented command prints only JSON lines on stdout", () => {
    const [cmd, ...pre] = invocation;
    const r = spawnSync(cmd, [...pre, "--json", "--name", "Bad_Name"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // pnpm 11 prints its own "[ELIFECYCLE] Command failed with exit code N."
    // trailer on stdout even under -s (pnpm 10 was silent). The exit code
    // carries the same fact, so that one line is the only non-JSON allowed.
    const lines = r.stdout
      .split("\n")
      .filter(
        (l) =>
          l.trim() &&
          !/^\[ELIFECYCLE\] Command failed with exit code \d+\.$/.test(l),
      );
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l), l).not.toThrow();
  }, 60_000);

  // Regression guard (passes today): exit 2 must survive the pnpm wrapper.
  // Mirrors the root oa:setup script in a temp workspace whose child exits 2.
  it("the documented command passes exit code 2 through", () => {
    const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .scripts["oa:setup"] as string;
    const dir = mkdtempSync(join(tmpdir(), "oa-exit-"));
    mkdirSync(join(dir, "setup"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "r",
        private: true,
        scripts: { "oa:setup": script.replace("@oa/setup", "fake-setup") },
      }),
    );
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - setup\n");
    writeFileSync(
      join(dir, "setup/package.json"),
      JSON.stringify({
        name: "fake-setup",
        scripts: { start: "node exit2.js" },
      }),
    );
    writeFileSync(join(dir, "setup/exit2.js"), "process.exit(2);\n");
    const [cmd, ...pre] = invocation;
    const r = spawnSync(cmd, [...pre, "--json"], { cwd: dir, stdio: "ignore" });
    expect(r.status).toBe(2);
  }, 60_000);

  // Since #70, a run without OA_ACCESS_TOKEN skips re-checking Access when
  // the app host and account match the saved state. The token is needed on
  // the first run and to change either, and nowhere else.
  it("setup docs say when OA_ACCESS_TOKEN is needed again", () => {
    expect(setupMd).toMatch(
      /OA_ACCESS_TOKEN[^.]*first run[^.]*(app host|account)/i,
    );
    expect(setupMd).not.toMatch(
      /OA_ACCESS_TOKEN[^.]*(every|each) (later )?(run|rerun)/i,
    );
  });

  // --json never prompts: a missing input is action_required naming the flag.
  it("setup docs tell the agent to pass the flag an action_required names", () => {
    expect(setupMd).toMatch(/\*\*2:\*\*[^\n]*pass a flag[^\n]*run again/);
  });
});
