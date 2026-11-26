import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readOwnFile } from "./own-file.ts";

export type SkillRefreshDeps = {
  readStored: () => string | undefined;
  writeStored: (version: string) => void;
  run: () => Promise<number>;
  log: (msg: string) => void;
};

export type SkillRefresher = {
  refresh: (serverVersion: string | undefined) => Promise<void>;
};

/** The lane a hello came on: each instance refreshes its own skill copies. */
export type HelloLane = { name: string; main: boolean; hub: string };

export type LaneSkillRefresher = {
  onHello: (
    lane: HelloLane,
    serverVersion: string | undefined,
  ) => Promise<void>;
};

/** A local instance name safe to put in a file name. */
const LANE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Reads the last instance version skills were refreshed for, or undefined. */
export function readSkillVersion(file: string): string | undefined {
  const f = readOwnFile(file, process.getuid?.(), { maxBytes: 1024 });
  if (f.state !== "ok") return undefined;
  const v = f.text.trim();
  return v || undefined;
}

/** Writes the refreshed instance version atomically, mode 0600. */
export function writeSkillVersion(file: string, version: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, `${version}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A release version as the hub sends it; anything else never reaches a log or a file. */
export const SKILL_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** How long one refresh may run before the child is killed. */
export const SKILL_REFRESH_DEADLINE_MS = 60_000;

/**
 * Runs the CLI's `skill --refresh --instance <hub>` with the same node and entry as the daemon:
 * fixed arguments, no shell, killed at the deadline.
 */
export function runSkillCommand(
  execPath: string,
  entry: string | undefined,
  hub: string,
  deadlineMs = SKILL_REFRESH_DEADLINE_MS,
): Promise<number> {
  if (!entry) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = spawn(
      execPath,
      [entry, "skill", "--refresh", "--instance", hub],
      {
        stdio: "ignore",
        shell: false,
        env: process.env,
      },
    );
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(124);
    }, deadlineMs);
    timer.unref?.();
    child.once("error", () => done(1));
    child.once("exit", (code) => done(code ?? 1));
  });
}

/**
 * Refreshes installed skills when the main instance's server_version changes.
 * At most one refresh runs at a time; a failure is logged and retried on the next hello.
 */
export function createSkillRefresher(deps: SkillRefreshDeps): SkillRefresher {
  let inFlight = false;
  // A version that failed is not tried again until the daemon restarts, so a
  // reconnect storm starts at most one child per version.
  const failed = new Set<string>();
  const refresh = async (serverVersion: string | undefined): Promise<void> => {
    const version = serverVersion?.trim();
    if (!version || !SKILL_VERSION_RE.test(version) || inFlight) return;
    if (failed.has(version) || deps.readStored() === version) return;
    inFlight = true;
    try {
      const code = await deps.run();
      if (code === 0) {
        deps.writeStored(version);
      } else {
        failed.add(version);
        deps.log(
          `skill refresh failed (exit ${code}) for instance version ${version}`,
        );
      }
    } catch (e) {
      failed.add(version);
      const msg = (e instanceof Error ? e.message : String(e))
        .split("")
        .map((ch) =>
          ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch,
        )
        .join("")
        .slice(0, 200);
      deps.log(`skill refresh failed (${msg}) for instance version ${version}`);
    } finally {
      inFlight = false;
    }
  };
  return { refresh };
}

/**
 * One refresher per instance, made on its first hello. A lane whose name is
 * not a plain local name is skipped.
 */
export function createLaneSkillRefresher(
  make: (lane: HelloLane) => SkillRefresher,
): LaneSkillRefresher {
  const byName = new Map<string, SkillRefresher>();
  return {
    onHello: (lane, serverVersion) => {
      if (!lane.main && !LANE_NAME_RE.test(lane.name)) return Promise.resolve();
      let r = byName.get(lane.name);
      if (!r) {
        r = make(lane);
        byName.set(lane.name, r);
      }
      return r.refresh(serverVersion);
    },
  };
}

/**
 * Default daemon wiring: main stores `skill-version`, another instance
 * `skill-version.<name>`, under `busHomeDir`; each runs `oa-bus skill --refresh
 * --instance <its hub>`.
 */
export function defaultSkillRefresher(
  busHomeDir: string,
  log: (msg: string) => void,
  entry: string,
): LaneSkillRefresher {
  return createLaneSkillRefresher((lane) => {
    const file = join(
      busHomeDir,
      lane.main ? "skill-version" : `skill-version.${lane.name}`,
    );
    return createSkillRefresher({
      readStored: () => readSkillVersion(file),
      writeStored: (v) => writeSkillVersion(file, v),
      run: () => runSkillCommand(process.execPath, entry, lane.hub),
      log: (m) => log(lane.main ? m : `${m} (${lane.name})`),
    });
  });
}
