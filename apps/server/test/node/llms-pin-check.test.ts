// #2543: the check llms.txt gives an agent reads npm's lockfile and prints OK
// only for exactly our package at the pinned version and integrity.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { busInstallBlock } from "../../src/mcp/bus-install.ts";

const PIN = { version: "1.2.3", integrity: `sha512-${"B".repeat(86)}==` };
const OURS = "node_modules/@open-artifacts/bus";
const lock = (packages: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 3, packages });

const block = busInstallBlock("https://artifacts.example.com", PIN);
const cmd = /^(node -e '.*')$/m.exec(block)?.[1] ?? "";

function run(lockText: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "oa-pin-"));
  if (lockText !== null)
    writeFileSync(join(dir, "package-lock.json"), lockText);
  return spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8" });
}

describe("the lockfile check in llms.txt", () => {
  it("the command is in the block, between install and audit", () => {
    expect(cmd).not.toBe("");
    const lines = block.split("\n");
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(
      at(
        "npm install --ignore-scripts --registry https://registry.npmjs.org @open-artifacts/bus@1.2.3",
      ),
    ).toBeGreaterThan(-1);
    expect(at("npm install")).toBeLessThan(at("node -e"));
    expect(at("node -e")).toBeLessThan(at("npm audit signatures"));
    expect(at("npm audit signatures")).toBeLessThan(
      at(
        'node "$tmp/node_modules/@open-artifacts/bus/dist/index.js" install --instance https://artifacts.example.com',
      ),
    );
    expect(block).not.toMatch(/npx|\.bin\/oa-bus|npm pack/);
  });

  it("OK for exactly our package at the pinned version and integrity", () => {
    const r = run(
      lock({
        "": { dependencies: { "@open-artifacts/bus": "1.2.3" } },
        [OURS]: { version: "1.2.3", integrity: PIN.integrity },
      }),
    );
    expect(r.stdout.trim()).toBe("OK");
    expect(r.status).toBe(0);
  });

  it("MISMATCH for an extra dependency, another version or integrity, or a missing package", () => {
    const ours = { version: "1.2.3", integrity: PIN.integrity };
    const bad: Record<string, string> = {
      "an extra package": lock({
        "": {},
        [OURS]: ours,
        "node_modules/left-pad": { version: "1.0.0", integrity: "sha512-x" },
      }),
      "a nested extra": lock({
        "": {},
        [OURS]: ours,
        [`${OURS}/node_modules/x`]: { version: "1.0.0" },
      }),
      "another version": lock({
        "": {},
        [OURS]: { ...ours, version: "1.2.4" },
      }),
      "another integrity": lock({
        "": {},
        [OURS]: { ...ours, integrity: `sha512-${"C".repeat(86)}==` },
      }),
      "no integrity": lock({ "": {}, [OURS]: { version: "1.2.3" } }),
      "another package": lock({
        "": {},
        "node_modules/@open-artifacts/other": ours,
      }),
      "no packages": lock({}),
      "only the root": lock({ "": {} }),
    };
    for (const [name, text] of Object.entries(bad)) {
      const r = run(text);
      expect(r.stdout.trim(), name).toBe("MISMATCH");
      expect(r.status, name).toBe(1);
    }
  });

  it("an unreadable or missing lockfile never prints OK and fails", () => {
    for (const text of [null, "{nope", "[]", "null"]) {
      const r = run(text);
      expect(r.stdout, String(text)).not.toContain("OK");
      expect(r.status, String(text)).not.toBe(0);
    }
  });
});
