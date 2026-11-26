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
  version: string;
  status: Status;
  checks: CheckResult[];
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

/** Fetch with one cookie jar: what a signed-in browser would send. */
export class Session {
  #cookies = new Map<string, string>();
  readonly origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
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

/** The job summary: one line per client, then one row per check. Never a secret. */
export function summaryMarkdown(r: ClientResult): string {
  const head = `### ${r.label} (${r.channel}${r.version ? `, ${r.version}` : ""}): ${MARK[r.status]}`;
  const rows = r.checks.map(
    (c) =>
      `| ${c.check} | ${MARK[c.status]} | ${c.detail.replaceAll("|", "/")} |`,
  );
  return [
    head,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Words for a short random marker the canary asks clients to echo back. */
export const marker = (): string => randomBytes(5).toString("hex");
