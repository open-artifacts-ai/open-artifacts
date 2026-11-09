import { z } from "zod";
import { BusNameSchema } from "./names.ts";

/**
 * A lead template (#1328): what a person has set up so a lead can be started
 * from the bus. It lives in `<OA_BUS_HOME>/leads/<name>.json`, never in a repo.
 *
 * A template cannot express a command. The schema is strict, so `command`,
 * `args`, `env`, `shell` or any other key is refused, and every value is a
 * closed enum, a validated path, a bus name or a fixed-shape URL. The daemon
 * (not this package) builds the argv from the harness and the permission cap.
 */

/** The file name is the template name: `<name>.json`. */
export const LEAD_TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Names that would collide with other files in the same folder. */
const RESERVED_TEMPLATE_NAMES = new Set(["config"]);

export const LeadTemplateNameSchema = z
  .string()
  .regex(LEAD_TEMPLATE_NAME_RE, "invalid template name")
  .refine(
    (s) => !RESERVED_TEMPLATE_NAMES.has(s.toLowerCase()),
    "template name is reserved",
  );

/** A template file above this is refused unread. */
export const LEAD_TEMPLATE_MAX_BYTES = 64 * 1024;

export const LEAD_HARNESSES = [
  "claude-code",
  "codex",
  "pi",
  "opencode",
] as const;
export type LeadHarness = (typeof LEAD_HARNESSES)[number];

/**
 * How far a started lead may act on its own, lowest first. There is no value
 * that maps to a bypass mode, and there never will be one: adding a rung is a
 * reviewed change to this list, not a string a file can carry.
 */
export const LEAD_PERMISSION_CAPS = ["read_only", "ask", "edits"] as const;
export type LeadPermissionCap = (typeof LEAD_PERMISSION_CAPS)[number];

/** Whether `a` allows no more than `b`. */
export const permissionWithin = (
  a: LeadPermissionCap,
  b: LeadPermissionCap,
): boolean =>
  LEAD_PERMISSION_CAPS.indexOf(a) <= LEAD_PERMISSION_CAPS.indexOf(b);

export const LEAD_WORKTREE_MODES = ["new", "none"] as const;

const MAX_PATH_CHARS = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * An absolute POSIX path in its own normal form: starts with `/`, no empty,
 * `.` or `..` segments, no trailing slash (except `/`), no control characters.
 * What the daemon opens is then exactly what the person read.
 */
export function isNormalAbsolutePath(s: string): boolean {
  if (s.length === 0 || s.length > MAX_PATH_CHARS) return false;
  if (!s.startsWith("/") || CONTROL_RE.test(s) || s.includes("\\"))
    return false;
  if (s === "/") return true;
  return s
    .slice(1)
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const AbsolutePathSchema = z
  .string()
  .refine(
    isNormalAbsolutePath,
    "must be an absolute path with no '..', '.' or empty parts",
  );

/** `<origin>/a/<artifact id>`: the brief a started lead is told to read. */
const BRIEF_PATH_RE = /^\/a\/[A-Za-z0-9]{8,64}$/;

/**
 * The origin of a brief URL when it has the fixed shape (http or https, no
 * credentials, no query or fragment, path `/a/<id>`), else undefined. The
 * hub's origin is not known here: the daemon compares it (`briefOrigin`).
 */
export function briefOrigin(brief: string): string | undefined {
  let u: URL;
  try {
    u = new URL(brief);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  if (!BRIEF_PATH_RE.test(u.pathname)) return undefined;
  // The text must be the URL's own normal form: nothing the parser rewrote.
  if (u.href !== brief) return undefined;
  return u.origin;
}

const BriefSchema = z
  .string()
  .max(2048)
  .refine(
    (s) => briefOrigin(s) !== undefined,
    "must be <hub origin>/a/<artifact id>",
  );

const ModelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,63}$/, "invalid model");

const LeadTemplateObject = z.strictObject({
  harness: z.enum(LEAD_HARNESSES),
  /** Absolute path of the harness binary, recorded so a PATH change cannot swap it. */
  binary: AbsolutePathSchema,
  repo: AbsolutePathSchema,
  worktree: z.enum(LEAD_WORKTREE_MODES),
  worktree_root: AbsolutePathSchema.optional(),
  /** The bus name the lead takes. BusNameSchema refuses system-notice names. */
  role_name: BusNameSchema,
  brief: BriefSchema,
  model: ModelSchema.optional(),
  permission_cap: z.enum(LEAD_PERMISSION_CAPS),
});

/** A new worktree needs a folder to live in; with none, a folder would mean nothing. */
export const LeadTemplateSchema = LeadTemplateObject.refine(
  (t) => (t.worktree === "new") === (t.worktree_root !== undefined),
  {
    message:
      "worktree_root is required with worktree 'new' and not allowed otherwise",
    path: ["worktree_root"],
  },
);
export type LeadTemplate = z.infer<typeof LeadTemplateSchema>;

/**
 * The template as one string, whatever the order of the keys in the file:
 * keys sorted, absent optionals left out. It is of the validated object, so
 * what is hashed is exactly what the schema accepted.
 */
export function canonicalLeadTemplate(t: LeadTemplate): string {
  const entries = Object.entries(t)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

/** sha256 of the canonical form, lowercase hex. Stable under key order, changes with any value. */
export async function leadTemplateHash(t: LeadTemplate): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalLeadTemplate(t));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
