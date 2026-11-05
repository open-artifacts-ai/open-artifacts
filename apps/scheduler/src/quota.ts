/**
 * Email-quota alert: the previous UTC day's sends, summed over the sending
 * zones, against the account's daily limit. Read from Cloudflare's own Email
 * Sending analytics (GraphQL, zone-level dataset `emailSendingAdaptiveGroups`;
 * https://developers.cloudflare.com/email-service/observability/metrics-analytics/),
 * never from an install's D1. The sending limit is per account
 * (https://developers.cloudflare.com/email-service/platform/limits/), so the
 * zones of one account are summed against one limit.
 *
 * Logs fixed lines only: no token, zone tag, response text, address or URL.
 */

export interface QuotaEnv {
  /** Secret: Zone > Analytics > Read on the sending zone(s). Optional. */
  EMAIL_QUOTA_TOKEN?: string;
  /** Comma-separated zone tags. */
  EMAIL_QUOTA_ZONES?: string;
  /** The account's daily sending limit, a positive integer. */
  EMAIL_DAILY_LIMIT?: string;
}

export interface QuotaOptions {
  timeoutMs?: number;
}

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DAY_MS = 86_400_000;
/** Warn at or above this share of the limit. */
const WARN_PCT = 80;
/** A zone-scoped GraphQL query takes at most 10 zones. */
const MAX_ZONES = 10;

// `count` is per event; an email has several (queued, delivered, ...), and
// only its last has isLastEvent 1, so that filter counts each email once.
// No status filter, on purpose: suppressed and verified-destination sends
// don't count toward Cloudflare's limit but are counted here. Over-counting
// is the conservative direction for an alert. (`limit` is inert: with no
// dimensions each zone returns one aggregate row; it is only a ceiling.)
const QUERY = `query EmailQuota($zoneTags: [string!]!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      emailSendingAdaptiveGroups(
        filter: { datetimeHour_geq: $start, datetimeHour_lt: $end, isLastEvent: 1 }
        limit: 10000
      ) {
        count
      }
    }
  }
}`;

type Category = "http" | "graphql" | "timeout" | "shape";

class Failure extends Error {
  constructor(readonly category: Category) {
    super(category);
  }
}

function config(env: QuotaEnv): { zones: string[]; limit: number } | null {
  // Lowercased and deduped: a repeated tag would return one zone and fail
  // the zone-count check every night.
  const zones = [
    ...new Set(
      (env.EMAIL_QUOTA_ZONES ?? "")
        .split(",")
        .map((z) => z.trim().toLowerCase())
        .filter((z) => z !== ""),
    ),
  ];
  const raw = env.EMAIL_DAILY_LIMIT ?? "";
  if (
    zones.length === 0 ||
    zones.length > MAX_ZONES ||
    !zones.every((z) => /^[0-9a-f]{32}$/.test(z)) ||
    !/^[1-9][0-9]{0,8}$/.test(raw)
  )
    return null;
  return { zones, limit: Number(raw) };
}

/** Sum of every group's count over every zone; anything unexpected is `shape`. */
function sum(body: unknown, zones: number): number {
  const b = body as {
    errors?: unknown;
    data?: { viewer?: { zones?: unknown } } | null;
  } | null;
  if (typeof b !== "object" || b === null) throw new Failure("shape");
  if (Array.isArray(b.errors) && b.errors.length > 0)
    throw new Failure("graphql");
  const z = b.data?.viewer?.zones;
  // A zone the token can't read is absent: never sum a partial answer.
  if (!Array.isArray(z) || z.length !== zones) throw new Failure("shape");
  let total = 0;
  for (const zone of z) {
    const g = (zone as { emailSendingAdaptiveGroups?: unknown } | null)
      ?.emailSendingAdaptiveGroups;
    if (!Array.isArray(g)) throw new Failure("shape");
    for (const row of g) {
      const c = (row as { count?: unknown } | null)?.count;
      if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0)
        throw new Failure("shape");
      total += c;
    }
  }
  return total;
}

async function query(
  token: string,
  zones: string[],
  scheduledTime: number,
  signal: AbortSignal,
): Promise<number> {
  const day = Math.floor(scheduledTime / DAY_MS) * DAY_MS;
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          zoneTags: zones,
          start: new Date(day - DAY_MS).toISOString(),
          end: new Date(day).toISOString(),
        },
      }),
      // Never follow a redirect with the token; a 3xx is `http`.
      redirect: "manual",
      signal,
    });
  } catch {
    throw new Failure(signal.aborted ? "timeout" : "http");
  }
  if (!res.ok || res.status >= 300) throw new Failure("http");
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Failure(signal.aborted ? "timeout" : "shape");
  }
  return sum(body, zones.length);
}

/**
 * Never throws: every outcome is one fixed log line. A hard timeout (10 s by
 * default) bounds the whole call, body included, even if fetch ignores abort.
 */
export async function emailQuota(
  env: QuotaEnv,
  scheduledTime: number,
  { timeoutMs = 10_000 }: QuotaOptions = {},
): Promise<void> {
  const token = env.EMAIL_QUOTA_TOKEN;
  if (!token) {
    console.log("email-quota skipped no_token");
    return;
  }
  const cfg = config(env);
  if (!cfg) {
    console.log("email-quota skipped config");
    return;
  }
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = await Promise.race([
      query(token, cfg.zones, scheduledTime, ctl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Failure("timeout"));
        }, timeoutMs);
      }),
    ]);
    // Integer math: no float rounding at the 80% line.
    const pct = Math.floor((sent * 100) / cfg.limit);
    const line = `sent=${sent} limit=${cfg.limit} pct=${pct}`;
    if (sent * 100 >= WARN_PCT * cfg.limit)
      console.warn("email-quota warn", line);
    else console.log("email-quota ok", line);
  } catch (e) {
    console.error(
      "email-quota failed",
      e instanceof Failure ? e.category : "http",
    );
  } finally {
    clearTimeout(timer);
  }
}
