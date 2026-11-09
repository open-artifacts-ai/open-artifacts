import { stripNameControls } from "@oa/shared";

// Server-side rules for comments (#682) that the wire contract (@oa/shared
// comments.ts) leaves to the implementation.

/** GET: most threads returned, newest activity first. */
export const COMMENTS_MAX_THREADS = 500;
/** GET: most replies per thread (the root is extra); a 201st reply is 409. */
export const COMMENTS_MAX_REPLIES = 200;
/** #1614: a reply to an ask's author notifies its agents at most once per thread per window, and this many times per thread in all. */
export const ASKER_NOTICE_WINDOW_MS = 60_000;
export const ASKER_NOTICES_MAX = 20;
/** GET: most comments across all the threads returned. */
export const COMMENTS_MAX_TOTAL = 5000;
/** GET: most body bytes across the threads returned (a DO RPC answer is capped near 32 MiB). */
export const COMMENTS_MAX_BYTES = 4 * 1024 * 1024;
export type CommentStatus = "open" | "resolved";

/** A name ending in "'s agent": straight, curly, modifier and full-width apostrophes, any case. */
const AGENT_SUFFIX =
  /['\u2019\u2018\u02bc\u2032\u00b4`\uff07]\s*s\s+agent\s*$/iu;

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
  // #1822: a guest never reads as someone's agent, in any casing or apostrophe.
  return cut === "" || AGENT_SUFFIX.test(cut.normalize("NFKC")) ? "Guest" : cut;
}
