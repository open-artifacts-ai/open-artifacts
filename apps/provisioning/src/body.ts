import { ApiError } from "./errors.js";

/**
 * A write body the HTTP adapter has not read: invokeRoute reads it at the
 * schema step, after the rate limit and authz (4.2), so 415, 413 and a bad
 * JSON body never answer a caller the route would refuse, on either surface.
 */
export class LazyBody {
  constructor(readonly read: () => Promise<unknown>) {}
}

/** Write bodies are capped at 16 KiB (3.1). */
export const BODY_CAP = 16 * 1024;

/**
 * A write's JSON body (3.1): `application/json` (else 415), at most
 * BODY_CAP bytes, counted as read so a missing or false content-length
 * cannot pass (else 413), then parsed (else 400 invalid_input). An empty
 * body is undefined; the route's schema decides whether that is allowed.
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new ApiError("unsupported_media_type");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > BODY_CAP) throw new ApiError("payload_too_large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_CAP) {
        await reader.cancel();
        throw new ApiError("payload_too_large");
      }
      chunks.push(value);
    }
  }
  if (size === 0) return undefined;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("invalid_input", "body is not JSON");
  }
}
