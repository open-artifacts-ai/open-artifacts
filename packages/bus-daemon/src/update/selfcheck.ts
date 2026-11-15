import { existsSync } from "node:fs";
import {
  isSafeVersion,
  prune,
  readState,
  swap,
  versionDir,
  writeState,
} from "./layout.ts";
import { compareVersions } from "./policy.ts";
import { queueReport } from "./reports.ts";
import {
  clearPending,
  editPolicy,
  markFailed,
  noteRun,
  readPolicy,
  recordAttempt,
  releaseAttempt,
} from "./state.ts";

/**
 * Limit: a daemon whose event loop is blocked never runs this check; the shim
 * steps back on the next service restart (see rescue.ts).
 */
/** A new daemon has this long to be reachable, or the old version returns. */
export const SELF_CHECK_MS = 60_000;
const POLL_MS = 1000;

export type PendingSwitch = { from: string; to: string };

/** The new version works: it is current, the old one the one previous. */
export function completeUpdate(
  home: string,
  p: PendingSwitch,
  now: number,
): void {
  const st = readState(home);
  const downgrade = compareVersions(p.to, p.from) === -1;
  writeState(home, {
    armed: st.armed,
    current: p.to,
    // A return to the kept previous leaves no previous: exactly one is kept.
    ...(downgrade ? {} : { previous: p.from }),
  });
  noteRun(home, p.to);
  editPolicy(home, (s) => {
    delete s.pending;
    if (s.staged?.version === p.to) delete s.staged;
  });
  prune(home, downgrade ? [p.to] : [p.to, p.from]);
  queueReport(home, {
    event: "updated",
    from: p.from,
    to: p.to,
    reason: "ok",
    at: now,
  });
}

/**
 * The new version did not come up: `bin` back to the old one, the new one
 * remembered as failed, one attempt counted, a report queued. Returns whether
 * `bin` now points at `p.from`.
 */
export function abandonUpdate(
  home: string,
  p: PendingSwitch,
  now: number,
  reason: string,
): boolean {
  let back = false;
  if (isSafeVersion(p.from) && existsSync(versionDir(home, p.from))) {
    try {
      swap(home, p.from);
      const st = readState(home);
      writeState(home, {
        armed: st.armed,
        current: p.from,
        ...(st.previous !== undefined && st.previous !== p.from
          ? { previous: st.previous }
          : {}),
      });
      back = true;
    } catch {
      // bin stays where it is; the rescue shim tries again on the next start
    }
  }
  markFailed(home, p.to);
  recordAttempt(home, now);
  if (back) clearPending(home);
  queueReport(home, {
    event: "stepped_back",
    from: p.from,
    to: p.to,
    reason,
    at: now,
  });
  return back;
}

export type SelfCheckDeps = {
  home: string;
  /** The version this process runs from (its folder name). */
  running: string | undefined;
  now?: () => number;
  /** Hub link open, hello_ok received, every live agent announced. */
  ready: () => boolean;
  /** Ends the daemon non-zero so the service starts the old version. */
  exit: (code: number) => void;
  log: (msg: string) => void;
  deadlineMs?: number;
  every?: (fn: () => void, ms: number) => () => void;
};

export type SelfCheck = {
  /** "none": no switch under way. */
  state: () => "none" | "checking" | "ok" | "stepped_back";
  stop: () => void;
};

const realEvery = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

/**
 * Run at daemon start. When update.json says a switch to this very version is
 * pending, the daemon has SELF_CHECK_MS to be reachable; success makes it
 * current, anything else steps back and exits non-zero. A pending that names
 * another version is stale and cleared when it names the one running.
 */
export function startSelfCheck(d: SelfCheckDeps): SelfCheck {
  const now = d.now ?? Date.now;
  let state: ReturnType<SelfCheck["state"]> = "none";
  let stopTimer: () => void = () => {};
  const none: SelfCheck = { state: () => "none", stop: () => {} };
  let pending: PendingSwitch | undefined;
  try {
    const s = readPolicy(d.home);
    if (s.unreadable || !s.pending) return none;
    pending = { from: s.pending.from, to: s.pending.to };
  } catch {
    return none;
  }
  const p = pending;
  if (d.running !== p.to) {
    // The old version running with a pending left: the switch never happened.
    if (d.running === p.from) {
      try {
        clearPending(d.home);
      } catch {
        // unreadable: the rescue shim and the next start look again
      }
    }
    return none;
  }
  state = "checking";
  const t0 = now();
  const deadline = d.deadlineMs ?? SELF_CHECK_MS;
  const every = d.every ?? realEvery;
  const fail = (reason: string) => {
    stopTimer();
    state = "stepped_back";
    d.log(
      `the update to ${p.to} did not come up (${reason}): going back to ${p.from}`,
    );
    try {
      abandonUpdate(d.home, p, now(), reason);
    } catch (e) {
      d.log(
        `could not record the step back: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    d.exit(1);
  };
  const poll = () => {
    if (state !== "checking") return;
    let ok = false;
    try {
      ok = d.ready();
    } catch {
      ok = false;
    }
    if (ok) {
      stopTimer();
      state = "ok";
      try {
        completeUpdate(d.home, p, now());
        d.log(`updated to ${p.to}`);
      } catch (e) {
        d.log(
          `update ${p.to} is up but could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }
    if (now() - t0 >= deadline) fail("unhealthy");
  };
  stopTimer = every(poll, POLL_MS);
  return {
    state: () => state,
    stop: () => {
      stopTimer();
      // A clean stop mid-check (a shutdown, a reboot) is not a failed start.
      if (state === "checking") {
        state = "none";
        try {
          releaseAttempt(d.home);
        } catch {
          // unreadable: the rescue shim counts it as a start
        }
      }
    },
  };
}
