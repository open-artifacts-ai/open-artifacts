import { execFile, spawn } from "node:child_process";
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
    opts?: { env?: Record<string, string>; timeoutMs?: number; input?: string },
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

/**
 * execFile with a kill at `timeoutMs`; a killed command fails like any other.
 * The timeout is our own timer (not execFile's) so a test can drive it with
 * fake timers, but it behaves like execFile's: a timeout of 0 means none, an
 * invalid one fails before spawning, and on expiry the stdio pipes are
 * destroyed before the kill so a grandchild holding them open cannot keep the
 * result back. The output collected so far is returned.
 */
export const makeExec =
  (timeoutMs: number): Deps["exec"] =>
  (cmd, args, opts) =>
    new Promise((resolve) => {
      guardServiceManager(cmd, args);
      const ms = opts?.timeoutMs ?? timeoutMs;
      let timedOut = false;
      // execFile's own check (an integer in 0..MAX_SAFE_INTEGER, else
      // ERR_OUT_OF_RANGE, before spawning); the failure keeps its old shape.
      if (!Number.isInteger(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER) {
        const e = Object.assign(
          new RangeError(
            `The value of "timeout" is out of range. It must be ${Number.isInteger(ms) ? ">= 0 && <= 9007199254740991" : "an integer"}. Received ${ms}`,
          ),
          { code: "ERR_OUT_OF_RANGE" },
        );
        return resolve({ code: 1, stdout: "", stderr: String(e) });
      }
      let child: ReturnType<typeof execFile>;
      // execFile throws synchronously on input it rejects (a NUL byte in an
      // argument, say): that fails like any other command, as it always did.
      try {
        child = execFile(
          resolveCmd(cmd),
          args,
          {
            ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
            maxBuffer: 8 * 1024 * 1024,
            killSignal: "SIGKILL",
          },
          (e, stdout, stderr) => {
            clearTimeout(timer);
            if (!e) return resolve({ code: 0, stdout, stderr });
            const err = e as { code?: number | string };
            resolve({
              code: typeof err.code === "number" ? err.code : 1,
              stdout: stdout ?? "",
              stderr: timedOut
                ? `timed out after ${ms} ms`
                : (stderr ?? String(e)),
            });
          },
        );
      } catch (e) {
        return resolve({ code: 1, stdout: "", stderr: String(e) });
      }
      const timer =
        ms > 0
          ? setTimeout(() => {
              timedOut = true;
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.kill("SIGKILL");
            }, ms)
          : undefined;
      // Stdin is always closed (with `input`, or empty): a command that reads it never waits.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts?.input ?? "");
    });

export const realDeps: Deps = {
  fetch,
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  openBrowser: (url) => openBrowser(url),
  exec: makeExec(EXEC_TIMEOUT_MS),
};
