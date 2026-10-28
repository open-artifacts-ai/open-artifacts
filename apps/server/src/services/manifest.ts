import {
  bytesHead,
  checkEntry,
  contentTypeFor,
  type EntryRefusal,
  type Format,
  findCaseCollision,
  INLINE_TOO_LARGE_MESSAGE,
  inferFormat,
  inferLanguage,
  LIMITS,
  newId,
  normalizePath,
  type PublishInput,
  SNIFF_BYTES,
  textHead,
  UNSUPPORTED_FORMAT_MESSAGE,
} from "@oa/shared";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { decodeBase64 } from "../util/base64.js";
import { isWellFormed, utf8Encoder, utf8Length } from "../util/text.js";

/** One file of a version, as stored in versions.manifest (JSON). */
export type ManifestEntry = {
  path: string;
  key: string;
  size: number;
  contentType: string;
};
/**
 * Inline files are sized once, here, so their size is exact before any write.
 * Well-formed text stays a string (R2 encodes it natively; `size` is its UTF-8
 * length): no 2× copy of the content in an encoded buffer per publish.
 */
export type PlannedSource =
  | { bytes: Uint8Array }
  | { text: string; size: number }
  | { uploadId: string };
export type Plan = {
  files: Array<{ path: string; source: PlannedSource }>;
  entry: string;
  format: Format;
  language: string | null;
};

const bad = (path: string, reason: string, message?: string) =>
  new ApiError("bad_request", message ?? `Invalid file "${path}": ${reason}`, {
    path,
    reason,
  });
const tooLarge = (path: string, limit: number) =>
  new ApiError("too_large", `"${path}" exceeds the ${limit}-byte limit`, {
    path,
    reason: "too_large",
  });
/** Inline bytes over LIMITS.inlineBytes: 413 with the create_upload hint (C3). */
const inlineTooLarge = (path: string) =>
  new ApiError("too_large", INLINE_TOO_LARGE_MESSAGE, {
    path,
    reason: "too_large",
  });
/** No `format` and the entry's name implies none (inferFormat null): 400 unsupported_format. */
const noViewer = (path: string) =>
  new ApiError("unsupported_format", UNSUPPORTED_FORMAT_MESSAGE, {
    path,
    reason: "no_viewer",
  });

/** The entry's content doesn't fit its format: 400 binary_entry. */
const refuse = (path: string, r: EntryRefusal) =>
  new ApiError("binary_entry", r.message, { path, reason: r.reason });

/** Checks an inline entry's first SNIFF_BYTES against its format. */
function checkInline(
  path: string,
  format: Format,
  s: { bytes: Uint8Array } | { text: string; size: number },
): void {
  const { head, truncated } =
    "text" in s ? textHead(s.text) : bytesHead(s.bytes);
  const r = checkEntry(path, format, head, truncated);
  if (r) throw refuse(path, r);
}

function norm(p: unknown): string {
  if (typeof p !== "string") throw bad(String(p), "invalid");
  const r = normalizePath(p);
  if (!r.ok) throw bad(p, r.error);
  // The content host answers `{prefix}__view` itself; a root file there is unreachable.
  if (r.path === "__view") throw bad(p, "reserved_name");
  return r.path;
}

/** Max inline files per publish (keeps R2 puts + D1 calls under 1000 subrequests). */
export const MAX_INLINE_FILES = 900;
/** File keys that would collide with Object.prototype members. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// language (as given, or as inferLanguage returns it) → file extension
const EXT_GROUPS: Record<string, string[]> = {
  py: ["python", "py", "python3"],
  ts: ["typescript", "ts"],
  tsx: ["tsx"],
  js: ["javascript", "js", "node"],
  jsx: ["jsx"],
  rs: ["rust", "rs"],
  go: ["go", "golang"],
  rb: ["ruby", "rb"],
  sh: ["shell", "bash", "sh", "zsh"],
  yml: ["yaml", "yml"],
  md: ["markdown", "md"],
  mdx: ["mdx"],
  json: ["json", "jsonc"],
  html: ["html"],
  css: ["css"],
  scss: ["scss"],
  sql: ["sql"],
  c: ["c"],
  cpp: ["cpp", "c++"],
  cs: ["csharp", "c#", "cs"],
  java: ["java"],
  kt: ["kotlin", "kt"],
  swift: ["swift"],
  php: ["php"],
  lua: ["lua"],
  r: ["r"],
  dart: ["dart"],
  scala: ["scala"],
  hs: ["haskell", "hs"],
  pl: ["perl", "pl"],
  ex: ["elixir", "ex"],
  zig: ["zig"],
  toml: ["toml"],
  xml: ["xml"],
  vue: ["vue"],
  svelte: ["svelte"],
  graphql: ["graphql"],
  tf: ["hcl", "terraform", "tf"],
  diff: ["diff", "patch"],
};
const EXT = new Map(
  Object.entries(EXT_GROUPS).flatMap(([ext, names]) =>
    names.map((n) => [n, ext] as const),
  ),
);
function defaultEntry(format: Format, language: string | null): string {
  if (format === "html") return "index.html";
  if (format === "markdown") return "README.md";
  if (format === "pdf") return "document.pdf";
  return `main.${EXT.get((language ?? "").toLowerCase()) ?? "txt"}`;
}

/**
 * Validates and plans a publish. Defensive (the input may not have passed
 * PublishInputSchema): every error is an ApiError with details {path, reason};
 * inline bytes (UTF-8 text, decoded base64) total ≤ LIMITS.inlineBytes (413).
 */
export function planFiles(input: PublishInput): Plan {
  let budget: number = LIMITS.inlineBytes;
  const take = (path: string, size: number) => {
    if (size > budget) throw inlineTooLarge(path);
    budget -= size;
  };
  /** Text as TextEncoder would store it: lone surrogates become U+FFFD bytes. */
  const textSource = (path: string, v: string): PlannedSource => {
    if (!isWellFormed(v)) {
      const bytes = utf8Encoder.encode(v);
      take(path, bytes.length);
      return { bytes };
    }
    const size = utf8Length(v);
    take(path, size);
    return { text: v, size };
  };
  const { content, files } = input as { content?: unknown; files?: unknown };

  if (content !== undefined) {
    if (typeof content !== "string") throw bad("content", "invalid");
    if (files !== undefined)
      throw bad("files", "content_and_files", "Provide content or files");
    const entryIn = input.entry === undefined ? undefined : norm(input.entry);
    if (!input.format && entryIn === undefined)
      throw bad("format", "missing", "content requires format or entry");
    const format = input.format ?? inferFormat(entryIn as string);
    if (!format) throw noViewer(entryIn as string);
    const language =
      input.language ??
      (format === "code" ? (entryIn ? inferLanguage(entryIn) : "text") : null);
    const entry = entryIn ?? defaultEntry(format, language);
    // UTF-8 is ≥ 1 byte per UTF-16 unit: reject before encoding when obviously too big.
    if (content.length > budget) throw inlineTooLarge(entry);
    const source = textSource(entry, content);
    checkInline(entry, format, source);
    return {
      files: [{ path: entry, source }],
      entry,
      format,
      language,
    };
  }

  if (files === null || typeof files !== "object" || Array.isArray(files))
    throw bad("files", "invalid", "Provide content or files");
  const record = files as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) throw bad("files", "empty");
  if (keys.length > LIMITS.filesPerVersion)
    throw bad(
      "files",
      "too_many_files",
      `files exceeds ${LIMITS.filesPerVersion} entries`,
    );
  const byPath = new Map<string, string>(); // normalized → original key
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) throw bad(key, "reserved_name");
    const p = norm(key);
    if (byPath.has(p)) throw bad(key, "duplicate");
    byPath.set(p, key);
  }
  const pair = findCaseCollision([...byPath.keys()]);
  if (pair) throw bad(byPath.get(pair[1]) ?? pair[1], "case_collision");

  let entry: string;
  if (input.entry !== undefined) {
    entry = norm(input.entry);
    if (!byPath.has(entry))
      throw bad(
        input.entry,
        "missing_entry",
        `entry "${input.entry}" is not in files`,
      );
  } else {
    entry = byPath.has("index.html")
      ? "index.html"
      : byPath.has("README.md")
        ? "README.md"
        : (byPath.keys().next().value as string);
  }

  let inline = 0;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" || (v && typeof v === "object" && "base64" in v))
      if (++inline > MAX_INLINE_FILES)
        throw new ApiError(
          "too_large",
          `publish more than ${MAX_INLINE_FILES} inline files via uploads`,
          { path: "files", reason: "too_many_inline_files" },
        );
  }
  const out: Plan["files"] = [];
  for (const [path, key] of byPath) {
    const v = record[key];
    if (typeof v === "string") {
      if (v.length > budget) throw inlineTooLarge(key);
      out.push({ path, source: textSource(key, v) });
    } else if (v && typeof v === "object" && "base64" in v) {
      const b64 = (v as { base64: unknown }).base64;
      if (typeof b64 !== "string") throw bad(key, "invalid_base64");
      if (b64.length > Math.ceil((budget * 4) / 3) + 3)
        throw inlineTooLarge(key);
      const bytes = decodeBase64(b64);
      if (!bytes) throw bad(key, "invalid_base64");
      take(key, bytes.length);
      out.push({ path, source: { bytes } });
    } else if (
      v &&
      typeof v === "object" &&
      typeof (v as { uploadId?: unknown }).uploadId === "string"
    ) {
      out.push({
        path,
        source: { uploadId: (v as { uploadId: string }).uploadId },
      });
    } else throw bad(key, "invalid");
  }
  const format = input.format ?? inferFormat(entry);
  if (!format) throw noViewer(entry);
  const head = out.find((f) => f.path === entry)?.source;
  // An uploaded entry is checked in materialize (one R2 range read).
  if (head && !("uploadId" in head)) checkInline(entry, format, head);
  const language =
    input.language ?? (format === "code" ? inferLanguage(entry) : null);
  return { files: out, entry, format, language };
}

const inlineSize = (
  s: { bytes: Uint8Array } | { text: string; size: number },
) => ("text" in s ? s.size : s.bytes.length);

type UploadRow = {
  id: string;
  artifact_id: string;
  user_id: string;
  r2_key: string;
  size: number;
  content_type: string;
  path: string;
  consumed: number;
  received_at: number | null;
};

/**
 * An uploaded entry's first SNIFF_BYTES (one R2 range read, the entry only)
 * and declared content type against the plan's format: 400 binary_entry.
 * Runs before anything is written or consumed.
 */
async function checkUploadedEntry(
  env: Env,
  plan: Plan,
  rows: Map<string, UploadRow>,
): Promise<void> {
  const f = plan.files.find((x) => x.path === plan.entry);
  if (!f || !("uploadId" in f.source)) return;
  const row = rows.get(f.source.uploadId) as UploadRow;
  const obj = await env.FILES.get(row.r2_key, {
    range: { offset: 0, length: SNIFF_BYTES },
  });
  if (!obj) throw bad(f.path, "upload_incomplete");
  const head = new Uint8Array(await obj.arrayBuffer());
  const r = checkEntry(
    f.path,
    plan.format,
    head,
    row.size > head.length,
    row.content_type,
  );
  if (r) throw refuse(f.path, r);
}

/**
 * Resolves uploads (must belong to (artifactId, userId), be unconsumed, match the
 * path and be fully PUT, i.e. received_at set; no R2 head), checks the publish total ≤ LIMITS.publishBytes, then
 * writes inline files to R2. Nothing is written unless all checks pass.
 * `written` lists the new keys (for cleanup); `uploadIds` must be marked consumed.
 */
export async function materialize(
  env: Env,
  artifactId: string,
  userId: string,
  plan: Plan,
): Promise<{
  manifest: ManifestEntry[];
  written: string[];
  uploadIds: string[];
}> {
  const ids = plan.files.flatMap((f) =>
    "uploadId" in f.source ? [f.source.uploadId] : [],
  );
  const rows = new Map<string, UploadRow>();
  if (ids.length) {
    const r = await env.DB.prepare(
      "select * from uploads where id in (select value from json_each(?))",
    )
      .bind(JSON.stringify(ids))
      .all<UploadRow>();
    for (const row of r.results) rows.set(row.id, row);
  }
  let total = 0;
  for (const f of plan.files) {
    if (!("uploadId" in f.source)) {
      total += inlineSize(f.source);
      continue;
    }
    const row = rows.get(f.source.uploadId);
    if (
      !row ||
      row.artifact_id !== artifactId ||
      row.user_id !== userId ||
      row.consumed !== 0 ||
      row.path !== f.path
    )
      throw bad(f.path, "invalid_upload");
    // null = never PUT; -1 = PUT in flight
    if (row.received_at === null || row.received_at <= 0)
      throw bad(f.path, "upload_incomplete");
    total += row.size;
  }
  if (total > LIMITS.publishBytes) throw tooLarge("files", LIMITS.publishBytes);
  await checkUploadedEntry(env, plan, rows);

  const written: string[] = [];
  const manifest: ManifestEntry[] = [];
  const puts: Promise<unknown>[] = [];
  for (const f of plan.files) {
    if ("uploadId" in f.source) {
      const row = rows.get(f.source.uploadId) as UploadRow;
      manifest.push({
        path: f.path,
        key: row.r2_key,
        size: row.size,
        contentType: row.content_type,
      });
      continue;
    }
    const key = `files/${artifactId}/${newId()}`;
    const contentType = contentTypeFor(f.path);
    written.push(key);
    manifest.push({
      path: f.path,
      key,
      size: inlineSize(f.source),
      contentType,
    });
    puts.push(
      env.FILES.put(key, "text" in f.source ? f.source.text : f.source.bytes, {
        httpMetadata: { contentType },
      }),
    );
  }
  const res = await Promise.allSettled(puts);
  const failed = res.find((r) => r.status === "rejected");
  if (failed) {
    await env.FILES.delete(written).catch(() => {});
    throw (failed as PromiseRejectedResult).reason;
  }
  return { manifest, written, uploadIds: ids };
}
