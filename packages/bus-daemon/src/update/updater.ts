import {
  chmodSync,
  copyFileSync,
  existsSync,
  type FSWatcher,
  readFileSync,
  rmSync,
  watch,
} from "node:fs";
import { basename, join } from "node:path";
import { ReleaseError } from "./errors.ts";
import { type FetchedRelease, fetchRelease } from "./fetch.ts";
import {
  hashTree,
  isSafeVersion,
  prune,
  stage,
  swap,
  treeMatches,
  versionDir,
} from "./layout.ts";
import { loginFlagFile } from "./login-flag.ts";
import {
  accept,
  type Busy,
  compareVersions,
  type Decision,
  type Instruction,
  installNow,
  isBusy,
  parseVersion,
  type Refusal,
  readyDue,
  startupRetryAt,
} from "./policy.ts";
import { queueReport } from "./reports.ts";
import {
  clearPending,
  clearStaged,
  editPolicy,
  markNotified,
  markRefused,
  readPolicy,
  recordAttempt,
  setNeedsYou,
  setPending,
  setStaged,
  takeInstallRequest,
} from "./state.ts";
import { unpackTo } from "./tar.ts";
import { type VerifiedRelease, verifyRelease } from "./verify.ts";

/**
 * The updater loop switch (#2552). On: the loop acts only for a version the
 * instance names (or the person's own `oa-bus update`), and only an armed,
 * not-off install ever runs it.
 */
export const UPDATER_LOOP_ENABLED: boolean = true;

const IDLE_DEADLINE_MS = 30 * 60_000;

export const TICK_MS = 5000;
/** A fetch that failed for the network: tried again after this long. */
/** An `oa-bus update` request older than this is ignored. */
export const REQUEST_MAX_MS = 5 * 60_000;
export const RETRY_MS = 10 * 60_000;

export type UpdaterDeps = {
  home: string;
  /** The version this daemon runs from; undefined (a workspace): never updates. */
  running: string | undefined;
  /** Tests only; the production caller never passes it. */
  enabled?: boolean;
  now?: () => number;
  busy: () => Busy;
  /** A login or an approval is under way. */
  loginActive: () => boolean;
  /** The hub link is open and hello_ok has come: a switch waits for it. */
  hubReady: () => boolean;
  /**
   * Tells the hub a switch is about to happen and waits for its yes (5 s).
   * False (no, no answer, no cap, link down): the switch is held and tried
   * again later (#2552).
   */
  announceSwitch: (
    from: string,
    to: string,
    /** "requested": the person asked on this machine; else "ok". */
    reason?: "ok" | "requested",
  ) => Promise<boolean>;
  /** The hub's version from its last hello_ok, when known. */
  serverVersion: () => string | undefined;
  /** Ends the daemon non-zero so the service starts the new version. */
  exit: (code: number) => void;
  log: (msg: string) => void;
  fetch?: (version: string) => Promise<FetchedRelease>;
  verify?: (rel: FetchedRelease) => VerifiedRelease;
  every?: (fn: () => void, ms: number) => () => void;
};

export type UpdateOutcome =
  | { kind: "disabled" }
  | { kind: "refused"; reason: Refusal }
  | { kind: "staged"; version: string }
  | { kind: "needs_you" }
  | { kind: "proof_refused"; code: string }
  | { kind: "retry_later" }
  | { kind: "switching"; version: string };

/** `oaBus.settingsKinds` of a package.json, read as data: undefined when malformed. */
export function settingsKinds(pkg: unknown): string[] | undefined {
  if (pkg === null || typeof pkg !== "object") return undefined;
  const meta = (pkg as { oaBus?: unknown }).oaBus;
  const kinds =
    meta !== null && typeof meta === "object"
      ? (meta as { settingsKinds?: unknown }).settingsKinds
      : undefined;
  if (kinds === undefined) return [];
  if (!Array.isArray(kinds) || kinds.length > 50) return undefined;
  if (
    !kinds.every((k) => typeof k === "string" && /^[a-z0-9._-]{1,40}$/.test(k))
  )
    return undefined;
  return kinds as string[];
}

const realEvery = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

export class Updater {
  private stopTick: () => void = () => {};
  private working = false;
  private loginWas = false;
  private loginWatch?: FSWatcher;
  private activeFlagWatch?: FSWatcher;
  private idleCheckPending = false;
  private retry?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  /** One swap at a time: every switchTo caller goes through this. */
  private switching = false;
  private wanted: { i: Instruction; at: number } | undefined;
  private readonly d: UpdaterDeps;
  /** Decided once: the loop's flag, and a running version that is x.y.z. */
  private readonly active: boolean;
  /** An instance-asked step back held back by a login in progress. */
  /** Malformed instructions already reported (by their text), at most 20. */
  private readonly reportedBad = new Set<string>();
  private stepBackHeld: Instruction | undefined;
  constructor(d: UpdaterDeps) {
    this.d = d;
    this.active =
      (d.enabled ?? UPDATER_LOOP_ENABLED) &&
      parseVersion(d.running) !== undefined;
  }

  private get enabled(): boolean {
    return this.active;
  }
  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(): void {
    if (!this.enabled) return;
    const flag = basename(loginFlagFile(this.d.home));
    // Login runs in another process. Watch its parent so unlink and recreation
    // of the flag are both visible for the lifetime of the daemon.
    this.loginWatch = watch(this.d.home, { persistent: false }, (_, name) => {
      if (
        (name === flag || name === null) &&
        this.loginWas &&
        !this.d.loginActive()
      ) {
        this.idleCheckPending = true;
        if (!this.working) void this.onIdle();
      }
    });
    this.loginWatch.on("error", (error) =>
      this.d.log(`update: login watcher: ${error.message}`),
    );
    this.stopTick = (this.d.every ?? realEvery)(
      () => void this.tick(),
      TICK_MS,
    );
  }
  stop(): void {
    clearTimeout(this.retry);
    clearTimeout(this.deadline);
    this.loginWatch?.close();
    this.activeFlagWatch?.close();
    this.idleCheckPending = false;
    this.stopTick();
  }

  /** The version the instance last named (hello_ok or a push); "Install now" must match it. */
  private named: string | undefined;

  /**
   * The instance names `version` (BUS_CAPS.runVersion). The one kept previous
   * is a step back; the running version is no instruction at all.
   */
  async instructFromInstance(version: string): Promise<UpdateOutcome> {
    if (parseVersion(version) === undefined) return this.instruct({ version });
    clearTimeout(this.retry);
    this.named = version;
    const { running } = this.d;
    if (running === undefined) return { kind: "disabled" };
    const s = readPolicy(this.d.home);
    if (version === running) {
      // Named is what runs: a newer staged version is a rollout to stop (#2719).
      const old = s.staged?.version;
      if (old !== undefined && old !== version) {
        clearStaged(this.d.home);
        this.dropStaged(old);
      }
      return { kind: "disabled" };
    }
    const stepBack =
      s.previous === version && compareVersions(version, running) === -1;
    return this.instruct({ version, ...(stepBack ? { stepBack: true } : {}) });
  }

  /**
   * The instance names no version (cleared, #2719): nothing it staged may be
   * swapped in, whatever was named before. The person's own install request
   * still works.
   */
  clearNamed(): void {
    clearTimeout(this.retry);
    clearTimeout(this.deadline);
    this.named = undefined;
  }

  /**
   * "Install now" from Settings: a frame with no field. Honored only for the
   * staged version the instance names, never during a login, never past
   * `off`, the failed list or the 6 h failure backoff.
   */
  async installNowFromInstance(): Promise<UpdateOutcome> {
    if (!this.enabled) return { kind: "disabled" };
    const s = readPolicy(this.d.home);
    const st = s.staged;
    if (!st || this.named !== st.version)
      return { kind: "refused", reason: "nothing_staged" };
    const d = installNow(s, this.now(), this.d.loginActive());
    if (!d.ok) return { kind: "refused", reason: d.reason };
    return this.switchTo(st.version, true);
  }

  /** The version the instance names. Stages it and swaps once the daemon is idle. */
  async instruct(i: Instruction): Promise<UpdateOutcome> {
    if (!this.enabled) return { kind: "disabled" };
    const { home, running } = this.d;
    if (running === undefined) return { kind: "disabled" };
    const now = this.now();
    const s = readPolicy(home);
    const server = this.d.serverVersion();
    const dec = accept(s, i, now, { running, ...(server ? { server } : {}) });
    if (!dec.ok) {
      const delay = startupRetryAt(s, i.version) - now;
      if (
        dec.reason === "refused_backoff" &&
        delay > 0 &&
        this.named === i.version
      ) {
        clearTimeout(this.retry);
        this.retry = setTimeout(
          () => {
            if (this.named === i.version)
              void this.instructFromInstance(i.version).catch((err) =>
                this.d.log(`update retry: ${err}`),
              );
          },
          Math.min(delay, 2_147_483_647),
        );
        this.retry.unref();
      }
      this.refuse(running, i.version, dec);
      return { kind: "refused", reason: dec.reason };
    }
    if (i.stepBack === true) {
      // Back to the kept previous: no download and no idle wait, but never
      // under a login or approval (the bus's own step back after a failed
      // start is the self-check's and does not wait).
      if (this.d.loginActive() || !this.d.hubReady()) {
        this.stepBackHeld = i;
        return { kind: "retry_later" };
      }
      const r = await this.switchTo(i.version, false);
      // #2719: the one-swap lock (or a hub that did not answer) holds it too.
      if (r.kind === "retry_later") this.stepBackHeld = i;
      return r;
    }
    if (s.staged?.version === i.version && s.staged.manifest) {
      if (treeMatches(versionDir(home, i.version), s.staged.manifest)) {
        void this.onIdle();
        return { kind: "staged", version: i.version };
      }
    }
    const out = await this.stage(i, now);
    if (out.kind === "staged") void this.onIdle();
    return out;
  }

  private refuse(
    from: string,
    to: string,
    d: Extract<Decision, { ok: false }>,
  ): void {
    // Only a forbidden instruction is worth a report; waiting is not. Each is
    // reported once: the hub repeats its instruction on every hello.
    if (
      d.reason !== "bad_version" &&
      d.reason !== "ahead_of_server" &&
      d.reason !== "not_forward"
    )
      return;
    const named = parseVersion(to) ? to : "";
    const reason = d.reason === "bad_version" ? "bad_instruction" : d.reason;
    if (named === "") {
      if (this.reportedBad.has(to)) return;
      if (this.reportedBad.size < 20) this.reportedBad.add(to);
    } else {
      try {
        const key = `refused:${reason}`;
        const list = readPolicy(this.d.home).notified[named] ?? [];
        if (list.includes(key)) return;
        editPolicy(this.d.home, (s) => {
          s.notified[named] = [...(s.notified[named] ?? []), key];
        });
      } catch {
        // unreadable: report this once, in memory
        if (this.reportedBad.has(`${named}:${reason}`)) return;
        this.reportedBad.add(`${named}:${reason}`);
      }
    }
    queueReport(this.d.home, {
      event: "refused",
      from,
      to: named,
      reason,
      at: this.now(),
    });
  }

  private async stage(i: Instruction, now: number): Promise<UpdateOutcome> {
    const { home, running } = this.d;
    const from = running as string;
    let verified: VerifiedRelease;
    try {
      const rel = await (this.d.fetch ?? fetchRelease)(i.version);
      verified = (this.d.verify ?? verifyRelease)(rel);
    } catch (e) {
      if (!(e instanceof ReleaseError)) {
        this.d.log(
          `update ${i.version}: ${e instanceof Error ? e.message : String(e)}`,
        );
        this.wanted = { i, at: this.now() };
        return { kind: "retry_later" };
      }
      if (e.code === "fetch_failed") {
        this.wanted = { i, at: this.now() };
        return { kind: "retry_later" };
      }
      this.wanted = undefined;
      if (e.code === "node_too_old" || e.code === "stale_trust_root") {
        setNeedsYou(home, true);
        queueReport(home, {
          event: "needs_you",
          from,
          to: i.version,
          reason: e.code,
          at: now,
        });
        return { kind: "needs_you" };
      }
      markRefused(home, i.version, now);
      queueReport(home, {
        event: "refused",
        from,
        to: i.version,
        reason: e.code,
        at: now,
      });
      this.d.log(`update ${i.version} refused: ${e.code}`);
      return { kind: "proof_refused", code: e.code };
    }
    this.wanted = undefined;
    // Settings kinds, read from the verified package as data only (N3).
    const next = settingsKinds(verified.packageJson);
    const have = this.runningKinds();
    if (
      next === undefined ||
      have === undefined ||
      next.some((k) => !have.includes(k))
    ) {
      setNeedsYou(home, true);
      queueReport(home, {
        event: "needs_you",
        from,
        to: i.version,
        reason: "needs_you",
        at: now,
      });
      return { kind: "needs_you" };
    }
    const launcher = join(versionDir(home, from), "node");
    let manifest: Record<string, string>;
    try {
      const dest = stage(home, i.version, (dir) => {
        unpackTo(verified.entries, dir);
        if (!existsSync(join(dir, "dist", "index.js")))
          throw new Error("no dist/index.js");
        if (existsSync(launcher)) {
          copyFileSync(launcher, join(dir, "node"));
          chmodSync(join(dir, "node"), 0o700);
        }
      });
      manifest = hashTree(dest);
    } catch (e) {
      markRefused(home, i.version, now);
      queueReport(home, {
        event: "refused",
        from,
        to: i.version,
        reason: "bad_tar",
        at: now,
      });
      this.d.log(
        `update ${i.version} could not be unpacked: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { kind: "proof_refused", code: "bad_tar" };
    }
    // At most one staged version: a newer one replaces the older.
    const old = readPolicy(home).staged?.version;
    setStaged(home, i.version, now, manifest);
    if (old !== undefined && old !== i.version) this.dropStaged(old);
    setNeedsYou(home, false);
    return { kind: "staged", version: i.version };
  }

  private runningKinds(): string[] | undefined {
    const { home, running } = this.d;
    if (running === undefined) return undefined;
    try {
      return settingsKinds(
        JSON.parse(
          readFileSync(join(versionDir(home, running), "package.json"), "utf8"),
        ),
      );
    } catch {
      return undefined;
    }
  }

  private dropStaged(version: string): void {
    const s = readPolicy(this.d.home);
    if (
      version === this.d.running ||
      version === s.current ||
      version === s.previous
    )
      return;
    if (isSafeVersion(version))
      rmSync(versionDir(this.d.home, version), {
        recursive: true,
        force: true,
      });
  }

  /** Installs a staged, named version when the daemon is idle. */
  async onIdle(): Promise<void> {
    if (!this.enabled || this.working) return;
    this.working = true;
    try {
      this.idleCheckPending = false;
      await this.installIfIdle(this.now());
    } catch (e) {
      this.d.log(`update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.working = false;
      if (this.idleCheckPending) void this.onIdle();
    }
  }

  private async installIfIdle(now: number): Promise<void> {
    const login = this.d.loginActive();
    this.loginWas = login;
    clearTimeout(this.deadline);
    if (login) {
      if (this.loginWatch && !this.activeFlagWatch) {
        try {
          this.activeFlagWatch = watch(
            loginFlagFile(this.d.home),
            { persistent: false },
            () => {
              if (this.d.loginActive()) return;
              this.idleCheckPending = true;
              if (!this.working) void this.onIdle();
            },
          );
          this.activeFlagWatch.on("error", (error) =>
            this.d.log(error.message),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!this.d.loginActive()) this.idleCheckPending = true;
      }
      return;
    }
    this.activeFlagWatch?.close();
    this.activeFlagWatch = undefined;
    const s = readPolicy(this.d.home);
    if (s.unreadable || !s.armed || s.off) return;
    const st = s.staged;
    // #2719: only the version the instance names now (cleared: none).
    if (!st || this.named !== st.version) return;
    if (!installNow(s, now, login).ok) return;
    const remaining = st.readySince + IDLE_DEADLINE_MS - now;
    if (remaining > 0 && isBusy(this.d.busy())) {
      this.deadline = setTimeout(() => {
        this.idleCheckPending = true;
        if (!this.working) void this.onIdle();
      }, remaining);
      this.deadline.unref();
      return;
    }
    await this.switchTo(st.version, true);
  }

  /** One poll: held step-back, fetch retry, the "ready" notice, the install request, login-end edge. */
  async tick(): Promise<void> {
    if (!this.enabled || this.working) return;
    this.working = true;
    try {
      const now = this.now();
      const login = this.d.loginActive();
      const loginEnded = this.loginWas && !login;
      this.loginWas = login;
      if (this.stepBackHeld && !login) {
        const held = this.stepBackHeld;
        this.stepBackHeld = undefined;
        await this.instruct(held);
      }
      let justStaged = false;
      if (this.wanted && now - this.wanted.at >= RETRY_MS) {
        const { i } = this.wanted;
        this.wanted = undefined;
        const out = await this.instruct(i);
        if (out.kind === "staged") justStaged = true;
      }
      const s = readPolicy(this.d.home);
      if (s.unreadable || !s.armed || s.off) return;
      // One-shot: taken even when nothing is staged, so it never lingers.
      const req = takeInstallRequest(this.d.home);
      const st = s.staged;
      if (!st) return;
      if (readyDue(s, now) && markNotified(this.d.home, st.version, "ready"))
        queueReport(this.d.home, {
          event: "ready_24h",
          from: this.d.running ?? "",
          to: st.version,
          reason: "not_quiet_24h",
          at: now,
        });
      if (req) {
        // The person's own command: it passes the 6 h limit and busy checks.
        if (
          req.version === st.version &&
          !login &&
          now - req.at < REQUEST_MAX_MS
        )
          await this.switchTo(st.version, true, true);
        return;
      }
      if (loginEnded || justStaged) await this.installIfIdle(now);
    } catch (e) {
      this.d.log(`update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.working = false;
      if (this.idleCheckPending) void this.onIdle();
    }
  }

  /**
   * The swap: re-hash what was staged, write `pending`, point `bin` at it and
   * exit non-zero so the service restarts the daemon from the new folder.
   */
  private async switchTo(
    version: string,
    staged: boolean,
    person = false,
  ): Promise<UpdateOutcome> {
    if (this.switching) return { kind: "retry_later" };
    this.switching = true;
    try {
      return await this.doSwitch(version, staged, person);
    } finally {
      this.switching = false;
    }
  }

  private async doSwitch(
    version: string,
    staged: boolean,
    person: boolean,
  ): Promise<UpdateOutcome> {
    const { home, running } = this.d;
    const now = this.now();
    if (running === undefined || !isSafeVersion(version) || version === running)
      return { kind: "disabled" };
    // #2719: a version the instance staged swaps in only while it is the one
    // named now; the person's own request and a step back are not that.
    if (staged && !person && this.named !== version)
      return { kind: "refused", reason: "nothing_staged" };
    // A switch happens only while the hub answers: the new daemon's check
    // needs it, and an update must not start into an outage.
    if (!this.d.hubReady()) return { kind: "retry_later" };
    const s = readPolicy(home);
    if (staged) {
      const m = s.staged?.manifest;
      if (
        !m ||
        s.staged?.version !== version ||
        !treeMatches(versionDir(home, version), m)
      ) {
        // The folder is not what was proven: drop it and fetch again later.
        markRefused(home, version, now);
        queueReport(home, {
          event: "refused",
          from: running,
          to: version,
          reason: "staged_changed",
          at: now,
        });
        rmSync(versionDir(home, version), { recursive: true, force: true });
        clearStaged(home);
        return { kind: "proof_refused", code: "staged_changed" };
      }
      // Forward only, still: something newer may have run since it was staged.
      const floor = [s.newestRun, s.current, running].filter(
        (v): v is string => v !== undefined,
      );
      if (floor.some((v) => compareVersions(version, v) !== 1)) {
        clearStaged(home);
        return { kind: "refused", reason: "not_forward" };
      }
    } else if (!existsSync(versionDir(home, version))) {
      return { kind: "refused", reason: "nothing_staged" };
    }
    // The hub says yes before the swap (the instance times "the bus
    // stopped" from it). No answer holds the switch for a later try.
    const proven = s.staged?.manifest;
    if (
      !(await this.d.announceSwitch(
        running,
        version,
        person ? "requested" : "ok",
      ))
    )
      return { kind: "retry_later" };
    // The wait above can be long: `off`, a newer run, a cleared name or a
    // different staged tree may have landed in it.
    // #2719: the hub's "stopped" clock runs from the `switching` it acked; a
    // backing out says `held` so that clock is replaced, not left to expire.
    const backOut = (reason: string): void =>
      queueReport(home, {
        event: "ready_24h", // "held" on the wire
        from: running,
        to: version,
        reason,
        at: this.now(),
      });
    const after = readPolicy(home);
    if (after.unreadable || after.off) {
      backOut("other");
      return { kind: "retry_later" };
    }
    if (staged && !person && this.named !== version) {
      backOut("nothing_staged");
      return { kind: "retry_later" };
    }
    if (
      staged &&
      (after.staged?.version !== version ||
        JSON.stringify(after.staged.manifest) !== JSON.stringify(proven) ||
        !after.staged.manifest ||
        !treeMatches(versionDir(home, version), after.staged.manifest))
    ) {
      backOut("staged_changed");
      return { kind: "proof_refused", code: "staged_changed" };
    }
    if (
      staged &&
      [after.newestRun, after.current, running].some(
        (v) => v !== undefined && compareVersions(version, v) !== 1,
      )
    ) {
      backOut("not_forward");
      return { kind: "refused", reason: "not_forward" };
    }
    try {
      setPending(home, { from: running, to: version, startedAt: now });
      recordAttempt(home, now);
      swap(home, version);
    } catch (e) {
      try {
        clearPending(home);
      } catch {
        // unreadable: nothing more to undo
      }
      this.d.log(
        `update ${version}: could not switch: ${e instanceof Error ? e.message : String(e)}`,
      );
      backOut("other");
      return { kind: "disabled" };
    }
    prune(home, [running, version, s.previous]);
    this.d.log(`switching to ${version}`);
    this.d.exit(1);
    return { kind: "switching", version };
  }
}
