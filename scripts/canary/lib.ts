// Small helpers the client canary shares: deadlines, a cookie session and the
// result table. No dependencies outside Node, so the workflow runs it with
// `node --experimental-strip-types` and no package of its own.
import { randomBytes } from "node:crypto";

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

/**
 * Polls `probe` until it returns a value other than undefined, or throws
 * Timeout once `ms` has passed. `everyMs` spaces the polls; the harness waits
 * on real processes and a real server, so a poll with a deadline is the signal.
 */
export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  { ms, everyMs = 500 }: { ms: number; everyMs?: number },
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() >= deadline) {
      const why = last instanceof Error ? `: ${last.message}` : "";
      throw new Timeout(`${what}: not within ${Math.round(ms / 1000)} s${why}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
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
    const res = await fetch(new URL(path, this.origin), {
      // A call that hangs fails, rather than holding the job to its timeout.
      signal: AbortSignal.timeout(FETCH_MS),
      ...init,
      headers,
      redirect: "manual",
    });
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

/** The job summary: one line per client, then one row per check. Never a secret. */
export function summaryMarkdown(r: ClientResult): string {
  const v = versionText(r);
  const where = r.target ? `, on ${r.target}` : "";
  const head = `### ${r.label} (${r.channel}${v ? `, ${v}` : ""}${where}): ${MARK[r.status]}`;
  const notes = (r.notes ?? []).map((n) => `- ${n}`);
  const rows = r.checks.map(
    (c) =>
      `| ${c.check} | ${MARK[c.status]} | ${c.detail.replaceAll("|", "/")} |`,
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
