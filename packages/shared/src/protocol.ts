import { z } from "zod";
import { ERROR_CODES } from "./errors.js";
import { FORMATS } from "./formats.js";
import { LIMITS } from "./limits.js";
import { shellNonce } from "./nonce.js";
import {
  type Capabilities,
  CapabilitiesSchema,
  DataDocSchema,
  DataNameSchema,
  DataPatchBodySchema,
  DataQuerySchema,
  PageSchema,
  StorageKeyNameSchema,
  StorageKeySchema,
  ThemeSchema,
} from "./schemas.js";
import { utf8Exceeds } from "./utf8.js";

export const PROTOCOL_VERSION = 1;

export const RUNTIME_METHODS = [
  "db.get",
  "db.list",
  "db.query",
  "db.set",
  "db.update",
  "db.delete",
  "db.subscribe",
  "db.unsubscribe",
  "viewer.get",
  "viewer.anonId",
  "storage.get",
  "storage.set",
  "storage.delete",
  "storage.list",
] as const;
export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

const THUMB_PREFIX = "data:image/webp;base64,";
const THUMB_MAX_LEN =
  THUMB_PREFIX.length + 4 * Math.ceil(LIMITS.thumbnailBytes / 3);
const THUMB_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]*={0,2}$/;

const Theme = ThemeSchema;

/**
 * Anonymous id (artifacts with dataWriters "viewers"): the shell sends its
 * signed token "<id>.<iat>.<sig>" (legacy v1: "<id>.<sig>") in this request
 * header on anonymous runtime calls, and the server returns a new one in the
 * same response header whenever it mints one (anonymous writes and R.anonId
 * only; missing, malformed or forged token: new id; v1 or older than 30 days:
 * same id). The token never enters the artifact frame.
 */
export const ANON_ID_HEADER = "X-OA-Anon-Id";
/** Length of the per-artifact public anonId (updatedBy "anon:<short>"). */
export const ANON_ID_SHORT_LEN = 8;
/** A per-artifact public anonId (viewer.anonId(), updatedBy "anon:<anonId>"). */
export const AnonIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8}$/);
/** Body of GET R.anonId, which serves viewer.anonId() for anonymous viewers. */
export const AnonViewerSchema = z.strictObject({ anonId: AnonIdSchema });
export type AnonViewer = z.infer<typeof AnonViewerSchema>;

/**
 * Every artifact to shell message may carry `nonce`: the per-load value the shell
 * put in the frame URL (see nonce.ts). The shell drops messages without its
 * current nonce.
 */
const nonce = z.string().max(64).optional();

export const ArtifactToShellSchema = z.union([
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("hello"),
    protocol: z.number().int().min(1).max(1000),
    kind: z.enum(FORMATS),
  }),
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("call"),
    id: z.string().max(200),
    method: z.enum(RUNTIME_METHODS),
    params: z.unknown(),
  }),
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("pdf.text"),
    version: z.number().int(),
    text: z
      .string()
      .max(LIMITS.extractedTextBytes)
      .refine(
        (s) => !utf8Exceeds(s, LIMITS.extractedTextBytes),
        "text too large",
      ),
  }),
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("thumb.ready"),
    dataUrl: z
      .string()
      .max(THUMB_MAX_LEN)
      .refine((s) => THUMB_RE.test(s), "must be a webp base64 data URL"),
  }),
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("resize"),
    height: z.number().finite().min(0).max(100_000),
  }),
  /**
   * Sent once, on the viewer's first interaction with the artifact. Artifact
   * content can forge or suppress it: it is only a hint for whether the viewer
   * auto-swaps versions, and nothing security-relevant may depend on it.
   */
  z.strictObject({ oa: z.literal(1), nonce, type: z.literal("interacted") }),
  /**
   * The reader is mid-task in the frame (text selected, or an input, textarea
   * or contenteditable focused), or no longer: a live swap waits meanwhile.
   * A hint only, like `interacted`.
   */
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("engaged"),
    engaged: z.boolean(),
  }),
  /**
   * The document's scroll position (throttled): the shell carries it over to
   * the next version's frame after a live swap. A hint only.
   */
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("scroll"),
    top: z.number().finite().min(0).max(10_000_000),
    max: z.number().finite().min(0).max(10_000_000),
  }),
  /**
   * A click on a same-instance viewer link (NAVIGATE_PATH_RE on the welcome's
   * appOrigin). Artifact content can forge this, so the shell must validate
   * `url` strictly (its own origin, NAVIGATE_PATH_RE path only) before opening it.
   */
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("navigate"),
    url: z.string().max(2048),
  }),
  /**
   * A click on any other plain link that would move the frame elsewhere
   * (another origin, the app outside NAVIGATE_PATH_RE, or another artifact's
   * content): the sandboxed frame can't show most sites, so the shell opens it
   * in the top window; app pages and content URLs it refuses, with a note. Artifact
   * content can forge this too: the shell accepts only http(s) without
   * credentials, rate limited, and navigates only with transient user
   * activation (else it asks first).
   */
  z.strictObject({
    oa: z.literal(1),
    nonce,
    type: z.literal("open"),
    url: z.string().max(2048),
  }),
]);
export type ArtifactToShell = z.infer<typeof ArtifactToShellSchema>;

/** `result` with `ok: true` always carries `value` (null for void methods). */
export const ShellToArtifactSchema = z.union([
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("welcome"),
    capabilities: CapabilitiesSchema,
    viewer: z
      .strictObject({ email: z.string(), name: z.string().nullable() })
      .nullable(),
    theme: Theme,
    /** The app's origin; the runtime routes clicks on its /a/ links via `navigate`. */
    appOrigin: z.string().max(200).optional(),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("result"),
    id: z.string(),
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("result"),
    id: z.string(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(ERROR_CODES), message: z.string() }),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("event"),
    event: z.literal("db.change"),
    collection: z.string(),
    docs: z.array(DataDocSchema),
    deleted: z.array(z.string()),
  }),
  /**
   * The shell's socket for `collection` reconnected: changes may have been
   * missed, so subscribers should refetch.
   */
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("event"),
    event: z.literal("db.resync"),
    collection: DataNameSchema,
  }),
  /**
   * The shell's socket for `collection` is down (refused, or failing to
   * reconnect): live changes are paused until a db.resync. Once per outage.
   */
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("event"),
    event: z.literal("db.offline"),
    collection: DataNameSchema,
  }),
  z.strictObject({ oa: z.literal(1), type: z.literal("thumb.request") }),
  z.strictObject({ oa: z.literal(1), type: z.literal("theme"), theme: Theme }),
  /** After a live swap: scroll to where the previous version's frame was. */
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("scroll.to"),
    top: z.number().finite().min(0).max(10_000_000),
    max: z.number().finite().min(0).max(10_000_000),
  }),
]);
export type ShellToArtifact = z.infer<typeof ShellToArtifactSchema>;

export const METHOD_CAPABILITY: Record<RuntimeMethod, keyof Capabilities> = {
  "db.get": "db",
  "db.list": "db",
  "db.query": "db",
  "db.set": "db",
  "db.update": "db",
  "db.delete": "db",
  "db.subscribe": "db",
  "db.unsubscribe": "db",
  "viewer.get": "viewer",
  "viewer.anonId": "viewer",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "storage.list": "storage",
};

/** Posts to the parent shell, adding this load's nonce when there is one. */
export function sendToShell(msg: ArtifactToShell): void {
  if (typeof window === "undefined" || window.parent === window) return;
  const n = shellNonce();
  window.parent.postMessage(n ? { ...msg, nonce: n } : msg, "*");
}

export function parseArtifactMessage(data: unknown): ArtifactToShell | null {
  const r = ArtifactToShellSchema.safeParse(data);
  return r.success ? r.data : null;
}

export function parseShellMessage(data: unknown): ShellToArtifact | null {
  const r = ShellToArtifactSchema.safeParse(data);
  return r.success ? r.data : null;
}

const col = { collection: DataNameSchema };
const Doc = DataDocSchema;
const DocPage = PageSchema(Doc);

/** Strict params schema for each runtime call. */
export const RUNTIME_PARAMS = {
  "db.get": z.strictObject({ ...col, id: DataNameSchema }),
  "db.list": z.strictObject({
    ...col,
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  "db.query": z.strictObject({ ...col, query: DataQuerySchema }),
  "db.set": z.strictObject({ ...col, id: DataNameSchema, data: z.unknown() }),
  "db.update": z.strictObject({
    ...col,
    id: DataNameSchema,
    patch: DataPatchBodySchema,
  }),
  "db.delete": z.strictObject({ ...col, id: DataNameSchema }),
  "db.subscribe": z.strictObject(col),
  "db.unsubscribe": z.strictObject(col),
  "viewer.get": z.strictObject({}),
  "viewer.anonId": z.strictObject({}),
  "storage.get": z.strictObject({ key: StorageKeyNameSchema }),
  "storage.set": z.strictObject({
    key: StorageKeyNameSchema,
    value: z.unknown(),
  }),
  "storage.delete": z.strictObject({ key: StorageKeyNameSchema }),
  "storage.list": z.strictObject({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
} satisfies Record<RuntimeMethod, z.ZodType>;

export type RuntimeParams<M extends RuntimeMethod> = z.input<
  (typeof RUNTIME_PARAMS)[M]
>;

/** Result schema (the `value` of a successful `result` message) for each runtime call. */
export const RUNTIME_RESULTS = {
  "db.get": Doc.nullable(),
  "db.list": DocPage,
  "db.query": DocPage,
  "db.set": Doc,
  "db.update": Doc,
  "db.delete": z.null(),
  "db.subscribe": z.null(),
  "db.unsubscribe": z.null(),
  "viewer.get": z
    .object({ email: z.string(), name: z.string().nullable() })
    .nullable(),
  "viewer.anonId": AnonIdSchema.nullable(),
  "storage.get": z.unknown(),
  "storage.set": z.null(),
  "storage.delete": z.null(),
  "storage.list": PageSchema(StorageKeySchema),
} satisfies Record<RuntimeMethod, z.ZodType>;

export type RuntimeResult<M extends RuntimeMethod> = z.output<
  (typeof RUNTIME_RESULTS)[M]
>;
