import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
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
import {
  accept,
  type Busy,
  compareVersions,
  type Decision,
  type Instruction,
  installNow,
  isBusy,
  parseVersion,
  QuietTracker,
  type Refusal,
  readyDue,
} from "./policy.ts";
import { queueReport } from "./reports.ts";
import {
  clearPending,
  clearStaged,
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
 * The updater loop switch (#2552). PR 4 builds the loop but ships it off:
 * PR 6 flips this, and only an armed, not-off install ever runs it.
 */
export const UPDATER_LOOP_ENABLED: boolean = false;

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
  private readonly quiet = new QuietTracker();
  private stopTick: () => void = () => {};
  private working = false;
  private wanted: { i: Instruction; at: number } | undefined;
  private readonly d: UpdaterDeps;
  constructor(d: UpdaterDeps) {
    this.d = d;
  }

  private get enabled(): boolean {
    return this.d.enabled ?? UPDATER_LOOP_ENABLED;
  }
  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(): void {
    if (!this.enabled) return;
    this.stopTick = (this.d.every ?? realEvery)(
      () => void this.tick(),
      TICK_MS,
    );
  }
  stop(): void {
    this.stopTick();
  }

  /** The version the instance names. Stages it; the swap waits for a quiet moment. */
  async instruct(i: Instruction): Promise<UpdateOutcome> {
    if (!this.enabled) return { kind: "disabled" };
    const { home, running } = this.d;
    if (running === undefined) return { kind: "disabled" };
    const now = this.now();
    const s = readPolicy(home);
    const server = this.d.serverVersion();
    const dec = accept(s, i, now, { running, ...(server ? { server } : {}) });
    if (!dec.ok) {
      this.refuse(running, i.version, dec);
      return { kind: "refused", reason: dec.reason };
    }
    if (i.stepBack === true) {
      // Back to the kept previous: no download, no waiting for a quiet moment.
      return this.switchTo(i.version, false);
    }
    if (s.staged?.version === i.version && s.staged.manifest) {
      if (treeMatches(versionDir(home, i.version), s.staged.manifest))
        return { kind: "staged", version: i.version };
    }
    return this.stage(i, now);
  }

  private refuse(
    from: string,
    to: string,
    d: Extract<Decision, { ok: false }>,
  ): void {
    // Only a forbidden instruction is worth a report; waiting is not.
    if (d.reason === "bad_version" || d.reason === "ahead_of_server")
      queueReport(this.d.home, {
        event: "refused",
        from,
        to: parseVersion(to) ? to : "",
        reason: d.reason === "bad_version" ? "bad_instruction" : d.reason,
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

  /** One poll: quiet tracking, the "ready" notice, the install request, the swap. */
  async tick(): Promise<void> {
    if (!this.enabled || this.working) return;
    this.working = true;
    try {
      const now = this.now();
      const login = this.d.loginActive();
      this.quiet.observe(now, isBusy(this.d.busy()), login);
      if (this.wanted && now - this.wanted.at >= RETRY_MS) {
        const { i } = this.wanted;
        this.wanted = undefined;
        await this.instruct(i);
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
        // The person's own command: it passes the 6 h limit and the quiet wait.
        if (
          req.version === st.version &&
          !login &&
          now - req.at < REQUEST_MAX_MS
        )
          this.switchTo(st.version, true);
        return;
      }
      if (this.quiet.quiet(now) && installNow(s, now, login).ok)
        this.switchTo(st.version, true);
    } catch (e) {
      this.d.log(`update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.working = false;
    }
  }

  /**
   * The swap: re-hash what was staged, write `pending`, point `bin` at it and
   * exit non-zero so the service restarts the daemon from the new folder.
   */
  private switchTo(version: string, staged: boolean): UpdateOutcome {
    const { home, running } = this.d;
    const now = this.now();
    if (running === undefined || !isSafeVersion(version) || version === running)
      return { kind: "disabled" };
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
      return { kind: "disabled" };
    }
    prune(home, [running, version, s.previous]);
    this.d.log(`switching to ${version}`);
    this.d.exit(1);
    return { kind: "switching", version };
  }
}
