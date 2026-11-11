import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { systemTool } from "@oa/bus-ipc";

/** Every OS read is bounded like `commOf`: a slow or failing read means "not attached". */
const READ_TIMEOUT_MS = 1500;

/**
 * What the daemon asks the OS about a TUI and an OpenCode service. Every
 * method returns null when it cannot tell; null never counts as attached.
 */
export type AttachDeps = {
  /** Real path of the pid's executable. */
  exeOf: (pid: number) => string | null;
  ppidOf: (pid: number) => number | null;
  /** Local ports the pid listens on (TCP, loopback or wildcard). */
  listenPorts: (pid: number) => Set<number> | null;
  /** Remote ports of the pid's established loopback TCP connections. */
  connectedPorts: (pid: number) => Set<number> | null;
};

/**
 * A predicate "this TUI pid is attached to `service`", for one hello: the
 * service's executable and listen ports are read once, not once per TUI.
 *
 * A TUI is attached when it runs the same executable as the service AND is
 * either the service's parent (a standalone TUI spawns its own server) or
 * holds a connection to a port the service listens on. The executable check
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
  let ports: Set<number> | null | undefined;
  let parent: number | null | undefined;
  return (tui) => {
    if (svcExe === undefined) svcExe = exePath(deps.exeOf(service));
    if (!svcExe) return false;
    if (exePath(deps.exeOf(tui)) !== svcExe) return false;
    if (parent === undefined) parent = deps.ppidOf(service);
    if (parent === tui) return true;
    if (ports === undefined) ports = deps.listenPorts(service);
    if (!ports || ports.size === 0) return false;
    const mine = deps.connectedPorts(tui);
    if (!mine) return false;
    for (const p of mine) if (ports.has(p)) return true;
    return false;
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

type TcpRow = {
  state: string;
  localPort: number;
  remote: string;
  inode: string;
};

/** Rows of /proc/net/tcp or tcp6. Addresses are hex; ports are big-endian hex. */
export function parseProcNetTcp(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [la, ra] = [f[1], f[2]];
    const lp = la?.split(":")[1];
    if (!la || !ra || !lp || !f[3] || !f[9]) continue;
    rows.push({
      state: f[3],
      localPort: Number.parseInt(lp, 16),
      remote: ra,
      inode: f[9],
    });
  }
  return rows;
}

// /proc prints addresses as little-endian 32-bit words: 127.0.0.1, ::1, ::ffff:127.0.0.1.
const LOOPBACK =
  /^(0100007F|00000000000000000000000001000000|0000000000000000FFFF00000100007F):/i;
const isLoopback = (remote: string): boolean => LOOPBACK.test(remote);

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

function linuxListenPorts(pid: number): Set<number> | null {
  const inodes = socketInodes(pid);
  const rows = tcpRows();
  if (!inodes || !rows) return null;
  const out = new Set<number>();
  for (const r of rows)
    if (r.state === "0A" && inodes.has(r.inode)) out.add(r.localPort);
  return out;
}

function linuxConnectedPorts(pid: number): Set<number> | null {
  const inodes = socketInodes(pid);
  const rows = tcpRows();
  if (!inodes || !rows) return null;
  const out = new Set<number>();
  for (const r of rows) {
    if (r.state !== "01" || !inodes.has(r.inode) || !isLoopback(r.remote))
      continue;
    const port = Number.parseInt(r.remote.split(":")[1] ?? "", 16);
    if (Number.isInteger(port)) out.add(port);
  }
  return out;
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

const portOf = (addr: string): number | null => {
  const m = /:(\d+)$/.exec(addr);
  return m?.[1] ? Number(m[1]) : null;
};

export function lsofListenPorts(text: string): Set<number> {
  const out = new Set<number>();
  for (const n of parseLsofNames(text)) {
    if (n.includes("->")) continue;
    const p = portOf(n);
    if (p !== null) out.add(p);
  }
  return out;
}

export function lsofConnectedPorts(text: string): Set<number> {
  const out = new Set<number>();
  for (const n of parseLsofNames(text)) {
    const [, remote] = n.split("->");
    if (!remote || !/^(127\.0\.0\.1|\[::1\]|localhost):/.test(remote)) continue;
    const p = portOf(remote);
    if (p !== null) out.add(p);
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
  listenPorts(pid) {
    if (process.platform === "linux") return linuxListenPorts(pid);
    const out = run("lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fn",
    ]);
    return out === null ? null : lsofListenPorts(out);
  },
  connectedPorts(pid) {
    if (process.platform === "linux") return linuxConnectedPorts(pid);
    const out = run("lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-iTCP",
      "-sTCP:ESTABLISHED",
      "-Fn",
    ]);
    return out === null ? null : lsofConnectedPorts(out);
  },
};
