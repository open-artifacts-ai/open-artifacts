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
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentVersion,
  installVersion,
  inUse,
  markLive,
  migrate,
  prune,
  readState,
  stage,
  stepBack,
  swap,
  unsafeDir,
  versionDir,
  writeState,
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
    });
    expect(removed.sort()).toEqual([".stage.4243", "0.9.0"]);
    expect(versions(h)).toEqual([".stage.4242", "1.0.0", "2.0.0"]);
    expect(prune(h, [undefined, "2.0.0"], { alive: () => true })).toEqual([
      "1.0.0",
    ]);
  });

  it("prune leaves a folder with a live .live/<pid> marker, then removes it once the pid is gone (N1)", () => {
    const h = home();
    installVersion(h, "2.0.0", put("2.0.0"));
    installVersion(h, "3.0.0", put("3.0.0"));
    const old = versionDir(h, "0.5.0");
    mkdirSync(join(old, ".live"), { recursive: true });
    writeFileSync(join(old, ".live", "4242"), "");
    writeFileSync(join(old, ".live", "9999"), "");
    const keep = ["3.0.0", "2.0.0"];
    expect(prune(h, keep, { alive: (p) => p === 4242 })).toEqual([]);
    expect(existsSync(old)).toBe(true);
    // The dead pid's marker was dropped, the live one kept.
    expect(readdirSync(join(old, ".live"))).toEqual(["4242"]);
    // Only dead pids left: it goes, markers and all.
    expect(prune(h, keep, { alive: () => false })).toEqual(["0.5.0"]);
    expect(versions(h)).toEqual(["2.0.0", "3.0.0"]);
  });

  it("prune keeps a folder whose .live cannot be read", () => {
    if (process.getuid?.() === 0) return;
    const h = home();
    installVersion(h, "2.0.0", put("2.0.0"));
    const old = versionDir(h, "0.5.0");
    mkdirSync(join(old, ".live"), { recursive: true });
    chmodSync(join(old, ".live"), 0o000);
    try {
      expect(prune(h, ["2.0.0"], { alive: () => false })).toEqual([]);
      expect(existsSync(old)).toBe(true);
    } finally {
      chmodSync(join(old, ".live"), 0o700);
    }
  });

  it("markLive writes versions/<v>/.live/<pid> (0600) for a bundle under versions/", () => {
    const h = home();
    installVersion(h, "1.0.0", (d) => {
      put("1.0.0")(d);
      mkdirSync(join(d, "dist"));
      writeFileSync(join(d, "dist/index.js"), "");
    });
    // Reached through the bin link: the real path decides.
    const m = markLive(join(h, "bin/dist/index.js"), h, 4321);
    expect(realpathSync(m as string)).toBe(
      realpathSync(join(h, "versions/1.0.0/.live/4321")),
    );
    expect(statSync(m as string).mode & 0o777).toBe(0o600);
    expect(inUse(versionDir(h, "1.0.0"), (p) => p === 4321)).toBe(true);
    // Not under versions/: nothing written, no throw.
    expect(markLive(join(tmpdir(), "nowhere.js"), h, 1)).toBeUndefined();
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

  it("markLive writes nothing for an nvm-shaped path outside the home (M1)", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    const nvm = join(
      mkdtempSync(join(tmpdir(), "oa-nvm-")),
      "versions/node/v22.1.0/lib/x",
    );
    mkdirSync(nvm, { recursive: true });
    writeFileSync(join(nvm, "index.js"), "");
    expect(markLive(join(nvm, "index.js"), h, 5)).toBeUndefined();
    expect(existsSync(join(nvm, "../../../.live"))).toBe(false);
    expect(existsSync(join(h, "versions/1.0.0/.live"))).toBe(false);
    // Under the home but not a release name: no.
    mkdirSync(join(h, "versions/dev"));
    writeFileSync(join(h, "versions/dev/i.js"), "");
    expect(markLive(join(h, "versions/dev/i.js"), h, 5)).toBeUndefined();
    // Another home's version folder is not this home's.
    const other = home();
    installVersion(other, "1.0.0", (d) => writeFileSync(join(d, "i.js"), ""));
    expect(markLive(join(other, "bin/i.js"), h, 5)).toBeUndefined();
  });

  it("swap needs a real version folder and leaves bin alone otherwise (L1)", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    expect(() => swap(h, "9.9.9")).toThrow(/no such version/);
    symlinkSync(versionDir(h, "1.0.0"), versionDir(h, "3.0.0"));
    expect(() => swap(h, "3.0.0")).toThrow(/no such version/);
    expect(currentVersion(h)).toBe("1.0.0");
    expect(existsSync(join(h, "bin/package.json"))).toBe(true);
  });

  it("currentVersion reads only exactly versions/<v> (L2)", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    for (const t of [
      "/elsewhere/versions/1.0.0",
      "versions/1.0.0/",
      "versions/../versions/1.0.0",
      "x/versions/1.0.0",
      "1.0.0",
    ]) {
      rmSync(join(h, "bin"), { force: true });
      symlinkSync(t, join(h, "bin"));
      expect(currentVersion(h)).toBeUndefined();
    }
    rmSync(join(h, "bin"), { force: true });
    symlinkSync("versions/1.0.0", join(h, "bin"));
    expect(currentVersion(h)).toBe("1.0.0");
  });

  it("reinstalling the running version works with the service stopped (L3)", () => {
    const h = home();
    installVersion(h, "1.0.0", put("1.0.0"));
    installVersion(h, "1.0.0", put("1.0.0"));
    expect(currentVersion(h)).toBe("1.0.0");
    expect(existsSync(join(h, "bin/package.json"))).toBe(true);
  });

  it("prune unlinks a stray symlink without following it and skips files (L4)", () => {
    const h = home();
    installVersion(h, "2.0.0", put("2.0.0"));
    const outside = mkdtempSync(join(tmpdir(), "oa-out-"));
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(h, "versions", "0.1.0"));
    writeFileSync(join(h, "versions", "note.txt"), "x");
    expect(prune(h, ["2.0.0"], { alive: () => false })).toEqual(["0.1.0"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");
    expect(existsSync(join(h, "versions", "note.txt"))).toBe(true);
    // A .live that is a link is not followed: the folder is kept.
    mkdirSync(versionDir(h, "0.2.0"));
    symlinkSync(outside, join(versionDir(h, "0.2.0"), ".live"));
    expect(prune(h, ["2.0.0"], { alive: () => false })).toEqual([]);
    // A marker that is a link is unlinked, never followed.
    mkdirSync(versionDir(h, "0.3.0"));
    mkdirSync(join(versionDir(h, "0.3.0"), ".live"));
    symlinkSync(
      join(outside, "keep"),
      join(versionDir(h, "0.3.0"), ".live", "77"),
    );
    expect(prune(h, ["2.0.0"], { alive: () => true })).toEqual(["0.3.0"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");
  });

  it("a symlinked home is allowed; the checks run on its target (L5)", () => {
    const real = home();
    const link = `${real}-link`;
    symlinkSync(real, link);
    installVersion(link, "1.0.0", put("1.0.0"));
    expect(currentVersion(real)).toBe("1.0.0");
    expect(existsSync(join(real, "versions/1.0.0/package.json"))).toBe(true);
    // The target being group-writable is still refused.
    chmodSync(real, 0o770);
    expect(() => installVersion(link, "1.1.0", put("1.1.0"))).toThrow(
      /writable by others/,
    );
  });

  it("writeState ignores an old file that is not a plain object (L6)", () => {
    const h = home();
    for (const junk of ["[1,2]", "null", '"s"', "7", "{oops"]) {
      writeFileSync(join(h, "update.json"), junk);
      writeState(h, { armed: true, current: "1.0.0" });
      expect(JSON.parse(readFileSync(join(h, "update.json"), "utf8"))).toEqual({
        armed: true,
        current: "1.0.0",
      });
    }
  });
});
