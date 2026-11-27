import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The rescue shim (#2552). The service runs `<home>/Open Artifacts Bus`, which sits
 * outside `versions/`: a hand-run install writes it and an update never does,
 * so a release that cannot start cannot break the way back.
 *
 * Before each start it reads `<home>/update.json` (written by the version that
 * did the switch) and nothing else: no network, no file of the new package.
 * A switch whose new version has been started a third time with no healthy
 * check in between is undone: `bin` goes back to the old version, the new one
 * is marked failed. It never looks at the clock: a machine that was off for
 * ten minutes mid-switch boots into the new version like any other start. The
 * 60 s uptime check is the new daemon's own (selfcheck.ts).
 *
 * Limit: a daemon whose event loop is blocked cannot run its own check, and
 * the unit has no watchdog that restarts a daemon that stops answering, so
 * the shim only steps back on the next service restart (a reboot, a login, a
 * crash). No watchdog is added here.
 * It then execs `bin/node bin/dist/index.js daemon`, as the unit used to.
 *
 * Three files: `rescue` (sh), `rescue-node` (a launcher that finds a node, the
 * same text as a version's own) and `rescue.mjs` (the logic, node:fs only).
 */

/**
 * Its own number. PR 5 reports it with the install, so the instance can tell
 * which machines hold an old shim. Bump on any change to the three files.
 *
 * Limit: the shim reads only `update.json`. When that file does not parse it
 * cannot act: it starts bin/node and does nothing else.
 */
export const RESCUE_VERSION = 1;

/** The new version gets this many starts before it is undone. */
export const RESCUE_MAX_STARTS = 2;

export const RESCUE_NAME = "Open Artifacts Bus";
export const rescueOf = (home: string) => join(home, RESCUE_NAME);

export function rescueShell(): string {
  return `#!/bin/sh
# Written by oa-bus install, never by an update. Rescue shim ${RESCUE_VERSION}.
case $0 in */*) here=\${0%/*} ;; *) here=. ;; esac
here=$(cd "$here" && pwd)
# A failure here must never keep the daemon from starting.
"$here/rescue-node" "$here/rescue.mjs" "$here" </dev/null >/dev/null 2>&1 || true
exec "$here/bin/node" "$@"
`;
}

export function rescueScript(): string {
  return `// Written by oa-bus install, never by an update. Rescue shim ${RESCUE_VERSION}.
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  openSync,
  fstatSync,
  linkSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_STARTS = ${RESCUE_MAX_STARTS};
const home = process.argv[2];
const XYZ = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/;
const SAFE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const file = join(home, "update.json");
const put = (path, text) => {
  const tmp = path + "." + process.pid + ".rescue.tmp";
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
};
const version = (v) => typeof v === "string" && v.length <= 32 && XYZ.test(v);
const target = () => {
  try {
    return /^versions\\/([^/]+)$/.exec(readlinkSync(join(home, "bin")))?.[1];
  } catch {
    return undefined;
  }
};
const report = (event, from, to, now) => {
  const f = join(home, "update-reports.json");
  let list = [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (Array.isArray(j)) list = j;
  } catch {}
  list.push({ event, from, to, reason: "unhealthy", at: now });
  put(f, JSON.stringify(list.slice(-50)) + "\\n");
};

function run() {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const p = j && j.pending;
  if (!p || !version(p.from) || !version(p.to)) return;
  if (typeof p.startedAt !== "number" || !Number.isInteger(p.attempts) || p.attempts < 0) return;
  const now = Date.now();
  const starts = p.attempts + 1;
  // Starts, never the clock: time off or a clock set back proves nothing.
  const stale = starts > MAX_STARTS;
  const cur = target();
  if (cur !== p.to && cur !== p.from) return;
  if (cur === p.to && !stale) {
    j.pending = { ...p, attempts: starts };
    put(file, JSON.stringify(j, null, 2) + "\\n");
    return;
  }
  if (cur === p.from) {
    // The switch never happened, or a step back finished: nothing to undo.
    delete j.pending;
    put(file, JSON.stringify(j, null, 2) + "\\n");
    return;
  }
  if (cur === p.to) {
    // Back to the old version: one rename of a new link over bin.
    if (!SAFE.test(p.from)) return;
    const st = lstatSync(join(home, "versions", p.from));
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    const tmp = join(home, "bin." + process.pid + ".rescue");
    rmSync(tmp, { recursive: true, force: true });
    symlinkSync(join("versions", p.from), tmp);
    renameSync(tmp, join(home, "bin"));
  }
  // bin is on the old version now (just undone, or an earlier step back did not finish).
  delete j.pending;
  j.current = p.from;
  j.failed = [...(Array.isArray(j.failed) ? j.failed : []).filter((v) => v !== p.to), p.to].slice(-20);
  j.lastAt = Math.max(now, typeof j.lastAt === "number" ? j.lastAt : 0);
  if (j.staged && j.staged.version === p.to) delete j.staged;
  put(file, JSON.stringify(j, null, 2) + "\\n");
  report("stepped_back", p.from, p.to, now);
}

try {
  run();
} catch {}
`;
}

/** This visible name can already belong to the user in a shared bus home. */
export function isManagedRescue(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  const shell = rescueShell();
  return (
    st?.isFile() === true &&
    st.size === Buffer.byteLength(shell) &&
    readFileSync(path, "utf8") === shell
  );
}

export function checkRescueDestination(home: string): void {
  const path = rescueOf(home);
  if (lstatSync(path, { throwIfNoEntry: false }) && !isManagedRescue(path))
    throw new Error(
      `Cannot install the launcher: ${path} already exists. Move it aside and rerun install.`,
    );
}

/** Writes the three files, atomically each. Only a hand-run install calls this. */
export function writeRescue(home: string, launcher: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  checkRescueDestination(home);
  const put = (name: string, text: string) => {
    const path = join(home, name);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text, { mode: 0o700 });
      chmodSync(tmp, 0o700);
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  };
  put("rescue.mjs", rescueScript());
  put("rescue-node", launcher);
  const dest = rescueOf(home);
  // Publish without replacing a file that appeared after preflight.
  const stage = join(home, `rescue.${process.pid}.tmp`);
  writeFileSync(stage, rescueShell(), { mode: 0o700, flag: "wx" });
  try {
    try {
      linkSync(stage, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const fd = openSync(
        dest,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const st = fstatSync(fd);
        if (
          !st.isFile() ||
          st.size !== Buffer.byteLength(rescueShell()) ||
          readFileSync(fd, "utf8") !== rescueShell()
        )
          throw new Error(`Cannot replace the existing file at ${dest}.`);
        fchmodSync(fd, 0o700);
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    rmSync(stage, { force: true });
  }
}

/** Called after the service manager starts the replacement, including on a retry. */
export function retireLegacyRescue(home: string): void {
  const path = join(home, "rescue");
  if (isManagedRescue(path)) rmSync(path, { force: true });
}
