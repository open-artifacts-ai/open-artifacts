import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  daemonSocketPath,
  ensureSocketDir,
  MAX_SOCKET_PATH,
  busHome,
  claudeReturnDir as sharedReturnDir,
  shortSocketDir,
} from "@oa/bus-adapter-claude-code";
import { isMachineToken, newMachineLabel } from "@oa/bus-protocol";

export type Config = {
  hub: string;
  machine_id: string;
  label: string;
  machine_token: string;
};

export const home = () => busHome();
export const socketPath = () => daemonSocketPath(home());

/** Claude's return sockets (`<8 hex>.sock`): under the home, or the short folder when they would not fit. */
export const claudeReturnDir = (h = home()): string => sharedReturnDir(h);

/**
 * Creates the short socket folder when the daemon socket or the Claude return
 * folder is in it. A folder that another user made, or one open to them, is
 * never used, and neither is a socket path too long to bind: a lasting failure.
 */
export function prepareSocketDir(
  listenPath: string,
  returnDir: string,
  h = home(),
): void {
  if (Buffer.byteLength(listenPath) > MAX_SOCKET_PATH)
    throw new StartError(
      "SOCKET_PATH",
      `socket path is too long for a unix socket (${Buffer.byteLength(listenPath)} > ${MAX_SOCKET_PATH} bytes): ${listenPath}`,
    );
  const dir = shortSocketDir(h);
  if (![listenPath, returnDir].some((p) => p.startsWith(`${dir}/`))) return;
  const problem = ensureSocketDir(dir);
  if (problem)
    throw new StartError(
      "SOCKET_PATH",
      `${dir} ${problem}; refusing to use it`,
    );
}

/**
 * Readies Claude's return folder before each bind. In the short folder both
 * levels are re-checked every time: a cleaner may have removed them, and
 * another user recreated one, since the daemon started. Null when safe.
 */
export function prepareReturnDir(dir: string, h = home()): string | null {
  const short = shortSocketDir(h);
  if (dir.startsWith(`${short}/`)) {
    const why = ensureSocketDir(short) ?? ensureSocketDir(dir);
    return why && `${dir} ${why}`;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return null;
}

const NOT_LOGGED_IN = "not logged in: run `npx @open-artifacts/bus install`";

/** Start failures no restart fixes; the service matches on `code`, never the message. */
export const START_ERROR_CODES = [
  "NOT_LOGGED_IN",
  "HUB_MISMATCH",
  "BAD_HUB",
  "CREDENTIALS_OPEN",
  "CREDENTIALS_UNREADABLE",
  "REVOKED",
  "SOCKET_IN_USE",
  "SOCKET_PATH",
] as const;
export type StartErrorCode = (typeof START_ERROR_CODES)[number];

export class StartError extends Error {
  readonly code: StartErrorCode;
  constructor(code: StartErrorCode, message: string) {
    super(message);
    this.name = "StartError";
    this.code = code;
  }
}

const notLoggedIn = () => new StartError("NOT_LOGGED_IN", NOT_LOGGED_IN);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkHub(hub: string): void {
  let u: URL;
  try {
    u = new URL(hub);
  } catch {
    throw new StartError("BAD_HUB", `invalid hub url: ${hub}`);
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) {
    throw new StartError("BAD_HUB", `invalid hub url scheme: ${u.protocol}`);
  }
  if (
    (u.protocol === "ws:" || u.protocol === "http:") &&
    !LOOPBACK.has(u.hostname)
  ) {
    throw new StartError(
      "BAD_HUB",
      `refusing ${u.protocol}// to non-loopback host ${u.hostname}: the machine token would travel in the clear; use wss://`,
    );
  }
}

/** ws and http name the same server: compare as http(s) origins. */
function originOf(url: string): string | undefined {
  try {
    const u = new URL(url.replace(/^ws(s?):/, "http$1:"));
    return u.origin;
  } catch {
    return undefined;
  }
}

// An old or hand-edited label must not make the hub reject every hello.
const cleanLabel = (raw: unknown): string =>
  typeof raw === "string" ? newMachineLabel(raw) : "machine";

/** How the revoked marker names a token: its sha256, never the token. */
export const tokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** The revoked marker's body for `token`. */
export const revokedMarker = (token: string, at = new Date()): string =>
  `${JSON.stringify({ at: at.toISOString(), token_sha256: tokenHash(token) })}\n`;

/**
 * Whether `h`'s revoked marker holds for `token`. A marker for another token
 * is stale: `login` saved a newer one since. One that names no token (an
 * older daemon's) or cannot be read still holds.
 */
export function revokedFor(token: string, h = home()): boolean {
  const file = join(h, "revoked");
  if (!existsSync(file)) return false;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as {
      token_sha256?: unknown;
    };
    if (typeof m.token_sha256 === "string")
      return m.token_sha256 === tokenHash(token);
  } catch {}
  return true;
}

/** machine.json's token as saved now, or undefined when there is none to read. */
export function savedToken(h = home()): string | undefined {
  try {
    const r = JSON.parse(readFileSync(join(h, "machine.json"), "utf8")) as {
      machine_token?: unknown;
    };
    return typeof r.machine_token === "string" ? r.machine_token : undefined;
  } catch {
    return undefined;
  }
}

export function readConfig(): Config {
  const file = join(home(), "machine.json");
  let text: string;
  try {
    if (process.platform !== "win32" && statSync(file).mode & 0o077) {
      throw new StartError(
        "CREDENTIALS_OPEN",
        `${file} is readable by other users: run \`chmod 600 ${file}\``,
      );
    }
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notLoggedIn();
    // Owned by another user (a `sudo npx @open-artifacts/bus`): no restart fixes it.
    if (code === "EACCES" || code === "EPERM")
      throw new StartError(
        "CREDENTIALS_UNREADABLE",
        `cannot read ${file} (${code}): it must belong to you`,
      );
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the source, which holds the token.
    throw notLoggedIn();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw notLoggedIn();
  }
  const r = raw as Partial<Config>;
  // A token with no hub of its own never goes to whatever OA_BUS_HUB names.
  if (typeof r.hub !== "string" || !r.hub || r.machine_token === undefined)
    throw notLoggedIn();
  // The hub refused this token; `npx @open-artifacts/bus install` approves it again and clears the marker.
  if (revokedFor(String(r.machine_token)))
    throw new StartError(
      "REVOKED",
      "this machine was revoked; run `npx @open-artifacts/bus install`",
    );
  const hub = process.env.OA_BUS_HUB || r.hub;
  // The token goes only to the hub that issued it.
  if (hub !== r.hub && originOf(hub) !== originOf(r.hub))
    throw new StartError(
      "HUB_MISMATCH",
      `the hub ${hub} is not the one this machine was approved for (${r.hub}); run \`npx @open-artifacts/bus login --hub ${hub}\` to approve it there`,
    );
  if (!isMachineToken(r.machine_token)) {
    throw new StartError(
      "NOT_LOGGED_IN",
      "machine.json has a malformed machine token: run `npx @open-artifacts/bus install`",
    );
  }
  checkHub(hub);
  return {
    hub,
    machine_id: r.machine_id ?? "",
    label: cleanLabel(r.label),
    machine_token: r.machine_token,
  };
}
