import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { systemTool } from "@oa/bus-ipc";

export type Deps = {
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
  now: () => number;
  exec: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type Launcher = { cmd: string; args: string[] };

/** No shell on any platform: win32 uses rundll32, never `cmd /c start`. */
export const browserCommand = (
  platform: NodeJS.Platform,
  url: string,
): Launcher =>
  platform === "darwin"
    ? { cmd: "open", args: [url] }
    : platform === "win32"
      ? { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
      : { cmd: "xdg-open", args: [url] };

/** Resolves true once the launcher spawned, false if it could not start. */
export const openBrowser = (
  url: string,
  launcher: Launcher = browserCommand(process.platform, url),
): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const child = spawn(launcher.cmd, launcher.args, {
        stdio: "ignore",
        detached: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

/** No harness command may hang install or doctor: `opencode --version` included. */
export const EXEC_TIMEOUT_MS = 10_000;

/** Under vitest no test may load, start or stop a real unit on the machine. */
export function guardServiceManager(
  cmd: string,
  args: string[] = [],
  env = process.env,
): void {
  if (!env.VITEST) return;
  // Any element, whatever wraps it: env, nohup, timeout, xargs, sh -c "…".
  if ([cmd, ...args].some((a) => /\b(launchctl|systemctl)\b/.test(a)))
    throw new Error(`refusing to run ${cmd} under vitest: inject exec`);
}

/** The service managers run from the system dirs, never a PATH lookup. */
const SYSTEM_TOOLS = new Set(["launchctl", "systemctl"]);

/** What execFile runs for `cmd`: a service manager's absolute path, else `cmd`. */
export const resolveCmd = (cmd: string): string =>
  SYSTEM_TOOLS.has(cmd) ? systemTool(cmd) : cmd;

/** execFile with a kill at `timeoutMs`; a killed command fails like any other. */
export const makeExec =
  (timeoutMs: number): Deps["exec"] =>
  async (cmd, args) => {
    guardServiceManager(cmd, args);
    try {
      const r = await promisify(execFile)(resolveCmd(cmd), args, {
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const err = e as {
        code?: number | string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.killed
          ? `timed out after ${timeoutMs} ms`
          : (err.stderr ?? String(e)),
      };
    }
  };

export const realDeps: Deps = {
  fetch,
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  openBrowser: (url) => openBrowser(url),
  exec: makeExec(EXEC_TIMEOUT_MS),
};
