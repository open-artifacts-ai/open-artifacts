import { execFileSync } from "node:child_process";
import { systemTool } from "./sysbin.ts";

/** `ps` did not answer in time (a loaded machine): the process may well be alive. Not "gone". */
export class ProcStartUnknownError extends Error {
  constructor(pid: number) {
    super(`ps for pid ${pid} timed out`);
  }
}

/** Bound on one `ps`, so a loaded machine cannot stall a caller for seconds. */
export const PS_TIMEOUT_MS = 1500;

export const psField = (field: string, pid: number): string | null => {
  try {
    return (
      execFileSync(systemTool("ps"), ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
        timeout: PS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        // Claude writes procStart as `TZ=UTC LC_ALL=C ps -o lstart=`.
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      }).trim() || null
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ETIMEDOUT")
      throw new ProcStartUnknownError(pid);
    return null;
  }
};

export const procStartOf = (pid: number): string | null =>
  psField("lstart", pid);
