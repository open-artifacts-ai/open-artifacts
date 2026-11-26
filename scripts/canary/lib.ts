// Small helpers the client canary shares: deadlines, a cookie session and the
// result table. No dependencies outside Node, so the workflow runs it with
// `node --experimental-strip-types` and no package of its own.
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";

export type Status = "pass" | "fail" | "skip";
export type CheckResult = { check: string; status: Status; detail: string };
export type ClientResult = {
  client: string;
  label: string;
  channel: string;
  /** Where it ran: staging or local. */
  target?: string;
  /** The client's own `--version`, as the run started. */
  version: string;
  /** Its `--version` again as the run ended, when that differs (it updated itself). */
  versionAfter?: string;
  /** `oa-bus --version` as the run started, and as it ended when that differs. */
  busVersion?: string;
  busVersionAfter?: string;
  status: Status;
  checks: CheckResult[];
  /** Plain lines for the summary: the steering expectation, the versions. */
  notes?: string[];
};

export class Timeout extends Error {}

/** Stops listening; what `waitFor`'s `on` returns. */
export type Unsubscribe = () => void;

/**
 * Waits on a signal, never on a timer: `check` runs once now and again each
 * time a source `on` subscribes to wakes it (a file event, a socket frame, a
 * process exit). Resolves with the first value other than undefined; throws
 * Timeout once `ms` has passed with none. A `check` that throws ends the wait
 * with that error. Checks never overlap: a wake during one runs it again after.
 */
export function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined> | T | undefined,
  { ms, on = [] }: { ms: number; on?: ((wake: () => void) => Unsubscribe)[] },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let running = false;
    let again = false;
    const offs: Unsubscribe[] = [];
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const off of offs) off();
      f();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Timeout(`${what}: not within ${Math.round(ms / 1000)} s`)),
        ),
      ms,
    );
    const wake = () => {
      if (done) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      void (async () => {
        try {
          do {
            again = false;
            const v = await check();
            if (v !== undefined) return finish(() => resolve(v));
          } while (again && !done);
        } catch (e) {
          finish(() => reject(e));
        } finally {
          running = false;
        }
      })();
    };
    for (const sub of on) offs.push(sub(wake));
    wake();
  });
}

/** A `waitFor` source: wakes on any change to each file or folder in `paths` (fs.watch, no polling). */
export const onFiles =
  (...paths: string[]) =>
  (wake: () => void): Unsubscribe => {
    const ws = paths.map((d) => watch(d, { persistent: false }, () => wake()));
    return () => {
      for (const w of ws) w.close();
    };
  };

/** A `waitFor` source: wakes on a stream's output. */
export const onData =
  (s: NodeJS.ReadableStream | null | undefined) =>
  (wake: () => void): Unsubscribe => {
    if (!s) return () => {};
    s.on("data", wake);
    return () => s.off("data", wake);
  };

/** A `waitFor` source: wakes when the process exits or fails to start. */
export const onExit =
  (child: ChildProcess) =>
  (wake: () => void): Unsubscribe => {
    child.on("exit", wake);
    child.on("error", wake);
    return () => {
      child.off("exit", wake);
      child.off("error", wake);
    };
  };

// ---------------------------------------------------------------- sanitizing

/** The most text one detail may carry into a result, summary or issue. */
export const DETAIL_MAX = 300;

/**
 * Token shapes blanked even when their value was not known: Open Artifacts
 * machine, personal and session tokens, model API keys, GitHub tokens, and
 * anything sent as a bearer token.
 */
export const TOKEN_SHAPES = [
  /\boa_(?:machine|pat|sess|proof)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(authorization|cookie|set-cookie|x-oa-proof)\s*[:=]\s*\S+/gi,
];

/** `text` with every value in `secrets` (8 characters or more) and every token shape blanked. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const v of secrets)
    if (v && v.length >= 8) out = out.replaceAll(v, "[hidden]");
  for (const re of TOKEN_SHAPES)
    out = out.replace(re, (_m, name: unknown) =>
      typeof name === "string" ? `${name} [hidden]` : "[hidden]",
    );
  return out;
}

/** Terminal codes: CSI, OSC (to BEL or ST) and other two-byte escapes. */
const TERMINAL_CODES = new RegExp(
  "\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[@-Z\\\\-_]",
  "g",
);

/**
 * A raw terminal log (a client's PTY output) as plain text, redacted: terminal
 * codes out, carriage returns made newlines, then each value in `secrets`
 * blanked even when a redraw or a line wrap split it with whitespace, and
 * every token shape blanked.
 */
export function redactLog(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text.replace(TERMINAL_CODES, "").replace(/\r\n?/g, "\n");
  for (const v of secrets) {
    if (!v || v.length < 8) continue;
    const split = new RegExp(
      [...v]
        .map((c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
        .join("\\s*"),
      "g",
    );
    out = out.replace(split, "[hidden]");
  }
  return redact(out, secrets);
}

/** Control, bidi and zero-width characters: never kept in a detail. */
const CONTROLS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]+",
  "g",
);

/**
 * A detail fit to record: redacted, one line (terminal codes and control
 * characters out), at most `max` characters. What a client, a log or the hub
 * said goes through this before it is kept anywhere.
 */
export function clean(
  text: string,
  secrets: readonly string[] = [],
  max = DETAIL_MAX,
): string {
  const one = redact(String(text), secrets)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escapes are what it removes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(CONTROLS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The zero-width space that keeps GitHub from reading @name, #123 or a URL. */
const ZWSP = "\u200b";

/**
 * `text` (cleaned first) as inert GitHub markdown: no HTML, no markdown, no
 * table break, no @-mention, no #-link, GH- link or cross-repo reference, no autolinked
 * URL. Every text from a client, a log or the hub that reaches a summary, an
 * issue or a comment goes through this.
 */
export function inert(
  text: string,
  secrets: readonly string[] = [],
  max = DETAIL_MAX,
): string {
  return (
    clean(text, secrets, max)
      // @name, #123, owner/repo#123: a zero-width space after the sign.
      .replace(/([@#])/g, `$1${ZWSP}`)
      // GH-123, any case: a zero-width space before the hyphen.
      .replace(/(gh)-(?=\d)/gi, `$1${ZWSP}-`)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[\\`*_{}[\]|~^$]/g, (c) => (c === "|" ? "&#124;" : `\\${c}`))
      .replace(/:\/\//g, `:${ZWSP}//`)
      .replace(/^([-+=>]|\d+\.)/, "\\$1")
      .replace(/(www)\./gi, `$1${ZWSP}.`)
  );
}

/** How long one call to the server may take. */
export const FETCH_MS = 30_000;

/**
 * Fetch with one cookie jar, what a signed-in browser would send (seeded with
 * `cookies`, such as a test-hook session); or, with a `bearer` token, what an
 * API client sends.
 */
export class Session {
  #cookies = new Map<string, string>();
  #bearer: string | undefined;
  readonly origin: string;
  constructor(
    origin: string,
    opts: { bearer?: string; cookies?: Record<string, string> } = {},
  ) {
    this.origin = origin;
    this.#bearer = opts.bearer;
    for (const [k, v] of Object.entries(opts.cookies ?? {}))
      this.#cookies.set(k, v);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#bearer) headers.set("authorization", `Bearer ${this.#bearer}`);
    if (this.#cookies.size > 0)
      headers.set(
        "cookie",
        [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    let res: Response;
    try {
      res = await fetch(new URL(path, this.origin), {
        // A call that hangs fails, rather than holding the job to its timeout.
        signal: AbortSignal.timeout(FETCH_MS),
        ...init,
        headers,
        redirect: "manual",
      });
    } catch (e) {
      // Say which call and why (the cause's code), never the request itself.
      const cause = (e as { cause?: { code?: string; message?: string } })
        .cause;
      throw new Error(
        `${init.method ?? "GET"} ${path.split("?")[0]}: ${(e as Error).message}${cause ? ` (${cause.code ?? cause.message ?? ""})` : ""}`,
      );
    }
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = (pair ?? "").indexOf("=");
      if (eq > 0)
        this.#cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1));
    }
    return res;
  }
}

/** The client's status: fail if any check failed, skip if all skipped, else pass. */
export function overall(checks: CheckResult[]): Status {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.length === 0 || checks.every((c) => c.status === "skip"))
    return "skip";
  return "pass";
}

const MARK: Record<Status, string> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIPPED",
};

/** The version as run: "2.1.0", or "2.1.0, updated itself to 2.1.1 during the run". */
export const versionText = (r: ClientResult): string =>
  r.versionAfter && r.versionAfter !== r.version
    ? `${r.version || "unknown"}, updated itself to ${r.versionAfter} during the run`
    : r.version;

/** The oa-bus as run: "oa-bus 1.2.0", or "oa-bus 1.2.0, then oa-bus 1.3.0 as the run ended". */
export const busVersionText = (r: ClientResult): string =>
  r.busVersionAfter && r.busVersionAfter !== r.busVersion
    ? `${r.busVersion || "unknown"}, then ${r.busVersionAfter} as the run ended`
    : (r.busVersion ?? "");

/**
 * The job summary: one line per client, then one row per check. Every text
 * in it is inert (no markdown, HTML, mention or link from a client), and no
 * secret or token shape survives.
 */
export function summaryMarkdown(
  r: ClientResult,
  secrets: readonly string[] = [],
): string {
  const t = (s: string, max?: number) => inert(s, secrets, max);
  const v = versionText(r);
  const where = r.target ? `, on ${r.target}` : "";
  const head = `### ${t(`${r.label} (${r.channel}${v ? `, ${v}` : ""}${where})`, 200)}: ${MARK[r.status] ?? "FAIL"}`;
  const notes = (r.notes ?? []).map((n) => `- ${t(n)}`);
  const rows = r.checks.map(
    (c) =>
      `| ${t(c.check, 60)} | ${MARK[c.status] ?? "FAIL"} | ${t(c.detail)} |`,
  );
  return [
    head,
    "",
    ...(notes.length > 0 ? [...notes, ""] : []),
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Words for a short random marker the canary asks clients to echo back. */
export const marker = (): string => randomBytes(5).toString("hex");

/**
 * A run id: lowercase letters, digits and hyphens, at most 20, so it fits an
 * address, a name and the staging purge prefix (`t19-canary-<id>-<client>`,
 * which the hook caps at 44).
 */
export const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;

/** CANARY_RUN_ID (the workflow sets it from the run), else a new one. */
export function runIdOf(v: string | undefined): string {
  if (!v) return marker();
  if (!RUN_ID_RE.test(v))
    throw new Error(
      "CANARY_RUN_ID must be lowercase letters, digits and hyphens, at most 20",
    );
  return v;
}
