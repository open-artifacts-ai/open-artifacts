import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { systemTool } from "@oa/bus-ipc";

/** Every OS read is bounded like `commOf`: a slow or failing read means "not attached". */
const READ_TIMEOUT_MS = 1500;

/**
 * What the daemon asks the OS about a TUI and an OpenCode service. Every
 * method returns null when it cannot tell; null never counts as attached.
 */
/** One established socket: `local` and `remote` as `addr:port`, `[v6]:port` for v6. */
export type Pair = { local: string; remote: string };

export type AttachDeps = {
  /** Real path of the pid's executable. */
  exeOf: (pid: number) => string | null;
  ppidOf: (pid: number) => number | null;
  /**
   * The pid's established TCP sockets as exact endpoint pairs (address and
   * port, family kept, v4-mapped v6 folded to v4). Null when unreadable.
   */
  established: (pid: number) => Pair[] | null;
};

/**
 * A predicate "this TUI pid is attached to `service`", for one hello: the
 * service's executable and listen ports are read once, not once per TUI.
 *
 * A TUI is attached when it runs the same executable as the service AND is
 * either the service's parent (a standalone TUI spawns its own server) or
 * holds the other end of one of the service's established connections. The executable check
 * is what stops a script under another service from writing a presence file
 * under its own pid and opening a socket to this service.
 *
 * Residual, accepted under #1856 option A (same user, same machine): a
 * same-user process that runs a real opencode process connected to this
 * service and writes a presence file for it can claim B through this service;
 * the incumbent keeps B's record, so a claim made first can block B through
 * another service until its service goes or no longer has B attached (a
 * same-user DoS). The cross-person line is unchanged.
 */
/** A binary replaced on disk reads `<path> (deleted)`: the same path, so the same program. */
export const exePath = (exe: string | null): string | null =>
  exe === null ? null : exe.replace(/ \(deleted\)$/, "");

export function attachedTo(
  service: number,
  deps: AttachDeps,
): (tui: number) => boolean {
  let svcExe: string | null | undefined;
  let svcSockets: Pair[] | null | undefined;
  let parent: number | null | undefined;
  return (tui) => {
    if (svcExe === undefined) svcExe = exePath(deps.exeOf(service));
    if (!svcExe) return false;
    if (exePath(deps.exeOf(tui)) !== svcExe) return false;
    if (parent === undefined) parent = deps.ppidOf(service);
    if (parent === tui) return true;
    if (svcSockets === undefined) svcSockets = deps.established(service);
    if (!svcSockets || svcSockets.length === 0) return false;
    const mine = deps.established(tui);
    if (!mine) return false;
    // Socket pairs, not ports: the TUI's socket and the service's are the two
    // ends of one connection, so 127.0.0.2:4096 is not 127.0.0.1:4096.
    return mine.some((t) =>
      svcSockets?.some((x) => x.remote === t.local && x.local === t.remote),
    );
  };
}

/** How long an attach answer (attached or not) is reused: one tool call is one hello. */
export const ATTACH_TTL_MS = 2000;

/**
 * `attachedTo` behind a short cache, so the OS reads (ps and lsof on macOS)
 * are paid once per TTL, not once per hello. An entry covers one service and
 * every TUI asked about for it, and dies as a whole after `ttlMs`; expired
 * entries are dropped on each call, so a gone pid never lingers. The clock is
 * injected; the cache sets no timers.
 */
export function cachedAttach(
  deps: AttachDeps,
  now: () => number = Date.now,
  ttlMs: number = ATTACH_TTL_MS,
): (service: number) => (tui: number) => boolean {
  const entries = new Map<
    number,
    { at: number; pred: (tui: number) => boolean; seen: Map<number, boolean> }
  >();
  return (service) => (tui) => {
    const t = now();
    for (const [k, e] of entries) if (t - e.at >= ttlMs) entries.delete(k);
    let e = entries.get(service);
    if (!e) {
      e = { at: t, pred: attachedTo(service, deps), seen: new Map() };
      entries.set(service, e);
    }
    let r = e.seen.get(tui);
    if (r === undefined) {
      r = e.pred(tui);
      e.seen.set(tui, r);
    }
    return r;
  };
}

// ---- Linux: /proc ----

type TcpRow = { state: string; local: string; remote: string; inode: string };

const hexWord = (w: string): string =>
  (w.match(/../g) ?? [])
    .reverse()
    .map((b) => Number.parseInt(b, 16))
    .join(".");

/** /proc prints each 32-bit word of an address little-endian. */
function hexAddr(hex: string): string | null {
  if (/^[0-9A-F]{8}$/i.test(hex)) return hexWord(hex);
  if (!/^[0-9A-F]{32}$/i.test(hex)) return null;
  const words = (hex.match(/.{8}/g) ?? []).map((w) =>
    (w.match(/../g) ?? []).reverse().join(""),
  );
  // ::ffff:a.b.c.d is the same endpoint as a.b.c.d.
  if (
    words[0] === "00000000" &&
    words[1] === "00000000" &&
    words[2]?.toUpperCase() === "0000FFFF"
  )
    return hexWord((hex.slice(24) ?? "").toUpperCase());
  const groups = words.flatMap((w) => [w.slice(0, 4), w.slice(4)]);
  return `[${groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}]`;
}

function endpoint(field: string): string | null {
  const [addr, port] = field.split(":");
  if (!addr || !port) return null;
  const a = hexAddr(addr);
  return a === null ? null : `${a}:${Number.parseInt(port, 16)}`;
}

/** Rows of /proc/net/tcp or tcp6 whose addresses parse. */
export function parseProcNetTcp(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !f[1] || !f[2] || !f[3] || !f[9]) continue;
    const local = endpoint(f[1]);
    const remote = endpoint(f[2]);
    if (local === null || remote === null) continue;
    rows.push({ state: f[3], local, remote, inode: f[9] });
  }
  return rows;
}

function socketInodes(pid: number): Set<string> | null {
  try {
    const out = new Set<string>();
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(
          readlinkSync(`/proc/${pid}/fd/${fd}`),
        );
        if (m?.[1]) out.add(m[1]);
      } catch {
        // an fd closed under us
      }
    }
    return out;
  } catch {
    return null;
  }
}

function tcpRows(): TcpRow[] | null {
  try {
    return [
      ...parseProcNetTcp(readFileSync("/proc/net/tcp", "utf8")),
      ...parseProcNetTcp(readFileSync("/proc/net/tcp6", "utf8")),
    ];
  } catch {
    return null;
  }
}

function linuxEstablished(pid: number): Pair[] | null {
  const inodes = socketInodes(pid);
  const rows = tcpRows();
  if (!inodes || !rows) return null;
  return rows
    .filter((r) => r.state === "01" && inodes.has(r.inode))
    .map((r) => ({ local: r.local, remote: r.remote }));
}

// ---- lsof (macOS) and ps ----

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(systemTool(cmd), args, {
      encoding: "utf8",
      timeout: READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** `lsof -Fn` name lines: `n127.0.0.1:49374` (listener) or `n127.0.0.1:5000->127.0.0.1:49374`. */
export function parseLsofNames(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1));
}

/** `[::ffff:127.0.0.1]:5` and `127.0.0.1:5` are one endpoint. */
function lsofEndpoint(e: string): string {
  const m = /^\[::ffff:(\d+\.\d+\.\d+\.\d+)\](:\d+)$/i.exec(e);
  return m ? `${m[1]}${m[2]}` : e.toLowerCase();
}

/** `n<local>-><remote>` lines of an ESTABLISHED listing. */
export function lsofEstablished(text: string): Pair[] {
  const out: Pair[] = [];
  for (const n of parseLsofNames(text)) {
    const [local, remote] = n.split("->");
    if (local && remote)
      out.push({ local: lsofEndpoint(local), remote: lsofEndpoint(remote) });
  }
  return out;
}

export const defaultAttachDeps: AttachDeps = {
  exeOf(pid) {
    if (process.platform === "linux") {
      try {
        // readlink, not realpath: a binary replaced in place (an update) reads "<path> (deleted)".
        return readlinkSync(`/proc/${pid}/exe`);
      } catch {
        return null;
      }
    }
    const out = run("ps", ["-o", "comm=", "-p", String(pid)])?.trim();
    return out?.startsWith("/") ? out : null;
  },
  ppidOf(pid) {
    const out = run("ps", ["-o", "ppid=", "-p", String(pid)])?.trim();
    return out && /^\d+$/.test(out) ? Number(out) : null;
  },
  established(pid) {
    if (process.platform === "linux") return linuxEstablished(pid);
    const out = run("lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-iTCP",
      "-sTCP:ESTABLISHED",
      "-Fn",
    ]);
    return out === null ? null : lsofEstablished(out);
  },
};
