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
  onHello: (
    isMain: boolean,
    serverVersion: string | undefined,
  ) => Promise<void>;
};

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
 * Runs the CLI's `skill --refresh` with the same node and entry as the daemon:
 * fixed arguments, no shell, killed at the deadline.
 */
export function runSkillCommand(
  execPath: string,
  entry: string | undefined,
  deadlineMs = SKILL_REFRESH_DEADLINE_MS,
): Promise<number> {
  if (!entry) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = spawn(execPath, [entry, "skill", "--refresh"], {
      stdio: "ignore",
      shell: false,
      env: process.env,
    });
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
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 200);
      deps.log(`skill refresh failed (${msg}) for instance version ${version}`);
    } finally {
      inFlight = false;
    }
  };
  return {
    refresh,
    onHello: (isMain: boolean, serverVersion: string | undefined) =>
      isMain ? refresh(serverVersion) : Promise.resolve(),
  };
}

/** Default daemon wiring: stores `skill-version` under `busHomeDir` and spawns `oa-bus skill`. */
export function defaultSkillRefresher(
  busHomeDir: string,
  log: (msg: string) => void,
  entry: string,
): SkillRefresher {
  const file = join(busHomeDir, "skill-version");
  return createSkillRefresher({
    readStored: () => readSkillVersion(file),
    writeStored: (v) => writeSkillVersion(file, v),
    run: () => runSkillCommand(process.execPath, entry),
    log,
  });
}
