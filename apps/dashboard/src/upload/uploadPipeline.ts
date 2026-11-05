import {
  contentTypeFor,
  findCaseCollision,
  LIMITS,
  normalizePath,
  type PublishResult,
  PublishResultSchema,
  R,
  UploadCreatedSchema,
} from "@oa/shared";

import { api } from "../api/client";
import { entryRefusal } from "./openable";

export type UploadInput = {
  files: File[];
  title: string;
  message?: string;
  entry?: string;
  /** Hosted: the shared space to create it in (create only); omitted, the caller's personal space. */
  spaceId?: string;
};
export type Progress = { done: number; total: number };

/** Thrown before any request is sent; the message names the offending file. */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const rawPath = (f: File) => f.webkitRelativePath || f.name;

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** The folder shared by every file (a folder drop), if any. */
export function commonFolder(files: File[]): string | undefined {
  const paths = files.map(rawPath);
  const top = paths[0]?.split("/")[0];
  if (!top || top === "." || top === "..") return undefined;
  return paths.every((p) => p.includes("/") && p.split("/")[0] === top)
    ? top
    : undefined;
}

/** Paths relative to the dropped folder: a top folder shared by every file is stripped. */
export function relativePaths(files: File[]): string[] {
  const paths = files.map(rawPath);
  return commonFolder(files)
    ? paths.map((p) => p.slice(p.indexOf("/") + 1))
    : paths;
}

/** index.html, else README.md, else the only file; undefined when the user must choose. */
export function defaultEntry(paths: string[]): string | undefined {
  if (paths.includes("index.html")) return "index.html";
  if (paths.includes("README.md")) return "README.md";
  return paths.length === 1 ? paths[0] : undefined;
}

/** Dropped junk: OS metadata files and anything under a dot-folder. */
export const isIgnored = (path: string) => {
  const parts = path.split("/");
  return (
    parts.some((p, i) => i < parts.length - 1 && p.startsWith(".")) ||
    ["Thumbs.db", ".DS_Store"].includes(parts.at(-1) ?? "")
  );
};

/** Validates every file; returns the normalized path for each. */
export function validateUpload(files: File[]): string[] {
  if (files.length === 0) throw new UploadValidationError("No files to upload");
  if (files.length > LIMITS.filesPerVersion)
    throw new UploadValidationError(
      `Too many files (${files.length}); the limit is ${LIMITS.filesPerVersion}`,
    );
  const paths = relativePaths(files).map((p, i) => {
    const r = normalizePath(p);
    if (!r.ok)
      throw new UploadValidationError(
        `"${p}" has an invalid path (${r.error})`,
      );
    const size = files[i]?.size ?? 0;
    if (size === 0)
      throw new UploadValidationError(`"${r.path}" is empty (0 bytes)`);
    if (r.path.split("/").some((seg) => RESERVED.has(seg)))
      throw new UploadValidationError(`"${r.path}" uses a reserved name`);
    if (size > LIMITS.fileBytes)
      throw new UploadValidationError(
        `"${r.path}" is ${mb(size)}; the limit is ${mb(LIMITS.fileBytes)} per file`,
      );
    return r.path;
  });
  const dup = paths.find((p, i) => paths.indexOf(p) !== i);
  if (dup) throw new UploadValidationError(`"${dup}" appears more than once`);
  const pair = findCaseCollision(paths);
  if (pair)
    throw new UploadValidationError(
      `"${pair[0]}" and "${pair[1]}" differ only by letter case`,
    );
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > LIMITS.publishBytes)
    throw new UploadValidationError(
      `Files total ${mb(total)}; the limit is ${mb(LIMITS.publishBytes)} per upload`,
    );
  return paths;
}

/** Rejects as soon as the signal aborts, even if `p` never settles. */
const abortable = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> =>
  signal
    ? Promise.race([
        p,
        new Promise<never>((_, reject) => {
          const fail = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        }),
      ])
    : p;

/**
 * Uploads each file to its signed URL, then publishes once, reusing the artifact id
 * the first upload reserved.
 */
export async function uploadArtifact(
  input: UploadInput,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<PublishResult> {
  const paths = validateUpload(input.files);
  if (!input.title.trim())
    throw new UploadValidationError("A title is required");
  const given =
    input.entry === undefined ? undefined : normalizePath(input.entry);
  if (given && !given.ok)
    throw new UploadValidationError(
      `Entry "${input.entry}" is not a valid path`,
    );
  const entry = given?.ok ? given.path : defaultEntry(paths);
  if (entry === undefined && paths.length > 1)
    throw new UploadValidationError("Choose which file to open first (entry)");
  if (entry !== undefined && !paths.includes(entry))
    throw new UploadValidationError(`Entry "${entry}" is not one of the files`);
  // Before anything is sent: an entry the viewer can't open is refused here.
  const opened = entry ?? paths[0];
  const refusal =
    opened === undefined
      ? null
      : await entryRefusal(opened, input.files[paths.indexOf(opened)] as File);
  if (refusal) throw new UploadValidationError(refusal);

  const total = paths.length;
  let reserved: string | undefined;
  const files: Record<string, { uploadId: string }> = Object.create(null);
  onProgress({ done: 0, total });
  for (const [i, file] of input.files.entries()) {
    const path = paths[i] as string;
    signal?.throwIfAborted();
    const contentType = contentTypeFor(path);
    const created = await api.send(
      "POST",
      R.uploads,
      { artifactId: reserved, path, size: file.size, contentType },
      UploadCreatedSchema,
      signal,
    );
    reserved ??= created.artifactId;
    signal?.throwIfAborted();
    try {
      await abortable(
        api.putRaw(created.url, file, contentType, undefined, signal),
        signal,
      );
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new UploadValidationError(
        `Couldn't upload "${path}": ${e instanceof Error ? e.message : "upload failed"}`,
      );
    }
    files[path] = { uploadId: created.uploadId };
    onProgress({ done: i + 1, total });
  }
  signal?.throwIfAborted();
  const message = input.message?.trim() || undefined;
  const body = { files, entry, message };
  return api.send(
    "POST",
    R.artifacts,
    {
      ...body,
      id: reserved,
      title: input.title.trim(),
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    },
    PublishResultSchema,
    signal,
  );
}
