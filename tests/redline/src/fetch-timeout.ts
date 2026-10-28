// A per-request bound for every fetch in the live suite. A request that never
// answers would otherwise hold its case until vitest's testTimeout, and the
// fetch itself keeps running after the case fails. Bounded, a stalled request
// rejects with an abort error: a FAIL naming the case, never a refusal.

/** Default per-request bound; edge.test.ts keeps its own, shorter one. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Setup publishes (POST /api/v1/artifacts for markers and throwaways) get a
 * longer bound: a slow install can take 10-30 s to publish. Never retried (a
 * retry could make a duplicate).
 */
export const SETUP_PUBLISH_MS = 60_000;

/** The fetch a boundFetch wraps (setupFetch sets its own, longer bound). */
const INNER = Symbol.for("redline.boundFetch.inner");
type Wrapped = typeof fetch & { [INNER]?: typeof fetch };

/** `inner` with a timeout signal added to every call, joined with the caller's. */
export function boundFetch(
  inner: typeof fetch,
  ms: number = FETCH_TIMEOUT_MS,
): typeof fetch {
  const f: Wrapped = (input, init) => {
    const own =
      init?.signal ?? (input instanceof Request ? input.signal : null);
    const timeout = AbortSignal.timeout(ms);
    const signal = own ? AbortSignal.any([own, timeout]) : timeout;
    return inner(input, { ...init, signal });
  };
  f[INNER] = inner;
  return f;
}

/** `f` without its boundFetch wrappers. */
export function unbound(f: typeof fetch = globalThis.fetch): typeof fetch {
  let g = f as Wrapped;
  while (g[INNER]) g = g[INNER] as Wrapped;
  return g;
}

/**
 * Not a red-line verdict: the install was too slow, or a wait never settled.
 * Its message starts with "infra: "; the report files it under its own level,
 * "infra", which never counts as a pass (src/report.ts).
 */
export class InfraError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`infra: ${what}`, options);
    this.name = "InfraError";
  }
}

/** What a setup publish that ran out of time fails with (after "infra: "). */
export const setupTimeout = (install: string, ms: number) =>
  `setup publish timed out after ${Math.round(ms / 1000)}s on ${install}`;

/**
 * Sends a setup publish and reads its body within `ms` (default
 * SETUP_PUBLISH_MS), past the suite's per-fetch bound. Running out of time
 * throws InfraError (setupTimeout); it is never retried. Redirects are not
 * followed.
 */
export async function setupFetch(
  install: string,
  req: Request,
  o: { ms?: number; fetch?: typeof fetch } = {},
): Promise<{ res: Response; text: string }> {
  const ms = o.ms ?? SETUP_PUBLISH_MS;
  const timeout = AbortSignal.timeout(ms);
  try {
    const res = await unbound(o.fetch)(
      new Request(req, {
        redirect: "manual",
        signal: AbortSignal.any([req.signal, timeout]),
      }),
    );
    // Not readBody: a body that stalls must time out, not read as "".
    return { res, text: await res.text() };
  } catch (e) {
    if (timeout.aborted && !req.signal.aborted)
      throw new InfraError(setupTimeout(install, ms), { cause: e });
    // No answer at all (reset, "fetch failed"): infra, never retried (a
    // retry could publish a duplicate).
    if (isNetworkError(e) && !req.signal.aborted)
      throw new InfraError(setupNetwork(install, e), { cause: e });
    throw e;
  }
}

/** What a setup publish that got no answer fails with (after "infra: "). */
export const setupNetwork = (install: string, e: unknown) =>
  `setup publish got no response on ${install} (${networkCode(e)})`;

const NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);

/** The error code (or name) behind a network error, for reports. */
export function networkCode(e: unknown): string {
  const c = (e as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof c === "string") return c;
  const own = (e as { code?: unknown })?.code;
  if (typeof own === "string") return own;
  return (e as Error)?.name ?? "error";
}

/**
 * True when `e` means the request got no response at all: undici's
 * TypeError "fetch failed" (any cause), a socket code (ECONNRESET, ...), or
 * an abort/timeout. Never an HTTP status or an assertion.
 */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof TypeError && e.message === "fetch failed") return true;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  const code = (e as { code?: unknown }).code;
  const cause = (e as { cause?: { code?: unknown } }).cause?.code;
  return (
    (typeof code === "string" && NET_CODES.has(code)) ||
    (typeof cause === "string" && NET_CODES.has(cause))
  );
}
