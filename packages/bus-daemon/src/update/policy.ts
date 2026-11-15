/**
 * Update policy (#2552, PR 3): pure rules, no I/O, no clock of their own.
 * Callers pass `now` (ms) and the persisted `PolicyState`.
 */

export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
export const QUIET_MS = 30_000;
export const READY_AFTER_MS = 24 * 60 * 60 * 1000;

/** What update.json holds for the policy, beside the layout's keys. */
export type PolicyState = {
  /** Only a hand-run install writes it. A missing file is not armed. */
  armed: boolean;
  /** update.json exists but cannot be read: no updates, "Update needs you". */
  unreadable: boolean;
  /** Set only by the local CLI. Nothing from the instance can clear it. */
  off: boolean;
  /** The newest version this machine has ever run. */
  newestRun?: string;
  /** The one kept previous version (the layout's `previous`). */
  previous?: string;
  /** The version running now (the layout's `current`). */
  current?: string;
  /** Versions that failed to start; never tried again (last MAX_LIST). */
  failed: string[];
  /** Versions whose proof was refused: retried later with a long backoff. */
  refused: Record<string, { at: number; count: number }>;
  /** When the last attempt began (ms); a step-back counts. */
  lastAt?: number;
  /**
   * The one staged, proven version waiting for a quiet moment. `manifest` is
   * the sha256 of every file in its folder, taken at stage time and checked
   * again right before the swap.
   */
  staged?: {
    version: string;
    readySince: number;
    manifest?: Record<string, string>;
  };
  /** A switch under way: written before the swap, cleared by the self-check. */
  pending?: { from: string; to: string; startedAt: number; attempts: number };
  /** Notices already sent, per version. */
  notified: Record<string, string[]>;
  /** The first-time line has been shown. */
  introShown: boolean;
  /** Set by the updater when a release wants a new kind of settings change. */
  needsYou: boolean;
};

/** Longest failed / refused / notified list kept. */
export const MAX_LIST = 20;
export const REFUSED_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const REFUSED_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** 24 h after the first refusal, doubling each time, never past 7 d. */
export const refusedBackoff = (count: number): number =>
  Math.min(
    REFUSED_BACKOFF_MS * 2 ** Math.max(0, Math.min(count, 30) - 1),
    REFUSED_BACKOFF_MAX_MS,
  );

export const emptyPolicy = (): PolicyState => ({
  armed: false,
  unreadable: false,
  off: false,
  failed: [],
  refused: {},
  notified: {},
  introShown: false,
  needsYou: false,
});

const XYZ = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Strict x.y.z, at most 32 chars; anything else is undefined. */
export function parseVersion(v: unknown): [number, number, number] | undefined {
  if (typeof v !== "string" || v.length > 32) return undefined;
  const m = XYZ.exec(v);
  if (!m) return undefined;
  const n = [Number(m[1]), Number(m[2]), Number(m[3])] as [
    number,
    number,
    number,
  ];
  return n.every(Number.isSafeInteger) ? n : undefined;
}

/** -1, 0, 1. Both must be x.y.z (check with parseVersion first). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new RangeError("compareVersions needs x.y.z");
  for (let i = 0; i < 3; i++) {
    if ((x[i] as number) < (y[i] as number)) return -1;
    if ((x[i] as number) > (y[i] as number)) return 1;
  }
  return 0;
}

export type Refusal =
  | "bad_version"
  | "not_armed"
  | "unreadable"
  | "refused_backoff"
  | "off"
  | "failed"
  | "not_forward"
  | "ahead_of_server"
  | "rate_limited"
  | "nothing_staged"
  | "login_in_progress"
  | "not_a_terminal";

export type Decision = { ok: true } | { ok: false; reason: Refusal };
const no = (reason: Refusal): Decision => ({ ok: false, reason });
const yes: Decision = { ok: true };

/**
 * Newest of the running code's own version, newestRun and current: what
 * "forward" is measured from. The running version is always in it, so a lost
 * or emptied update.json never lets an older version in.
 */
function floor(s: PolicyState, running?: string): string | undefined {
  const known = [running, s.newestRun, s.current].filter(
    (v): v is string => parseVersion(v) !== undefined,
  );
  return known.reduce<string | undefined>(
    (a, v) => (a === undefined || compareVersions(v, a) === 1 ? v : a),
    undefined,
  );
}

/** The 6 h limit. max(now, lastAt) so a clock set back never frees it early. */
export function rateLimited(s: PolicyState, now: number): boolean {
  if (s.lastAt === undefined) return false;
  return Math.max(now, s.lastAt) - s.lastAt < SIX_HOURS_MS;
}

export type Instruction = {
  version: string;
  /** The instance's explicit "return to the kept previous". */
  stepBack?: boolean;
};

/**
 * May the bus act on an instruction naming `version`? Forward only, except an
 * explicit step-back to the kept previous; never a failed version; never ahead
 * of the instance; one attempt per 6 h (a step-back is exempt, but counts for the next one). The instruction has no field that can
 * touch `off`.
 */
export function accept(
  s: PolicyState,
  i: Instruction,
  now: number,
  o: { server?: string; running?: string } = {},
): Decision {
  const serverVersion = o.server;
  if (parseVersion(i.version) === undefined) return no("bad_version");
  if (s.unreadable) return no("unreadable");
  if (!s.armed) return no("not_armed");
  if (s.off) return no("off");
  if (s.failed.includes(i.version)) return no("failed");
  const ref = s.refused[i.version];
  if (ref && Math.max(now, ref.at) - ref.at < refusedBackoff(ref.count))
    return no("refused_backoff");
  const base = floor(s, o.running);
  const isStepBack =
    i.stepBack === true && s.previous !== undefined && i.version === s.previous;
  if (!isStepBack) {
    if (base !== undefined && compareVersions(i.version, base) !== 1)
      return no("not_forward");
  }
  if (
    serverVersion !== undefined &&
    parseVersion(serverVersion) !== undefined &&
    compareVersions(i.version, serverVersion) === 1
  )
    return no("ahead_of_server");
  // A step back is never limited: a broken version must not keep running.
  if (!isStepBack && rateLimited(s, now)) return no("rate_limited");
  return yes;
}

/** What the daemon sees of itself for the quiet check. */
export type Busy = {
  pending: number;
  outbox: number;
  codexQueue: number;
};
export const isBusy = (b: Busy): boolean =>
  b.pending > 0 || b.outbox > 0 || b.codexQueue > 0;

/**
 * Quiet moments: idle for QUIET_MS continuous, and no login or approval in
 * progress. Feed it every poll; a busy poll restarts the wait.
 */
export class QuietTracker {
  private idleSince: number | undefined;
  private login = false;
  observe(now: number, busy: boolean, loginOrApproval: boolean): void {
    this.login = loginOrApproval;
    if (busy || loginOrApproval) this.idleSince = undefined;
    else if (this.idleSince === undefined) this.idleSince = now;
  }
  quiet(now: number): boolean {
    return (
      !this.login &&
      this.idleSince !== undefined &&
      now - this.idleSince >= QUIET_MS
    );
  }
}

/**
 * True once per staged version when it has waited 24 h without a quiet moment
 * ("Update ready to install"). The caller records the notice before sending.
 */
export function readyDue(s: PolicyState, now: number): boolean {
  const st = s.staged;
  if (!st || s.off) return false;
  if (s.notified[st.version]?.includes("ready")) return false;
  return Math.max(now, st.readySince) - st.readySince >= READY_AFTER_MS;
}

/**
 * "Install now" from Settings. Skips only the quiet wait. Never during login
 * or approval; the 6 h limit, failed memory and off all still apply.
 */
export function installNow(
  s: PolicyState,
  now: number,
  loginOrApproval: boolean,
): Decision {
  if (s.unreadable) return no("unreadable");
  if (!s.armed) return no("not_armed");
  if (s.off) return no("off");
  const st = s.staged;
  if (!st) return no("nothing_staged");
  if (s.failed.includes(st.version)) return no("failed");
  if (loginOrApproval) return no("login_in_progress");
  if (rateLimited(s, now)) return no("rate_limited");
  return yes;
}

/**
 * `oa-bus update`, run by a person. Installs only the staged version; needs a
 * terminal (stdin and stdout); may pass the 6 h limit; still refuses off and
 * a failed version. It cannot see a login in progress (that lives in the
 * daemon): PR 4 asks the daemon before it installs. Not a security boundary:
 * an agent with a terminal can run it.
 */
export function updateCommand(
  s: PolicyState,
  o: { stdinTTY: boolean; stdoutTTY: boolean },
): Decision {
  if (s.unreadable || !s.armed)
    return no(s.unreadable ? "unreadable" : "not_armed");
  if (!o.stdinTTY || !o.stdoutTTY) return no("not_a_terminal");
  if (s.off) return no("off");
  const st = s.staged;
  if (!st) return no("nothing_staged");
  if (s.failed.includes(st.version)) return no("failed");
  return yes;
}

export type UpdateLabel =
  | "Up to date"
  | "Updating soon"
  | "Update ready"
  | "Update needs you";

/** The state a person sees. */
export function label(s: PolicyState, now: number): UpdateLabel {
  if (s.needsYou || s.unreadable) return "Update needs you";
  const st = s.staged;
  if (!st) return "Up to date";
  return s.notified[st.version]?.includes("ready") || readyDue(s, now)
    ? "Update ready"
    : "Updating soon";
}
