// A per-request bound for every fetch in the live suite. A request that never
// answers would otherwise hold its case until vitest's testTimeout, and the
// fetch itself keeps running after the case fails. Bounded, a stalled request
// rejects with an abort error: a FAIL naming the case, never a refusal.

/**
 * The live suite's per-case and per-hook timeout (vitest.live.config.ts): a
 * paced hook() (src/http.ts) can wait up to a minute inside a case.
 */
export const LIVE_TEST_TIMEOUT_MS = 180_000;

/** Default per-request bound; edge.test.ts keeps its own, shorter one. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Setup publishes (POST /api/v1/artifacts for markers and throwaways) get a
 * longer bound: a slow install can take 10-30 s to publish. Not retried (a
 * retry could make a duplicate), except setupFetch's retryFresh opt-in.
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

/**
 * The mark setupFetch's retryFresh: "new-artifact" puts on its Request
 * (read by src/transport.ts): a setup publish that creates a new throwaway
 * artifact whose caller uses only the returned id. A repeat at worst leaves
 * one more private throwaway, never a wrong verdict.
 */
export const NEW_ARTIFACT = Symbol.for("redline.transport.newArtifact");

/** What a setup publish that ran out of time fails with (after "infra: "). */
export const setupTimeout = (install: string, ms: number) =>
  `setup publish timed out after ${Math.round(ms / 1000)}s on ${install}`;

/**
 * Sends a setup publish and reads its body within `ms` (default
 * SETUP_PUBLISH_MS), past the suite's per-fetch bound. Running out of time
 * throws InfraError (setupTimeout), and so does no response at all
 * (setupNetwork). Redirects are not followed.
 *
 * Not retried, unless the call site opts in with retryFresh: "new-artifact"
 * (#1133): the publish creates a new throwaway artifact and the caller uses
 * only the returned id. Then src/transport.ts (the global fetch in the live
 * suite) sends it once more on a new connection when the first try got no
 * response on a reused socket, and notes the retry. Never on an HTTP status,
 * a timeout or a new socket; never for a call that lists or counts artifacts
 * or reuses a fixed title (a duplicate there could change a verdict).
 */
export async function setupFetch(
  install: string,
  req: Request,
  o: { ms?: number; fetch?: typeof fetch; retryFresh?: "new-artifact" } = {},
): Promise<{ res: Response; text: string }> {
  const ms = o.ms ?? SETUP_PUBLISH_MS;
  const timeout = AbortSignal.timeout(ms);
  try {
    const sent = new Request(req, {
      redirect: "manual",
      signal: AbortSignal.any([req.signal, timeout]),
    });
    if (o.retryFresh === "new-artifact")
      (sent as Request & { [NEW_ARTIFACT]?: true })[NEW_ARTIFACT] = true;
    const res = await unbound(o.fetch)(sent);
    // Not readBody: a body that stalls must time out, not read as "".
    return { res, text: await res.text() };
  } catch (e) {
    if (timeout.aborted && !req.signal.aborted)
      throw new InfraError(setupTimeout(install, ms), { cause: e });
    // No answer at all (reset, "fetch failed"): infra. Any retry already
    // happened in the transport (retryFresh); none here.
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
 * True when `e` means the request got no usable response: undici's TypeError
 * "fetch failed" (any cause) or "terminated" (the connection died mid-body),
 * a socket code (ECONNRESET, ...), or an abort/timeout. Never an HTTP status
 * or an assertion.
 */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (
    e instanceof TypeError &&
    (e.message === "fetch failed" || e.message === "terminated")
  )
    return true;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  const code = (e as { code?: unknown }).code;
  const cause = (e as { cause?: { code?: unknown } }).cause?.code;
  return (
    (typeof code === "string" && NET_CODES.has(code)) ||
    (typeof cause === "string" && NET_CODES.has(cause))
  );
}

/**
 * The socket code when `e` is a request that got no HTTP response for a
 * transport reason (#1133): a code isNetworkError knows (ECONNRESET,
 * UND_ERR_SOCKET, ...), on the error or its cause. Undefined for an abort or a
 * timeout (ours or a caller's: they have their own handling), a TLS failure
 * or an unknown cause (a bad certificate on our host can be a product bug),
 * and anything that isn't a network error.
 */
export function noResponseCode(e: unknown): string | undefined {
  if (!isNetworkError(e)) return undefined;
  const name = (e as Error).name;
  if (name === "AbortError" || name === "TimeoutError") return undefined;
  const code = networkCode(e);
  return NET_CODES.has(code) ? code : undefined;
}

/** A fetch that failed because the host name has no DNS record (ENOTFOUND only). */
export function notResolved(e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  return cause?.code === "ENOTFOUND";
}
