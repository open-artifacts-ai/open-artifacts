// Daily latest-release check (B3). The cron reads GitHub's release list once
// a day and stores the latest stable release, plus which stable releases are
// breaking, in one D1 `settings` row. D1, not KV: /me already reads every
// settings row in one statement, so the badge costs no extra read, and one
// D1 write a day stays clear of the Free plan's KV write cap (1,000/day)
// that OAuth already spends. Failures keep the last good value and record
// checkError; nothing here throws.
//
// The cron runs once a day (17 3 * * *), so a failed check is retried on the
// next day's tick; there is no same-day retry.
import type { InstanceUpdate, Role } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logError, logWarn } from "../log.js";
import { VERSION } from "../version.gen.js";

export const RELEASE_REPO = "open-artifacts-ai/open-artifacts";
export const RELEASES_PAGE = 100;
/** One call: the newest RELEASES_PAGE releases (drafts are hidden unauthenticated). */
export const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=${RELEASES_PAGE}`;
/** Not API rate-limited: a redirect to /releases/tag/<latest stable tag>. */
export const RELEASE_LATEST_HTML = `https://github.com/${RELEASE_REPO}/releases/latest`;
const TAG_PREFIX = `https://github.com/${RELEASE_REPO}/releases/tag/`;
export const RELEASE_KEY = "latest_release";
const TIMEOUT_MS = 5000;
/** 100 releases with notes are a few hundred KB; far larger is not that. */
const MAX_BODY = 4 << 20;

/** The settings row. The release fields are the last good check; checkError
 * and errorAt describe the latest failure (null after a success). */
export type StoredRelease = {
  tag?: string;
  version?: string;
  publishedAt?: string | null;
  notesUrl?: string;
  /** Stable versions whose notes contain "BREAKING CHANGE"; null when
   * unknown (the latest came from the redirect fallback). */
  breakingVersions?: string[] | null;
  /** Oldest stable version in the page when the page was full (older
   * releases unseen); null when the page held every release. */
  coveredFrom?: string | null;
  /** ms epoch of the last good check. */
  checkedAt?: number;
  checkError: string | null;
  errorAt: number | null;
};

type Semver = [number, number, number];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** [major, minor, patch] for a plain X.Y.Z (a leading v allowed), else null. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER.exec(v.startsWith("v") ? v.slice(1) : v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a < b. */
function lessThan(a: Semver, b: Semver): boolean {
  for (let i = 0; i < 3; i++)
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  return false;
}

const SET =
  "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value";
const GET = "select value from settings where key = ?";

export function parseStored(
  raw: string | undefined | null,
): StoredRelease | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredRelease;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

async function readStored(env: Env): Promise<StoredRelease | null> {
  return parseStored(
    (await stmt(env.DB, GET).bind(RELEASE_KEY).first<{ value: string }>())
      ?.value,
  );
}

type Good = {
  ok: true;
  tag: string;
  publishedAt: string | null;
  breakingVersions: string[] | null;
  coveredFrom: string | null;
};
type Outcome = Good | { ok: false; error: string };

const UA = `open-artifacts/${VERSION}`;
const failure = (e: unknown): Outcome => ({
  ok: false,
  error:
    e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network",
});

type ApiRelease = {
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

async function fetchReleases(fetcher: typeof fetch): Promise<Outcome> {
  let r: Response;
  try {
    r = await fetcher(RELEASES_API, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": UA,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return failure(e);
  }
  if (!r.ok) {
    await r.body?.cancel();
    // 403/429: the unauthenticated limit (60/h per egress IP, shared on
    // Cloudflare). Neither is "up to date".
    return {
      ok: false,
      error:
        r.status === 403 || r.status === 429
          ? "rate_limited"
          : r.status === 404
            ? "no_release"
            : `http_${r.status}`,
    };
  }
  let list: unknown;
  try {
    const text = await r.text();
    if (text.length > MAX_BODY) return { ok: false, error: "bad_json" };
    list = JSON.parse(text);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (!Array.isArray(list)) return { ok: false, error: "bad_json" };
  let latest: { v: Semver; rel: ApiRelease; tag: string } | null = null;
  let oldest: Semver | null = null;
  const breakingVersions: string[] = [];
  for (const rel of list as ApiRelease[]) {
    if (!rel || typeof rel !== "object") continue;
    if (rel.draft === true || rel.prerelease === true) continue;
    if (typeof rel.tag_name !== "string") continue;
    const v = parseSemver(rel.tag_name);
    if (!v) continue;
    if (!latest || lessThan(latest.v, v))
      latest = { v, rel, tag: rel.tag_name };
    if (!oldest || lessThan(v, oldest)) oldest = v;
    if (typeof rel.body === "string" && rel.body.includes("BREAKING CHANGE"))
      breakingVersions.push(v.join("."));
  }
  if (!latest) return { ok: false, error: "no_release" };
  return {
    ok: true,
    tag: latest.tag,
    publishedAt:
      typeof latest.rel.published_at === "string"
        ? latest.rel.published_at
        : null,
    breakingVersions,
    coveredFrom:
      list.length >= RELEASES_PAGE && oldest ? oldest.join(".") : null,
  };
}

/** Fallback when the API is rate-limited: the HTML /releases/latest
 * redirect names the latest stable tag. Breaking info is unknown. */
async function fetchLatestRedirect(fetcher: typeof fetch): Promise<Outcome> {
  let r: Response;
  try {
    r = await fetcher(RELEASE_LATEST_HTML, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return failure(e);
  }
  await r.body?.cancel();
  const loc = r.headers.get("location") ?? "";
  if (r.status < 300 || r.status >= 400 || !loc.startsWith(TAG_PREFIX))
    return { ok: false, error: "rate_limited" };
  let tag: string;
  try {
    tag = decodeURIComponent(
      loc.slice(TAG_PREFIX.length).split(/[/?#]/)[0] ?? "",
    );
  } catch {
    return { ok: false, error: "rate_limited" };
  }
  if (!parseSemver(tag)) return { ok: false, error: "bad_tag" };
  return {
    ok: true,
    tag,
    publishedAt: null,
    breakingVersions: null,
    coveredFrom: null,
  };
}

/** Cron: fetch the release list (or the redirect fallback) and store it. Never throws. */
export async function checkLatestRelease(
  env: Env,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<StoredRelease | null> {
  try {
    let out = await fetchReleases(fetcher);
    if (!out.ok && out.error === "rate_limited")
      out = await fetchLatestRedirect(fetcher);
    let next: StoredRelease;
    if (out.ok) {
      const version = (parseSemver(out.tag) as Semver).join(".");
      next = {
        tag: out.tag,
        version,
        publishedAt: out.publishedAt,
        // Built from the validated tag, not from the response.
        notesUrl: TAG_PREFIX + encodeURIComponent(out.tag),
        breakingVersions: out.breakingVersions,
        coveredFrom: out.coveredFrom,
        checkedAt: now,
        checkError: null,
        errorAt: null,
      };
      if (out.breakingVersions === null) {
        // Fallback: the last API check's breaking list still holds while
        // the latest release is unchanged.
        const prev = await readStored(env);
        if (prev?.version === version && Array.isArray(prev.breakingVersions)) {
          next.breakingVersions = prev.breakingVersions;
          next.coveredFrom = prev.coveredFrom ?? null;
          next.publishedAt = prev.publishedAt ?? null;
        }
      }
    } else {
      next = {
        ...((await readStored(env)) ?? {}),
        checkError: out.error,
        errorAt: now,
      };
      logWarn("release_check_failed", undefined, { reason: out.error });
    }
    await stmt(env.DB, SET).bind(RELEASE_KEY, JSON.stringify(next)).run();
    return next;
  } catch (e) {
    logError("release_check_error", e);
    return null;
  }
}

/** Any breaking release in (cur, latest]; null when unknown. */
function breakingInRange(
  s: StoredRelease,
  cur: Semver,
  latest: Semver,
): boolean | null {
  if (!lessThan(cur, latest)) return false;
  if (!Array.isArray(s.breakingVersions)) return null;
  const hit = s.breakingVersions.some((b) => {
    const v = parseSemver(b);
    return !!v && lessThan(cur, v) && !lessThan(latest, v);
  });
  if (hit) return true;
  // Releases older than the page are unseen: unknown if cur predates it.
  const from = s.coveredFrom ? parseSemver(s.coveredFrom) : null;
  return from && lessThan(cur, from) ? null : false;
}

/** Me.instance.update: owner and admins only, and only after a good check. */
export function instanceUpdate(
  role: Role,
  raw: string | undefined,
  current: string = VERSION,
): InstanceUpdate | null {
  if (role !== "owner" && role !== "admin") return null;
  const s = parseStored(raw);
  if (!s || typeof s.version !== "string" || typeof s.checkedAt !== "number")
    return null;
  const latest = parseSemver(s.version);
  if (!latest) return null;
  const cur = parseSemver(current);
  return {
    latestVersion: s.version,
    current,
    // A -dev/prerelease or otherwise non-plain build is custom: no badge,
    // and no range to judge breaking over.
    custom: !cur,
    updateAvailable: !!cur && lessThan(cur, latest),
    breaking: cur ? breakingInRange(s, cur, latest) : null,
    notesUrl:
      typeof s.notesUrl === "string"
        ? s.notesUrl
        : `https://github.com/${RELEASE_REPO}/releases`,
    checkedAt: new Date(s.checkedAt).toISOString(),
    latestPublishedAt: typeof s.publishedAt === "string" ? s.publishedAt : null,
  };
}
