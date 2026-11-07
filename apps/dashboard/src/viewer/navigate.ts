import { NAVIGATE_PATH_RE } from "@oa/shared";
import { isEmbed } from "../embed";

/**
 * An artifact asked the shell to navigate (a plain link to this app clicked
 * inside the frame). The message is content-controlled, so only a same-origin
 * artifact view path passes: no credentials, and any query or hash is dropped.
 * Returns the path to go to, or null to ignore the request.
 */
export function artifactNavPath(
  url: string,
  origin: string = location.origin,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin || u.username || u.password) return null;
  return NAVIGATE_PATH_RE.test(u.pathname) ? u.pathname : null;
}

export const NAV_INTERVAL_MS = 1_000;

/** True at most once per NAV_INTERVAL_MS: navigate and open share one. */
export function createLimiter(now: () => number = Date.now) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < NAV_INTERVAL_MS) return false;
    last = t;
    return true;
  };
}

const newTab = (u: string) => void window.open(u, "_blank", "noopener");

/**
 * Builds the shell's navigate handler: validates the URL, ignores a second
 * request within NAV_INTERVAL_MS, and in embed mode opens a new tab instead of
 * moving this (framed) window.
 */
export function createNavigator(
  go: (path: string) => void,
  opts: {
    origin?: string;
    now?: () => number;
    limit?: () => boolean;
    embed?: () => boolean;
    open?: (url: string) => void;
  } = {},
) {
  const limit = opts.limit ?? createLimiter(opts.now);
  const embed = opts.embed ?? isEmbed;
  const open = opts.open ?? newTab;
  return (url: string) => {
    const origin = opts.origin ?? location.origin;
    const path = artifactNavPath(url, origin);
    if (!path || !limit()) return;
    if (embed()) open(origin + path);
    else go(path);
  };
}

/**
 * A web address the shell may open for an artifact: http(s), no credentials,
 * and no control characters or spaces anywhere in what the artifact sent (the
 * URL parser would drop or encode them, hiding what was asked for).
 */
export function openableUrl(url: string): URL | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
  if (/[\u0000-\u0020\u007f]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u;
}

const HOST_MAX = 32;

/**
 * The host to name in a prompt: ASCII (punycode as is), the port only when it
 * isn't the scheme's default, no "www.", cut from the left (the port stays).
 */
export function linkHost(u: URL): string {
  const h = u.host.replace(/^www\./, "");
  return h.length > HOST_MAX ? `…${h.slice(-(HOST_MAX - 1))}` : h;
}

const bareHost = (h: string) => h.replace(/\.$/, "");

/** Transient user activation in this window (a click in the frame counts). */
const userActive = () =>
  (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation?.isActive === true;

/**
 * Builds the shell's open handler: an artifact asked to open a plain link that
 * the sandboxed frame can't show. The message is content-controlled, so:
 * - only http(s) without credentials or control characters;
 * - on the app's host (any scheme or port: http redirects to https) only
 *   viewer paths, which route in place like navigate (anything else could be
 *   consent phishing, an invite, or a query-driven action); nothing on the
 *   content host, whatever the scheme or port;
 * - the shared rate limit, and nothing while a prompt is showing (so the URL
 *   can't change under the cursor);
 * - the top window moves only with transient user activation; without it,
 *   `ask` puts the choice in the shell's chrome and calls `done` when it closes;
 * - a refused app page or content URL gets `refuse`'s note, under the same
 *   lock and limit (the runtime blocks those clicks in place, #525).
 * Embedded, everything opens in a new tab.
 */
export function createOpener(opts: {
  go: (path: string) => void;
  ask: (u: URL, open: () => void, done: () => void) => void;
  /** An app page or content-host URL was refused: say so (names no URL), then `done`. */
  refuse?: (done: () => void) => void;
  limit: () => boolean;
  origin?: string;
  /** The frame's content origin, when known. */
  contentOrigin?: () => string | undefined;
  embed?: () => boolean;
  active?: () => boolean;
  assign?: (url: string) => void;
  open?: (url: string) => void;
}) {
  const embed = opts.embed ?? isEmbed;
  const active = opts.active ?? userActive;
  const assign = opts.assign ?? ((u: string) => location.assign(u));
  const open = opts.open ?? newTab;
  let asking = false;
  const release = () => {
    asking = false;
  };
  /** One note or prompt at a time, inside the shared limit. */
  const refused = () => {
    if (!opts.refuse || !opts.limit()) return;
    asking = true;
    opts.refuse(release);
  };
  return (url: string) => {
    if (asking) return;
    const origin = opts.origin ?? location.origin;
    const u = openableUrl(url);
    if (!u) return;
    // "app.example." is app.example too: compare without a trailing dot.
    const host = bareHost(u.hostname);
    const content = opts.contentOrigin?.();
    if (
      content &&
      host === bareHost(new URL(content).hostname) &&
      host !== bareHost(new URL(origin).hostname)
    )
      return refused();
    const appHost = host === bareHost(new URL(origin).hostname);
    const path =
      appHost && NAVIGATE_PATH_RE.test(u.pathname) ? u.pathname : null;
    if (appHost && !path) return refused();
    if (!opts.limit()) return;
    if (embed()) open(path ? origin + path : u.href);
    else if (path) opts.go(path);
    else if (active()) assign(u.href);
    else {
      asking = true;
      opts.ask(u, () => assign(u.href), release);
    }
  };
}
