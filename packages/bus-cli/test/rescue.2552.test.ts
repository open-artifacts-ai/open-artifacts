import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeUpdate,
  currentVersion,
  installVersion,
  readPolicy,
  readReports,
  readState,
  setPending,
  writeState,
} from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";

// Each test starts a few real shells and nodes: slow on a loaded runner.
vi.setConfig({ testTimeout: 30_000 });

import {
  RESCUE_VERSION,
  rescueOf,
  rescueScript,
  rescueShell,
  writeRescue,
} from "../src/steps/rescue.ts";
import {
  type CliSource,
  installCli,
  launcherText,
} from "../src/steps/service.ts";

/**
 * A fake service manager: starts `<home>/rescue <bin>/dist/index.js daemon`
 * the way launchd or systemd would and restarts it on a non-zero exit. Every
 * version here is a shell script: no real daemon, no network, no real service.
 */
type Fake = { exit: number; launcher?: boolean };
function world(fakes: Record<string, Fake>) {
  const home = mkdtempSync(join(tmpdir(), "oa-rescue-"));
  chmodSync(home, 0o700);
  for (const [v, f] of Object.entries(fakes)) {
    installVersion(home, v, (dir) => {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist/index.js"), `exit ${f.exit}\n`);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: v }));
      if (f.launcher !== false)
        writeFileSync(
          join(dir, "node"),
          `#!/bin/sh\nreadlink "\${0%/*}" >> "${home}/starts.log"\nexec /bin/sh "$@"\n`,
          { mode: 0o700 },
        );
    });
  }
  writeRescue(home, launcherText(process.execPath));
  return home;
}
const starts = (home: string) =>
  existsSync(join(home, "starts.log"))
    ? readFileSync(join(home, "starts.log"), "utf8").trim().split("\n")
    : [];

/** Runs the unit's command until it exits 0 (or `max` starts), like a restarting service. */
function service(home: string, max = 6): number[] {
  const codes: number[] = [];
  for (let i = 0; i < max; i++) {
    const r = spawnSync(
      "/bin/sh",
      [rescueOf(home), join(home, "bin/dist/index.js"), "daemon"],
      { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    );
    codes.push(r.status ?? -1);
    if (r.status === 0) break;
  }
  return codes;
}

/** What the updater leaves: bin on the new version, pending written. */
function switched(home: string, to: string, from: string, startedAt: number) {
  writeState(home, { armed: true, current: from, previous: from });
  setPending(home, { from, to, startedAt });
  // setPending stamps attempts 0; startedAt is what the test chose.
  const j = JSON.parse(readFileSync(join(home, "update.json"), "utf8"));
  j.pending.startedAt = startedAt;
  writeFileSync(join(home, "update.json"), JSON.stringify(j));
  // swap, as the updater does
  const tmp = join(home, "bin.new");
  symlinkSync(`versions/${to}`, tmp);
  renameSync(tmp, join(home, "bin"));
}

describe("the rescue shim", () => {
  it("a good release: runs the new version, counts the start, leaves it be", () => {
    const home = world({ "1.0.0": { exit: 0 }, "1.1.0": { exit: 0 } });
    // installVersion left bin on 1.1.0 (the last installed).
    writeState(home, { armed: true, current: "1.0.0", previous: "1.0.0" });
    setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: Date.now() });
    expect(service(home)).toEqual([0]);
    expect(starts(home)).toEqual(["versions/1.1.0"]);
    expect(currentVersion(home)).toBe("1.1.0");
    expect(readPolicy(home).pending).toMatchObject({
      to: "1.1.0",
      attempts: 1,
    });
    // The new daemon's own check then makes it permanent.
    completeUpdate(home, { from: "1.0.0", to: "1.1.0" }, Date.now());
    expect(readPolicy(home).pending).toBeUndefined();
    expect(service(home)).toEqual([0]);
    expect(readPolicy(home).failed).toEqual([]);
  });

  it("the new daemon crashes at start: two tries, then the old version runs", () => {
    const home = world({ "1.0.0": { exit: 0 }, "1.1.0": { exit: 1 } });
    switched(home, "1.1.0", "1.0.0", Date.now());
    expect(service(home)).toEqual([1, 1, 0]);
    expect(starts(home)).toEqual([
      "versions/1.1.0",
      "versions/1.1.0",
      "versions/1.0.0",
    ]);
    expect(currentVersion(home)).toBe("1.0.0");
    const p = readPolicy(home);
    expect(p.failed).toEqual(["1.1.0"]);
    expect(p.pending).toBeUndefined();
    expect(p.lastAt).toBeGreaterThan(0);
    expect(readState(home)).toMatchObject({ armed: true, current: "1.0.0" });
    expect(readReports(home)).toMatchObject([
      {
        event: "stepped_back",
        from: "1.0.0",
        to: "1.1.0",
        reason: "unhealthy",
      },
    ]);
  });

  it("a pending older than 60 s with no ok mark is undone before anything runs", () => {
    const home = world({ "1.0.0": { exit: 0 }, "1.1.0": { exit: 0 } });
    // The new daemon hung for a minute and was killed; or a reboot came.
    switched(home, "1.1.0", "1.0.0", Date.now() - 61_000);
    expect(service(home)).toEqual([0]);
    expect(starts(home)).toEqual(["versions/1.0.0"]);
    expect(readPolicy(home).failed).toEqual(["1.1.0"]);
  });

  it("a start time set in the future (a clock set back) counts as stale", () => {
    const home = world({ "1.0.0": { exit: 0 }, "1.1.0": { exit: 0 } });
    switched(home, "1.1.0", "1.0.0", Date.now() + 3_600_000);
    expect(service(home)).toEqual([0]);
    expect(currentVersion(home)).toBe("1.0.0");
  });

  it("a new version with a broken launcher cannot trap the machine", () => {
    const home = world({
      "1.0.0": { exit: 0 },
      "1.1.0": { exit: 0, launcher: false },
    });
    switched(home, "1.1.0", "1.0.0", Date.now());
    const codes = service(home);
    expect(codes.slice(0, 2).every((c) => c !== 0)).toBe(true);
    expect(codes.at(-1)).toBe(0);
    expect(currentVersion(home)).toBe("1.0.0");
    expect(readPolicy(home).failed).toEqual(["1.1.0"]);
  });

  it("a double restart inside the window changes nothing until the limit", () => {
    const home = world({ "1.0.0": { exit: 0 }, "1.1.0": { exit: 1 } });
    switched(home, "1.1.0", "1.0.0", Date.now());
    service(home, 2);
    expect(currentVersion(home)).toBe("1.1.0");
    expect(readPolicy(home).pending?.attempts).toBe(2);
    service(home, 1);
    expect(currentVersion(home)).toBe("1.0.0");
  });

  it("no pending means the shim only starts the daemon", () => {
    const home = world({ "1.0.0": { exit: 0 } });
    const before = readFileSync(join(home, "update.json"), "utf8");
    expect(service(home)).toEqual([0]);
    expect(readFileSync(join(home, "update.json"), "utf8")).toBe(before);
    // A damaged update.json must not keep the daemon from starting either.
    writeFileSync(join(home, "update.json"), "{nope");
    expect(service(home)).toEqual([0]);
    writeFileSync(
      join(home, "update.json"),
      JSON.stringify({
        pending: { from: "x", to: "1.1.0", startedAt: 1, attempts: 0 },
      }),
    );
    expect(service(home)).toEqual([0]);
  });

  it("a pending whose bin never moved is dropped, not blamed on anyone", () => {
    const home = world({ "1.1.0": { exit: 0 }, "1.0.0": { exit: 0 } });
    // bin is on 1.0.0; the updater wrote pending but died before the swap.
    switched(home, "1.1.0", "1.0.0", Date.now());
    renameSync(join(home, "bin"), join(home, "bin.moved"));
    symlinkSync("versions/1.0.0", join(home, "bin"));
    service(home);
    expect(readPolicy(home).pending).toBeUndefined();
    expect(readPolicy(home).failed).toEqual([]);
  });

  it("reads nothing of the new package and touches no network", () => {
    const home = world({ "1.0.0": { exit: 0 }, "1.1.0": { exit: 0 } });
    switched(home, "1.1.0", "1.0.0", Date.now() - 120_000);
    // Everything of the new version but its launcher is unreadable.
    chmodSync(join(home, "versions/1.1.0/package.json"), 0o000);
    chmodSync(join(home, "versions/1.1.0/dist"), 0o000);
    try {
      expect(service(home)).toEqual([0]);
      expect(currentVersion(home)).toBe("1.0.0");
    } finally {
      chmodSync(join(home, "versions/1.1.0/dist"), 0o700);
      chmodSync(join(home, "versions/1.1.0/package.json"), 0o600);
    }
    const src = rescueScript();
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["node:fs", "node:path"]);
    for (const word of [
      "fetch",
      "http",
      "net",
      "child_process",
      "process.env",
      "import(",
    ])
      expect(src).not.toContain(word);
    expect(rescueShell()).not.toMatch(/curl|wget|npm|npx/);
  });

  it("keeps its own version, and only an install writes it", () => {
    expect(RESCUE_VERSION).toBe(1);
    expect(rescueScript()).toContain(`Rescue shim ${RESCUE_VERSION}`);
    const home = world({ "1.0.0": { exit: 0 } });
    for (const f of ["rescue", "rescue-node", "rescue.mjs"])
      expect(statSync(join(home, f)).mode & 0o777).toBe(0o700);
    const before = ["rescue", "rescue-node", "rescue.mjs"].map((f) =>
      readFileSync(join(home, f), "utf8"),
    );
    // A switch, a step back and a prune leave the three files as they were.
    installVersion(home, "1.2.0", (dir) => {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist/index.js"), "exit 0\n");
    });
    completeUpdate(home, { from: "1.0.0", to: "1.2.0" }, 1);
    expect(
      ["rescue", "rescue-node", "rescue.mjs"].map((f) =>
        readFileSync(join(home, f), "utf8"),
      ),
    ).toEqual(before);
  });

  it("the shim is written by installCli, outside versions/", () => {
    const home = mkdtempSync(join(tmpdir(), "oa-rescue-"));
    const pkg = join(home, "pkg");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"version":"2.0.0"}');
    writeFileSync(join(pkg, "dist/index.js"), "");
    const src: CliSource = { kind: "bundle", file: join(pkg, "dist/index.js") };
    installCli(join(home, ".oa-bus"), src, process.execPath);
    expect(existsSync(join(home, ".oa-bus/rescue"))).toBe(true);
    expect(readlinkSync(join(home, ".oa-bus/bin"))).toBe("versions/2.0.0");
    expect(existsSync(join(home, ".oa-bus/versions/2.0.0/rescue"))).toBe(false);
  });
});
