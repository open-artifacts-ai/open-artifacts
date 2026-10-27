import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send } from "./http.ts";
import {
  atLeg,
  type LegInfo,
  type LegName,
  okLeg,
  refusedLeg,
  tagLeg,
} from "./refused.ts";
import { redactReason } from "./report.ts";
import {
  CALLBACK_GOOGLE,
  CAPTURE_FLOWS,
  type CookiePair,
  callbackReq,
  type FlowName,
  type GoogleStart,
  googleUrlOf,
  signedIn,
  signInRefused,
  startGoogle,
} from "./signin.ts";
import type { Mode, Target, Targets } from "./targets.ts";

// The real-tenant sign-in capture (P5 R6) as a library: scripts/signin-capture.ts
// is its interactive shell (clipboard and prompts), test/rehearsal.test.ts
// drives the same code against a fake IdP. Each flow is started here, the
// user signs in and copies the FIRST callback URL, it is checked locally,
// and then redeemed at once: its legs run right after its own prompt, with
// the same leg functions crossCheck uses (okLeg, refusedLeg). Each leg's
// verdict (with a redacted reason) goes to <dir>/verdicts.json (0600); the
// suite's two ID-token cases read it. Nothing secret is ever written: codes,
// states and cookies stay in memory.

/** Google codes and broker states live about 10 minutes; the capture allows 9. */
export const CAPTURE_MAX_AGE_MS = 9 * 60_000;
/** Verdicts older than this read as unproven (a stale file, not this run's). */
export const VERDICTS_MAX_AGE_MS = 60 * 60_000;
export const VERDICTS_FILE = "verdicts.json";

/** The suite's two ID-token cases (live/signin.test.ts), by key. */
export const ID_TOKEN_CASES = {
  hd: "an ID token with hd of A at B's callback: no session",
  aud: "A's code and broker state at B: no session",
} as const;
export type IdTokenCase = keyof typeof ID_TOKEN_CASES;
/** The suite's file and describe for those cases (report names: "<describe> > <case>"). */
export const ID_TOKEN_FILE = "live/signin.test.ts";
export const ID_TOKEN_DESCRIBE = "sign-in: ID tokens";
/**
 * The ID-token cases' reason when no capture ran (CI). Distinct on purpose:
 * the gate's combine() replaces exactly the cases carrying it.
 */
export const NEEDS_CAPTURE = "unproven: needs capture";

export interface CaptureLeg {
  case: IdTokenCase;
  leg: LegName;
  /** Where the leg is sent. */
  host: "a" | "b";
  /** signed-in, or the /sign-in error the refusal must carry. */
  expect: "signed-in" | "tenant" | "failed";
  /** Completed on a fresh flow of `host` (its own state and cookie). */
  fresh?: boolean;
}

/**
 * Each flow's legs, in order (the crossCheck legs of the two cases). Google
 * codes are single use, so each success leg has its own sign-in; the aud case
 * gets its refused leg and A's success from one capture (refused first: the
 * broker refuses before Google sees the code).
 */
export const CAPTURE_LEGS: Record<FlowName, readonly CaptureLeg[]> = {
  "a-alice": [
    { case: "hd", leg: "A's credential at A", host: "a", expect: "signed-in" },
  ],
  "b-alice": [
    { case: "hd", leg: "A's credential at B", host: "b", expect: "tenant" },
  ],
  "a-alice-replay": [
    {
      case: "aud",
      leg: "A's credential at B",
      host: "b",
      expect: "failed",
      fresh: true,
    },
    { case: "aud", leg: "A's credential at A", host: "a", expect: "signed-in" },
  ],
  "b-dave": [
    {
      case: "hd",
      leg: "B's own credential at B",
      host: "b",
      expect: "signed-in",
    },
  ],
  "b-dave-2": [
    {
      case: "aud",
      leg: "B's own credential at B",
      host: "b",
      expect: "signed-in",
    },
  ],
};

export interface StartedFlow {
  flow: FlowName;
  at: "a" | "b";
  state: string;
  cookie: CookiePair;
  startedAt: number;
  /** The start went through the auth broker (its callback carries bstate). */
  broker: boolean;
}

export interface Capture {
  flow: FlowName;
  at: "a" | "b";
  /** The install's own state cookie from the start (the browser never had it). */
  cookie: CookiePair;
  /** The callback query the IdP (through the broker) sent the browser to. */
  query: { state: string; code: string; bstate?: string };
  startedAt: number;
  /** When the code or the broker state stops working, whichever is first. */
  expiresAt: number;
}

/** One captured, completed callback, at `host` (its own state and cookie unless `as` is given). */
export const completeAt = (c: Capture, host: Target, as?: GoogleStart) =>
  callbackReq(
    host,
    {
      state: as?.state ?? c.query.state,
      code: c.query.code,
      ...(c.query.bstate ? { bstate: c.query.bstate } : {}),
    },
    as?.cookie ?? c.cookie,
  );

/** The broker state's payload (decoded only, never verified: the broker's MAC). */
export function decodeBrokerState(
  bstate: string,
): { i: string; s: string; exp: number } | null {
  try {
    const [p = ""] = bstate.split(".");
    const v = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as {
      i?: unknown;
      s?: unknown;
      exp?: unknown;
    };
    return typeof v.i === "string" &&
      typeof v.s === "string" &&
      typeof v.exp === "number"
      ? { i: v.i, s: v.s, exp: v.exp }
      : null;
  } catch {
    return null;
  }
}

export type Checked =
  | { ok: true; capture: Capture }
  | {
      ok: false;
      why: string;
      /** The code or state can't work any more: start the flow again. */
      restart?: boolean;
    };

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * What can be checked locally about a pasted callback URL: the install's
 * own callback (origin and path), this start's state (never the browser's
 * r1. retry), a code, the broker state naming this install (decoded, not
 * verified) and the age bound. Messages never quote the URL.
 */
export function checkCallback(
  t: Target,
  started: StartedFlow,
  pasted: string,
  now = Date.now(),
): Checked {
  let u: URL;
  try {
    u = new URL(pasted.trim());
  } catch {
    return { ok: false, why: "the clipboard doesn't hold a URL" };
  }
  if (u.origin !== t.app || u.pathname !== CALLBACK_GOOGLE)
    return {
      ok: false,
      why: `that isn't ${t.name}'s callback/google request URL`,
    };
  const q = u.searchParams;
  const state = q.get("state") ?? "";
  if (state.startsWith("r1."))
    return {
      ok: false,
      why: "that's the browser's retry callback (state r1.); copy the FIRST callback/google request for this prompt",
    };
  if (state !== started.state)
    return {
      ok: false,
      why: "that callback is from another sign-in start (its state differs); copy this prompt's FIRST callback/google request",
    };
  const err = q.get("error");
  const code = q.get("code") ?? "";
  if (!code)
    return {
      ok: false,
      why: err
        ? `the IdP sent no code (error=${/^[a-z_]{1,40}$/.test(err) ? err : "?"}); sign in again`
        : "that callback has no code",
      restart: !!err,
    };
  const bstate = q.get("bstate") ?? "";
  let exp = started.startedAt + CAPTURE_MAX_AGE_MS;
  if (started.broker || bstate) {
    const st = bstate ? decodeBrokerState(bstate) : null;
    if (!st)
      return {
        ok: false,
        why: "the callback's broker state is missing or unreadable",
      };
    if (st.i !== t.installId)
      return {
        ok: false,
        why: `the broker state names install ${st.i}, not ${t.name} (${t.installId})`,
      };
    if (st.s !== started.state)
      return { ok: false, why: "the broker state is for another start" };
    exp = Math.min(exp, st.exp);
  }
  if (now >= exp)
    return {
      ok: false,
      why: `this capture is too old (${mmss(now - started.startedAt)} since its start); signing in again`,
      restart: true,
    };
  return {
    ok: true,
    capture: {
      flow: started.flow,
      at: started.at,
      cookie: started.cookie,
      query: { state, code, ...(bstate ? { bstate } : {}) },
      startedAt: started.startedAt,
      expiresAt: exp,
    },
  };
}

export interface LegVerdict {
  case: IdTokenCase;
  flow: FlowName;
  leg: LegName;
  /** The install's name. */
  host: string;
  expected: string;
  verdict: "pass" | "fail";
  /** Redacted; set on a fail. */
  reason?: string;
  actual?: string;
  startedAt: number;
  redeemedAt: number;
}

/**
 * The capture run's record: its verdicts, bound to what they were taken
 * against (install ids, their /healthz versions, the suite's commit) so the
 * gate (src/combine.ts) can refuse to apply them to any other run.
 */
export interface Verdicts {
  v: 1;
  /** The targets' mode: "local" verdicts come from a fake IdP, never a staging pass. */
  mode: Mode;
  /** 32 random bytes, base64url: this capture run (POST /__test/mark, later). */
  runNonce: string;
  installs: { a: string; b: string };
  versions: { a: string; b: string };
  /** The commit the capture's suite code is at (git HEAD of the checkout). */
  suiteSha: string;
  startedAt: number;
  /** Updated on every write; the last write is the run's end. */
  finishedAt: number;
  legs: LegVerdict[];
}

/** A runNonce's shape. */
export const RUN_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Marks the start and end of a capture run at an install, so the install's
 * own log ties its callbacks to this run. TODO(POST /__test/mark): a no-op
 * until the server's POST /__test/mark {nonce} hook exists (a separate
 * server PR); then send it through hook(t, "/__test/mark", { nonce }).
 */
export async function markRun(
  _t: Target,
  _nonce: string,
  _at: "start" | "end",
): Promise<void> {}

/** The checkout's commit (git HEAD), or "unknown". */
export function suiteSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** An install's /healthz version, or "unknown". */
export async function versionOf(t: Target): Promise<string> {
  try {
    const r = await fetch(`${t.app}/healthz`, { redirect: "manual" });
    const v = ((await r.json()) as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

const expectOf = (l: CaptureLeg) =>
  l.expect === "signed-in" ? signedIn.expects : signInRefused(l.expect).expects;

/**
 * Redeems one capture now: each of its legs (CAPTURE_LEGS), judged by okLeg
 * or refusedLeg, the same verdicts crossCheck applies. A leg that throws
 * before any response (a fresh start that fails) is a fail with its reason.
 */
export async function redeemCapture(
  T: Pick<Targets, "a" | "b">,
  c: Capture,
  now: () => number = Date.now,
): Promise<LegVerdict[]> {
  const out: LegVerdict[] = [];
  for (const l of CAPTURE_LEGS[c.flow]) {
    const host = T[l.host];
    const info: LegInfo = {
      leg: l.leg,
      host: host.name,
      expected: expectOf(l),
    };
    const base = {
      case: l.case,
      flow: c.flow,
      leg: l.leg,
      host: host.name,
      expected: info.expected,
      startedAt: c.startedAt,
    };
    try {
      await atLeg(info, async () => {
        let as: GoogleStart | undefined;
        if (l.fresh) {
          const s = await startGoogle(host);
          if (!s) throw new Error(`${host.name}: Google sign-in is off`);
          as = s;
        }
        const res = await send(completeAt(c, host, as));
        if (l.expect === "signed-in")
          await okLeg(
            l.leg as Exclude<LegName, "A's credential at B">,
            res,
            host,
            signedIn,
          );
        else await refusedLeg(res, host, signInRefused(l.expect));
      });
      out.push({ ...base, verdict: "pass", redeemedAt: now() });
    } catch (e) {
      const err = tagLeg(e, info);
      const r = (err as { redline?: LegInfo }).redline;
      out.push({
        ...base,
        verdict: "fail",
        reason: redactReason(err.message),
        ...(r?.actual ? { actual: redactReason(r.actual, 300) } : {}),
        redeemedAt: now(),
      });
    }
  }
  return out;
}

/** Writes the verdicts (0600, replaced whole). No secrets: reasons are redacted. */
export function writeVerdicts(dir: string, v: Verdicts): void {
  const tmp = join(dir, `${VERDICTS_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, VERDICTS_FILE));
}

export interface CapturePrompt {
  n: number;
  total: number;
  flow: FlowName;
  user: string;
  why: string;
  install: string;
  /** Why the last paste wasn't taken (shown before asking again). */
  retry?: string;
}

export interface CaptureIO {
  /** Hands the user the sign-in URL (the clipboard). */
  offer(url: URL, p: CapturePrompt): void | Promise<void>;
  /** Asks; resolves with the callback URL the user copied. */
  ask(p: CapturePrompt): Promise<string>;
  /** Called once a URL was taken (clear the clipboard). */
  taken?(p: CapturePrompt): void | Promise<void>;
  say(line: string): void;
}

export interface CaptureOpts {
  /** The IdP's authorize origin (default Google's). */
  idp?: string;
  /** Rewrites each broker hop before it is fetched (loopback http). */
  map?: (u: URL) => URL;
  now?: () => number;
  /** Pastes per prompt before giving up (default 8). */
  maxTries?: number;
  /** Only these flows (default all, in order). */
  flows?: readonly FlowName[];
  /** The suite's commit (default git HEAD). */
  suiteSha?: string;
}

/**
 * The capture: for each flow, start, offer, take the pasted callback, check
 * it, redeem it at once and record its verdicts. Returns the verdicts (also
 * in <dir>/verdicts.json). Throws only on setup trouble (sign-in off, a
 * broker that won't redirect, too many bad pastes).
 */
export async function runCaptures(
  T: Pick<Targets, "a" | "b" | "mode">,
  dir: string,
  io: CaptureIO,
  o: CaptureOpts = {},
): Promise<Verdicts> {
  const now = o.now ?? Date.now;
  const flows = o.flows ?? (Object.keys(CAPTURE_FLOWS) as FlowName[]);
  const runNonce = randomBytes(32).toString("base64url");
  const verdicts: Verdicts = {
    v: 1,
    mode: T.mode,
    runNonce,
    installs: { a: T.a.installId, b: T.b.installId },
    versions: { a: await versionOf(T.a), b: await versionOf(T.b) },
    suiteSha: o.suiteSha ?? suiteSha(),
    startedAt: now(),
    finishedAt: now(),
    legs: [],
  };
  for (const t of [T.a, T.b]) await markRun(t, runNonce, "start");
  let firstExpires: number | undefined;
  for (const [i, flow] of flows.entries()) {
    const spec = CAPTURE_FLOWS[flow];
    const t = T[spec.at];
    const p: CapturePrompt = {
      n: i + 1,
      total: flows.length,
      flow,
      user: spec.user,
      why: spec.why,
      install: t.name,
    };
    let capture: Capture | undefined;
    for (let tries = 0; !capture; tries++) {
      if (tries >= (o.maxTries ?? 8))
        throw new Error(`${flow}: no usable callback after ${tries} tries`);
      const s = await startGoogle(t);
      if (!s) throw new Error(`Google sign-in is off on ${t.name}`);
      const started: StartedFlow = {
        flow,
        at: spec.at,
        state: s.state,
        cookie: s.cookie,
        startedAt: now(),
        broker: s.location.pathname === "/google/authorize",
      };
      await io.offer(
        await googleUrlOf(s, {
          dropHd: "foreign" in spec && spec.foreign,
          ...(o.idp ? { idp: o.idp } : {}),
          ...(o.map ? { map: o.map } : {}),
        }),
        p,
      );
      for (; !capture && tries < (o.maxTries ?? 8); tries++) {
        const r = checkCallback(t, started, await io.ask(p), now());
        if (r.ok) {
          capture = r.capture;
          break;
        }
        p.retry = r.why;
        io.say(`  ${flow}: ${r.why}.`);
        if (r.restart) break;
      }
    }
    delete p.retry;
    await io.taken?.(p);
    firstExpires ??= capture.expiresAt;
    io.say(
      `  ${flow}: captured, ${p.n} of ${p.total}. Time left before the first capture expires: ${mmss(firstExpires - now())}. Redeeming it now.`,
    );
    const legs = await redeemCapture(T, capture, now);
    verdicts.legs.push(...legs);
    verdicts.finishedAt = now();
    writeVerdicts(dir, verdicts);
    for (const l of legs)
      io.say(
        `  ${flow}: ${l.leg} (${l.host}): ${l.verdict}${l.reason ? ` (${l.reason})` : ""}`,
      );
  }
  for (const t of [T.a, T.b]) await markRun(t, runNonce, "end");
  verdicts.finishedAt = now();
  writeVerdicts(dir, verdicts);
  return verdicts;
}

export type CaseOutcome =
  | { kind: "none" }
  | { kind: "unproven"; reason: string }
  /** `label`: what the pass rests on (the capture run; a fake IdP in local mode). */
  | { kind: "pass"; label: string }
  | { kind: "fail"; error: Error };

/** Clock skew allowed on a verdict's timestamps. */
export const CLOCK_SKEW_MS = 5_000;
/** The suite's env: set by scripts/signin-capture.ts for its own suite child only. */
export const CAPTURE_RUN_ENV = "REDLINE_CAPTURE_RUN";
export const CAPTURE_NONCE_ENV = "REDLINE_CAPTURE_NONCE";
export const NOT_THIS_RUN = "verdicts not from this capture run";

const ageText = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/**
 * One ID-token case from REDLINE_SIGNIN_CAPTURES (`dir`): "none" without a
 * directory; "unproven" (with the reason) for any capture-file problem: a
 * missing or unreadable file, other installs, a flow not captured, a capture
 * or verdicts file too old; else "pass" when every leg passed, or "fail"
 * naming each failed leg (its error tagged with the first one's leg).
 */
export function idTokenOutcome(
  dir: string | undefined,
  T: Pick<Targets, "a" | "b" | "mode">,
  which: IdTokenCase,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
): CaseOutcome {
  if (!dir) return { kind: "none" };
  const un = (reason: string): CaseOutcome => ({ kind: "unproven", reason });
  // Only the capture script's own suite child may read verdicts: it passes
  // the run's nonce, which a hand-written or leftover file can't match.
  const nonce = env[CAPTURE_NONCE_ENV];
  if (env[CAPTURE_RUN_ENV] !== "1" || !nonce || !RUN_NONCE_RE.test(nonce))
    return un(NOT_THIS_RUN);
  let v: Verdicts;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0)
      return un("capture directory is not a 0700 directory");
    const f = join(dir, VERDICTS_FILE);
    const fs = lstatSync(f);
    if (!fs.isFile() || (fs.mode & 0o077) !== 0)
      return un("capture verdicts file is not a 0600 file");
    v = JSON.parse(readFileSync(f, "utf8")) as Verdicts;
  } catch {
    return un("no capture verdicts (verdicts.json missing or unreadable)");
  }
  if (v?.runNonce !== nonce) return un(NOT_THIS_RUN);
  if (v.mode !== T.mode)
    return un(
      `capture verdicts are from ${String(v.mode)} mode, this run is ${T.mode}`,
    );
  return verdictsOutcome(
    v,
    { a: T.a.installId, b: T.b.installId },
    which,
    now,
    VERDICTS_MAX_AGE_MS,
  );
}

/** idTokenOutcome on verdicts already read (src/combine.ts uses it with 24 h). */
export function verdictsOutcome(
  v: Verdicts,
  installs: { a: string; b: string },
  which: IdTokenCase,
  now: number,
  maxAgeMs: number,
): CaseOutcome {
  const un = (reason: string): CaseOutcome => ({ kind: "unproven", reason });
  if (v?.v !== 1 || !Array.isArray(v.legs))
    return un("capture verdicts file has an unknown shape");
  if (v.installs?.a !== installs.a || v.installs?.b !== installs.b)
    return un("capture verdicts are for other installs");
  if (typeof v.runNonce !== "string" || !RUN_NONCE_RE.test(v.runNonce))
    return un("capture verdicts have no valid runNonce");
  if (typeof v.startedAt !== "number" || typeof v.finishedAt !== "number")
    return un("capture verdicts have no run times");
  if (v.finishedAt < v.startedAt)
    return un("capture run ends before it starts");
  if (v.finishedAt > now + CLOCK_SKEW_MS)
    return un("capture run ends in the future");
  const fails: LegVerdict[] = [];
  for (const [flow, legs] of Object.entries(CAPTURE_LEGS) as [
    FlowName,
    readonly CaptureLeg[],
  ][])
    for (const l of legs) {
      if (l.case !== which) continue;
      const got = v.legs.find((x) => x.flow === flow && x.leg === l.leg);
      if (!got) return un(`not captured (${flow})`);
      if (
        typeof got.redeemedAt !== "number" ||
        typeof got.startedAt !== "number"
      )
        return un(`capture has no times (${flow})`);
      if (got.redeemedAt > now + CLOCK_SKEW_MS)
        return un(`capture redeemed in the future (${flow})`);
      if (got.startedAt > got.redeemedAt)
        return un(`capture started after its redeem (${flow})`);
      if (
        got.startedAt < v.startedAt - CLOCK_SKEW_MS ||
        got.redeemedAt > v.finishedAt + CLOCK_SKEW_MS
      )
        return un(`capture outside its run (${flow})`);
      const age = got.redeemedAt - got.startedAt;
      if (!(age <= CAPTURE_MAX_AGE_MS))
        return un(`capture too old (${flow}, ${ageText(age)})`);
      if (!(now - got.redeemedAt <= maxAgeMs))
        return un(
          `capture too old (${flow}, redeemed ${ageText(now - got.redeemedAt)} ago)`,
        );
      if (got.verdict !== "pass") fails.push(got);
    }
  if (fails.length === 0)
    return {
      kind: "pass",
      label: `${v.mode === "local" ? "fake IdP (local); " : ""}redeemed by capture run ${v.runNonce.slice(0, 6)}`,
    };
  const first = fails[0] as LegVerdict;
  // Each reason already names its leg, install and expectation.
  const error = new Error(
    fails.map((f) => `[${f.flow}] ${f.reason ?? f.leg}`).join(" | "),
  );
  (error as { redline?: LegInfo }).redline = {
    leg: first.leg,
    host: first.host,
    expected: first.expected,
    ...(first.actual ? { actual: first.actual } : {}),
  };
  return { kind: "fail", error };
}
