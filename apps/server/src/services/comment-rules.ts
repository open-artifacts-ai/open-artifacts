import { stripNameControls } from "@oa/shared";

// Server-side rules for comments (#682) that the wire contract (@oa/shared
// comments.ts) leaves to the implementation.

/** GET: most threads returned, newest activity first. */
export const COMMENTS_MAX_THREADS = 500;
/** GET: most replies per thread (the root is extra); a 201st reply is 409. */
export const COMMENTS_MAX_REPLIES = 200;
/** GET: most comments across all the threads returned. */
export const COMMENTS_MAX_TOTAL = 5000;
/** GET: most body bytes across the threads returned (a DO RPC answer is capped near 32 MiB). */
export const COMMENTS_MAX_BYTES = 4 * 1024 * 1024;
/** A pin's contentHash. */
export const CONTENT_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
export type CommentStatus = "open" | "resolved";

/** The name a signed-out commenter shows: controls stripped, at most 50 characters; blank is "Guest". */
export function cleanGuestName(raw: string | undefined): string {
  const cut = [
    ...stripNameControls(raw ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, 50)
    .join("")
    .trim();
  return cut === "" ? "Guest" : cut;
}
