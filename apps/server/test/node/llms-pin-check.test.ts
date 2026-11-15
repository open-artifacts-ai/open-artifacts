// #2543: the check llms.txt gives an agent reads npm's lockfile and prints OK
// only for exactly our package at the pinned version and integrity.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { busInstallBlock } from "../../src/mcp/bus-install.ts";

const PIN = { version: "1.2.3", integrity: `sha512-${"B".repeat(86)}==` };
const OURS = "node_modules/@open-artifacts/bus";
const lock = (packages: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 3, packages });

const block = busInstallBlock("https://artifacts.example.com", PIN);
const cmd = /^(node -e '.*') &&$/m.exec(block)?.[1] ?? "";

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

// M1: the block is one chain. Run it for real, with a fake npm that writes the
// lockfile and a package whose installer prints a marker, and prove the marker
// is reached only when every step before it passed.
describe("the whole block stops on any failure", () => {
  const body = block
    .split("\n")
    .filter((l) => !l.startsWith("```"))
    .join("\n");

  function fakeNpm(lockIntegrity: string, extra: Record<string, unknown> = {}) {
    const bin = mkdtempSync(join(tmpdir(), "oa-fake-npm-"));
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        [OURS]: { version: PIN.version, integrity: lockIntegrity },
        ...extra,
      },
    });
    const file = join(bin, "npm");
    writeFileSync(
      file,
      `#!/bin/sh
case "$1" in
  install)
    [ -n "$FAKE_INSTALL_FAIL" ] && { echo "install failed" >&2; exit 1; }
    mkdir -p node_modules/@open-artifacts/bus/dist
    echo 'console.log("INSTALLER RAN " + process.argv.slice(2).join(" "))' > node_modules/@open-artifacts/bus/dist/index.js
    cat > package-lock.json <<'EOF2'
${lock}
EOF2
    ;;
  audit)
    [ -n "$FAKE_AUDIT_FAIL" ] && { echo "audit failed" >&2; exit 1; }
    ;;
esac
exit 0
`,
    );
    chmodSync(file, 0o755);
    return bin;
  }
  const go = (bin: string, env: Record<string, string> = {}) =>
    spawnSync("sh", ["-c", body], {
      encoding: "utf8",
      env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
    });

  it("every step passes: the installer runs with the instance", () => {
    const r = go(fakeNpm(PIN.integrity));
    expect(r.stdout).toContain(
      "INSTALLER RAN install --instance https://artifacts.example.com",
    );
    expect(r.status).toBe(0);
  });

  it("a wrong pin never reaches the installer", () => {
    const r = go(fakeNpm(`sha512-${"C".repeat(86)}==`));
    expect(r.stdout).toContain("MISMATCH");
    expect(r.stdout).not.toContain("INSTALLER RAN");
    expect(r.status).not.toBe(0);
  });

  it("an extra package in the lockfile never reaches the installer", () => {
    const r = go(
      fakeNpm(PIN.integrity, {
        "node_modules/left-pad": { version: "1.0.0", integrity: "sha512-x" },
      }),
    );
    expect(r.stdout).not.toContain("INSTALLER RAN");
    expect(r.status).not.toBe(0);
  });

  it("a failing install never reaches the check or the installer", () => {
    const r = go(fakeNpm(PIN.integrity), { FAKE_INSTALL_FAIL: "1" });
    expect(r.stdout).not.toContain("OK");
    expect(r.stdout).not.toContain("INSTALLER RAN");
    expect(r.status).not.toBe(0);
  });

  it("a failing audit never reaches the installer", () => {
    const r = go(fakeNpm(PIN.integrity), { FAKE_AUDIT_FAIL: "1" });
    expect(r.stdout).toContain("OK");
    expect(r.stdout).not.toContain("INSTALLER RAN");
    expect(r.status).not.toBe(0);
  });
});
