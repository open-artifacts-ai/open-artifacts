import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `<home>/login.active`: written by `oa-bus login` while it waits for a
 * person's approval, so an update never restarts the daemon under it. The
 * login runs in its own process, so a file is how the daemon and the update
 * command see it. A stale one (dead pid or old) counts for nothing.
 */
export const loginFlagFile = (home: string) => join(home, "login.active");
export const LOGIN_FLAG_MAX_MS = 15 * 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Marks a login under way; the returned function clears it. Never throws. */
export function markLoginActive(
  home: string,
  now: () => number = Date.now,
): () => void {
  try {
    writeFileSync(loginFlagFile(home), `${process.pid} ${now()}\n`, {
      mode: 0o600,
    });
  } catch {
    return () => {};
  }
  return () => rmSync(loginFlagFile(home), { force: true });
}

export function loginActive(
  home: string,
  now: () => number = Date.now,
  isAlive: (pid: number) => boolean = alive,
): boolean {
  try {
    const [pid, at] = readFileSync(loginFlagFile(home), "utf8")
      .trim()
      .split(" ")
      .map(Number);
    return (
      Number.isInteger(pid) &&
      Number.isFinite(at) &&
      Math.abs(now() - (at as number)) < LOGIN_FLAG_MAX_MS &&
      isAlive(pid as number)
    );
  } catch {
    return false;
  }
}
