import { z } from "zod";
import { LIMITS } from "./limits.js";

/** 32-bit FNV-1a over UTF-16 code units, as 8 lowercase hex chars. Pure JS. */
function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const SCHEME_RE = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\//i;
const NORMALIZED_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\/[a-z0-9._~-]+)+$/;

/**
 * Normalized repo identity: `host/owner/repo`, lowercased, no scheme, no user,
 * no port, no `.git`, no trailing slash, dot segments resolved.
 * `github.com/Acme/Widgets.git` on one machine equals
 * `https://github.com/acme/widgets` on another.
 *
 * Intentional: the port is dropped and the path is lowercased. Clones of one
 * repo reach it through different ports/protocols and casings, and the spec
 * wants them to be one namespace; the cost is that two case-distinct repos on
 * one case-sensitive host merge.
 *
 * Single-label hosts, IPs, localhost, `git+ssh://` and `~user` paths are
 * accepted. Paths longer than the namespace cap are truncated and suffixed
 * with `-` plus an 8-hex FNV-1a hash of the full string, so they stay distinct.
 */
export function normalizeRemote(remote: string): string | null {
  const s = remote.trim();
  if (
    !s ||
    s.startsWith("/") ||
    s.startsWith(".") ||
    s.startsWith("~") ||
    s.startsWith("file:") ||
    s.includes("\\")
  )
    return null;
  let host: string;
  let path: string;
  if (SCHEME_RE.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    host = u.hostname;
    path = u.pathname;
  } else {
    // scp form `[user@]host:path`. Without a user the host must look like a
    // domain, so `foo:bar` and `C:/x` are not mistaken for remotes.
    const scp = /^(?:([^@/\s]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(s);
    if (!scp) return null;
    const [, user, h, p] = scp;
    if (!user && !/\.[A-Za-z]{2,}$/.test(h as string)) return null;
    host = h as string;
    path = p as string;
  }
  const segs: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segs.pop();
    else segs.push(seg);
  }
  let joined = segs
    .join("/")
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/(?:\/?\.git)+$/, "");
  joined = joined.replace(/\/+$/, "");
  const full = `${host.toLowerCase().replace(/^www\./, "")}/${joined}`;
  if (!NORMALIZED_RE.test(full)) return null;
  if (full.length <= LIMITS.maxNamespaceChars) return full;
  return `${full.slice(0, LIMITS.maxNamespaceChars - 9)}-${fnv8(full)}`;
}

/** Collapse `//`, resolve `.`/`..` (never above the root), rejoin. */
function resolveSegments(s: string): string {
  const out: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const trimEdges = (s: string): string => s.replace(/^[-./]+|[-./]+$/g, "");

/**
 * A directory name as a namespace slug: diacritics folded, ASCII only. Keeps
 * `~` and `--`, resolves path segments, and re-trims after the length cap, so
 * `sanitize(sanitize(x)) === sanitize(x)`.
 */
const sanitize = (s: string): string => {
  const slug = s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._~/-]+/g, "-");
  const resolved = trimEdges(resolveSegments(slug));
  return trimEdges(
    resolveSegments(resolved.slice(0, LIMITS.maxNamespaceChars)),
  );
};

/** A non-ASCII letter or digit that NFKD + mark stripping could not map. */
const LOSSY_RE = /(?=[\p{L}\p{N}])[^\p{ASCII}]/u;

/**
 * Slug of a directory name. If non-ASCII letters were dropped (no ASCII
 * mapping), `-<fnv8 of the NFC name>` is appended, or `dir-<hash>` when nothing
 * is left, so distinct names stay distinct. Hashing NFC keeps macOS (NFD) and
 * Linux (NFC) spellings of one name equal.
 */
function dirNamespace(name: string): string {
  const raw = name.trim();
  if (!raw) return "";
  const slug = sanitize(raw);
  const folded = raw.normalize("NFKD").replace(/\p{M}+/gu, "");
  if (!LOSSY_RE.test(folded))
    return slug || `dir-${fnv8(raw.normalize("NFC"))}`;
  const h = fnv8(raw.normalize("NFC"));
  return slug
    ? `${slug.slice(0, LIMITS.maxNamespaceChars - 9)}-${h}`
    : `dir-${h}`;
}

/**
 * The spec's fallback chain: normalized remote -> git root directory name ->
 * cwd basename -> "default". Pure: the caller supplies what it found on disk.
 */
export function namespaceFrom(input: {
  remoteUrl: string | null;
  gitRootName: string | null;
  cwd: string;
}): string {
  return settle(derive(input));
}

function derive(input: {
  remoteUrl: string | null;
  gitRootName: string | null;
  cwd: string;
}): string {
  const remote = input.remoteUrl ? normalizeRemote(input.remoteUrl) : null;
  if (remote) return remote;
  const root = input.gitRootName ? dirNamespace(input.gitRootName) : "";
  if (root) return root;
  const base =
    input.cwd
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? "";
  return dirNamespace(base) || "default";
}

// C0/C1 controls, zero-width, bidi controls, line/paragraph separators, BOM.
/** `host.tld/path` with no scheme. */
const SCHEMELESS_RE = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+$/;

// Also: lone surrogates (Cs), every format char (Cf: U+00AD, U+2061-2064,
// U+180E, tags...), U+034F and the Hangul fillers.
export const BAD_NS_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: Cf/Cs are matched on purpose
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u061c\u2060\u2066-\u2069\ufeff\p{Cs}\p{Cf}\u034f\u115f\u1160\u3164\uffa0]/u;

/** One normalization pass: remote form, scheme-less remote, else dir slug. */
function step(s: string): string {
  return (
    normalizeRemote(s) ??
    (SCHEMELESS_RE.test(s) ? normalizeRemote(`https://${s}`) : null) ??
    dirNamespace(s)
  );
}

/**
 * Re-apply `step` until it stops changing the value, so a result that happens
 * to look like a remote (e.g. `a.io/x.git` from a slug) is canonical too and
 * parsing the output again is a no-op. Chains of up to 5 passes were observed;
 * the cap is a guard only.
 */
function settle(y: string): string {
  for (let i = 0; i < 8; i++) {
    const n = step(y);
    if (n === y) return y;
    y = n;
  }
  return y;
}

/**
 * A namespace. One that parses as a git remote (URL or scp form) is normalized
 * like the auto-derived one, so `.openbus.json` cannot silently split from it;
 * anything else goes through the same slug as a directory name ("My Team" ->
 * "my-team"). Every output is wire-canonical (`WireNamespaceSchema`).
 */
export const NamespaceSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxNamespaceChars * 4)
  .refine((s) => s === s.trim() && !BAD_NS_CHARS.test(s), "invalid namespace")
  .transform((s) => settle(step(s)))
  .refine((s) => s.length <= LIMITS.maxNamespaceChars, "invalid namespace");

/**
 * A namespace as it travels on the wire: already canonical, never transformed.
 * Daemons normalize (namespaceFrom / NamespaceSchema) before sending and the
 * hub rejects anything else. Lowercase, at most 128 chars, `[a-z0-9._~/-]`
 * only (so no scheme, `:` or `@`, and no URL parsing is needed), which covers
 * everything `namespaceFrom` outputs.
 */
export const WireNamespaceSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxNamespaceChars)
  .regex(/^[a-z0-9._~/-]+$/, "non-canonical namespace");
