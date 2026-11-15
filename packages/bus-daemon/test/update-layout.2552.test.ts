import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentVersion,
  installVersion,
  type LiveProc,
  migrate,
  prune,
  readState,
  stage,
  stepBack,
  swap,
  unsafeDir,
  versionDir,
} from "../src/update/layout.ts";

const home = () => {
  const h = join(mkdtempSync(join(tmpdir(), "oa-layout-")), ".oa-bus");
  mkdirSync(h, { mode: 0o700 });
  return h;
};
const put = (v: string) => (dir: string) =>
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: v }));
const versions = (h: string) => readdirSync(join(h, "versions")).sort();

describe("versioned layout (#2552)", () => {
  it("installs into versions/<v> and points bin at it, owner-only, armed", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    expect(lstatSync(join(h, "bin")).isSymbolicLink()).toBe(true);
    expect(currentVersion(h)).toBe("1.0.0");
    expect(readFileSync(join(h, "bin/package.json"), "utf8")).toContain(
      "1.0.0",
    );
    expect(statSync(versionDir(h, "1.0.0")).mode & 0o777).toBe(0o700);
    expect(statSync(join(h, "versions")).mode & 0o777).toBe(0o700);
    expect(statSync(join(h, "update.json")).mode & 0o777).toBe(0o600);
    expect(readState(h)).toEqual({ armed: true, current: "1.0.0" });
  });

  it("a reader polling bin while it is swapped never finds it missing (macOS may answer EINVAL mid-rename; that is not missing)", async () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    stage(h, "2.0.0", put("2.0.0"));
    const reader = `
      const fs = require("fs");
      const [bin, stop] = process.argv.slice(1);
      let reads = 0, misses = 0;
      process.send("ready");
      while (!fs.existsSync(stop)) {
        reads++;
        try { fs.readFileSync(bin + "/package.json"); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") misses++; }
      }
      process.send({ reads, misses });
    `;
    const stop = join(h, "stop");
    const out = await new Promise<{ reads: number; misses: number }>(
      (resolve, reject) => {
        const c = spawn(
          process.execPath,
          ["-e", reader, join(h, "bin"), stop],
          {
            stdio: ["ignore", "ignore", "inherit", "ipc"],
          },
        );
        c.on("error", reject);
        c.on("message", (m) => {
          if (m === "ready") {
            for (let i = 0; i < 300; i++) swap(h, i % 2 ? "1.0.0" : "2.0.0");
            writeFileSync(stop, "");
          } else resolve(m as { reads: number; misses: number });
        });
      },
    );
    expect(out.reads).toBeGreaterThan(0);
    expect(out.misses).toBe(0);
    expect(readdirSync(h).filter((n) => n.endsWith(".new"))).toEqual([]);
  });

  it("keeps exactly one previous and prunes older ones", () => {
    const h = home();
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"])
      installVersion(h, v, put(v));
    expect(versions(h)).toEqual(["1.2.0", "1.3.0"]);
    expect(readState(h)).toEqual({
      armed: true,
      current: "1.3.0",
      previous: "1.2.0",
    });
  });

  it("reinstalling the same version replaces it and keeps the previous", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    installVersion(h, "1.1.0", put("1.1.0"));
    installVersion(h, "1.1.0", (d) => {
      put("1.1.0")(d);
      writeFileSync(join(d, "marker"), "again");
    });
    expect(readFileSync(join(h, "bin/marker"), "utf8")).toBe("again");
    expect(versions(h)).toEqual(["1.0.0", "1.1.0"]);
    expect(readState(h).previous).toBe("1.0.0");
  });

  it("prune never removes the kept names, and spares a live process's staging", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    installVersion(h, "2.0.0", put("2.0.0"));
    mkdirSync(join(h, "versions", "0.9.0"));
    mkdirSync(join(h, "versions", ".stage.4242"));
    mkdirSync(join(h, "versions", ".stage.4243"));
    const removed = prune(h, ["2.0.0", "1.0.0"], {
      alive: (pid) => pid === 4242,
      procs: () => [],
    });
    expect(removed.sort()).toEqual([".stage.4243", "0.9.0"]);
    expect(versions(h)).toEqual([".stage.4242", "1.0.0", "2.0.0"]);
    expect(
      prune(h, [undefined, "2.0.0"], { alive: () => true, procs: () => [] }),
    ).toEqual(["1.0.0"]);
  });

  it("prune leaves a folder a live process runs from, then removes it once it is gone (N1)", () => {
    const h = home();
    for (const [i, v] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
      installVersion(h, v, put(v), { procs: () => [] });
      // Folder times as install order, a minute apart.
      const t = new Date(Date.UTC(2026, 0, 1, 0, i));
      utimesSync(versionDir(h, v), t, t);
    }
    // 1.0.0 was pruned at install (nothing ran it). Rebuild the case.
    mkdirSync(versionDir(h, "0.5.0"));
    const t0 = new Date(Date.UTC(2025, 11, 31));
    utimesSync(versionDir(h, "0.5.0"), t0, t0);
    const keep = ["3.0.0", "2.0.0"];
    const at = (min: number) => Date.UTC(2026, 0, 1, 0, min) - 30_000;
    // A session started via bin while 0.5.0 was current (before 2.0.0's folder... window ends at 2.0.0).
    const sessions: LiveProc[] = [
      {
        pid: 9,
        startMs: Date.UTC(2025, 11, 31, 1),
        cmd: `node ${join(h, "bin")}/dist/index.js mcp`,
      },
    ];
    expect(prune(h, keep, { procs: () => sessions })).not.toContain("0.5.0");
    expect(existsSync(versionDir(h, "0.5.0"))).toBe(true);
    // A command line naming the folder itself also holds it.
    expect(
      prune(h, keep, {
        procs: () => [
          { pid: 8, startMs: 0, cmd: `node ${versionDir(h, "0.5.0")}/x` },
        ],
      }),
    ).toEqual([]);
    // Processes that cannot be listed: nothing goes.
    expect(prune(h, keep, { procs: () => undefined })).toEqual([]);
    // A bin session that started later (ran a kept version) does not hold it.
    expect(
      prune(h, keep, {
        procs: () => [
          {
            pid: 7,
            startMs: at(5),
            cmd: `node ${join(h, "bin")}/dist/index.js`,
          },
        ],
      }),
    ).toEqual(["0.5.0"]);
    expect(versions(h)).toEqual(["2.0.0", "3.0.0"]);
  });

  it("prune refuses a versions folder others can write", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    mkdirSync(join(h, "versions", "0.1.0"));
    chmodSync(join(h, "versions"), 0o777);
    expect(prune(h, ["1.0.0"])).toEqual([]);
    expect(existsSync(join(h, "versions", "0.1.0"))).toBe(true);
  });

  it("refuses group- or world-writable folders and symlinks", () => {
    const h = home();
    expect(unsafeDir(h)).toBeUndefined();
    expect(unsafeDir(join(h, "missing"))).toBeUndefined();
    chmodSync(h, 0o770);
    expect(unsafeDir(h)).toMatch(/writable by others/);
    chmodSync(h, 0o707);
    expect(unsafeDir(h)).toMatch(/writable by others/);
    chmodSync(h, 0o700);
    symlinkSync(h, `${h}-link`);
    expect(unsafeDir(`${h}-link`)).toMatch(/not a folder/);
    // A versions folder that others can write is refused before anything is staged.
    mkdirSync(join(h, "versions"));
    chmodSync(join(h, "versions"), 0o777);
    // ensureVersions tightens a folder that is ours; a foreign one cannot be.
    if (process.getuid) {
      const uid = process.getuid();
      expect(unsafeDir(join(h, "versions"))).toMatch(/writable/);
      expect(uid).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses a folder owned by another user", () => {
    if (!process.getuid) return;
    // / is root's; as root itself the check cannot differ.
    if (process.getuid() === 0) return;
    expect(unsafeDir("/usr")).toMatch(/another user/);
  });

  it("refuses to swap to a version folder that is group-writable", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    stage(h, "2.0.0", put("2.0.0"));
    chmodSync(versionDir(h, "2.0.0"), 0o775);
    expect(() => swap(h, "2.0.0")).toThrow(/writable/);
    expect(currentVersion(h)).toBe("1.0.0");
  });

  it("rejects a version that could leave versions/", () => {
    const h = home();
    for (const v of ["../x", "a/b", ".hidden", "", "x y"])
      expect(() => stage(h, v, () => {})).toThrow();
    expect(() => swap(h, "..")).toThrow();
  });

  it("migrates a real bin folder to versions/<its version>", () => {
    const h = home();
    mkdirSync(join(h, "bin"));
    writeFileSync(join(h, "bin/package.json"), '{"version":"0.9.0"}');
    writeFileSync(join(h, "bin/keep"), "old");
    installVersion(h, "1.0.0", put("1.0.0"));
    expect(lstatSync(join(h, "bin")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(h, "versions/0.9.0/keep"), "utf8")).toBe("old");
    expect(readState(h)).toEqual({
      armed: true,
      current: "1.0.0",
      previous: "0.9.0",
    });
  });

  it("names an unreadable legacy bin unknown-<ts>", () => {
    const h = home();
    mkdirSync(join(h, "bin"));
    expect(migrate(h, () => 77)).toBe("unknown-77");
    expect(existsSync(join(h, "versions/unknown-77"))).toBe(true);
    expect(existsSync(join(h, "bin"))).toBe(false);
  });

  it("migrating the same version it then installs leaves one folder", () => {
    const h = home();
    mkdirSync(join(h, "bin"));
    writeFileSync(join(h, "bin/package.json"), '{"version":"1.0.0"}');
    installVersion(h, "1.0.0", put("1.0.0"));
    expect(versions(h)).toEqual(["1.0.0"]);
    expect(readState(h)).toEqual({ armed: true, current: "1.0.0" });
  });

  it("stepBack returns bin to the previous and keeps no other", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    installVersion(h, "2.0.0", put("2.0.0"));
    expect(stepBack(h)).toBe("1.0.0");
    expect(currentVersion(h)).toBe("1.0.0");
    expect(versions(h)).toEqual(["1.0.0"]);
    expect(readState(h)).toEqual({ armed: true, current: "1.0.0" });
    expect(stepBack(h)).toBeUndefined();
  });

  it("a state file's unknown keys survive a write", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    const f = join(h, "update.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...j, off: true }));
    installVersion(h, "1.1.0", put("1.1.0"));
    expect(JSON.parse(readFileSync(f, "utf8")).off).toBe(true);
    expect(readlinkSync(join(h, "bin"))).toBe(join("versions", "1.1.0"));
  });
});
