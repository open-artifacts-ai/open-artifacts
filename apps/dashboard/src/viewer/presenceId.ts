import { PRESENCE_COOKIE, PRESENCE_ID_RE } from "@oa/shared";

/**
 * The anonymous presence id: a random value in a session cookie on the app
 * origin (no Expires/Max-Age, Path=/, SameSite=Lax, Secure on https). The
 * server treats it as opaque. Never derived from or stored next to
 * `oa.anonId`, and never throws (a blocked cookie just means no id).
 */
export function presenceId(): string {
  try {
    const m = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${PRESENCE_COOKIE}=`));
    const have = m?.slice(PRESENCE_COOKIE.length + 1);
    if (have && PRESENCE_ID_RE.test(have)) return have;
    const bytes = crypto.getRandomValues(new Uint8Array(17));
    const id = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
      .slice(0, 22);
    const secure = location.protocol === "https:" ? "; Secure" : "";
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is not universal; this is a plain session cookie
    document.cookie = `${PRESENCE_COOKIE}=${id}; Path=/; SameSite=Lax${secure}`;
    return id;
  } catch {
    return "";
  }
}
