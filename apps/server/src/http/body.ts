import type { Context } from "hono";
import { utf8Decoder } from "../util/text.js";
import { ApiError } from "./errors.js";

export type Parser<T> = {
  safeParse(
    x: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: unknown } };
};

/** Parse a JSON request body against a (strict) schema; 400 bad_request otherwise. */
export async function jsonBody<T>(c: Context, schema: Parser<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ApiError("bad_request", "Invalid request body", r.error.issues);
  return r.data;
}

/** A declared Content-Length in [0, max], or null (absent or malformed). */
function declaredLength(c: Context, max: number): number | null {
  const h = c.req.header("content-length");
  if (h === undefined || !/^\d{1,16}$/.test(h)) return null;
  const n = Number(h);
  return n <= max ? n : null;
}

const tooLargeError = (max: number, message?: string) =>
  new ApiError("too_large", message ?? `Request body exceeds ${max} bytes`);

/**
 * Reads the body with a running cap: 413 as soon as `max` is exceeded.
 * With a Content-Length ≤ max (the HTTP framing bounds the body to it) the
 * body is read natively in one call; otherwise chunk by chunk. A JS read loop
 * over a 2 MB body costs ~3 ms CPU on workerd (one promise per chunk).
 * `message` replaces the default 413 text.
 */
export async function readCapped(
  c: Context,
  max: number,
  message?: string,
): Promise<Uint8Array> {
  if (Number(c.req.header("content-length") ?? 0) > max)
    throw tooLargeError(max, message);
  if (!c.req.raw.body) return new Uint8Array(0);
  if (declaredLength(c, max) !== null) {
    const out = new Uint8Array(await c.req.raw.arrayBuffer());
    if (out.byteLength > max) throw tooLargeError(max, message);
    return out;
  }
  return readStreamCapped(c.req.raw.body, max, message);
}

/**
 * readCapped over a plain Request (consumes its body; pass a clone to keep it).
 * Always a running cap, with or without Content-Length.
 */
export async function readCappedRequest(
  req: Pick<Request, "headers" | "body">,
  max: number,
): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? 0) > max)
    throw tooLargeError(max);
  if (!req.body) return new Uint8Array(0);
  return readStreamCapped(req.body, max);
}

async function readStreamCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  message?: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLargeError(max, message);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

/** readCapped + JSON.parse + schema; 413 past `max`, 400 on bad JSON or schema. */
export async function cappedJson<T>(
  c: Context,
  schema: Parser<T>,
  max: number,
): Promise<T> {
  const buf = await readCapped(c, max);
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decoder.decode(buf));
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ApiError("bad_request", "Invalid request body", r.error.issues);
  return r.data;
}
