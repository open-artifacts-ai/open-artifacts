import { PRESENCE_COOKIE } from "@oa/shared";

const ID_CHARS = 22;

const mint = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_CHARS));
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (const b of bytes) out += alphabet[b & 63];
  return out;
};

let memo: string | undefined;

/**
 * The anonymous presence id: the `oa_pid` session cookie (no Expires or
 * Max-Age, Path=/, SameSite=Lax, Secure on https), minted once. Never touches
 * `oa.anonId`; never throws (a blocked cookie jar falls back to a per-page id).
 */
export function presenceId(): string {
  try {
    const m = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${PRESENCE_COOKIE}=`));
    const cur = m?.slice(PRESENCE_COOKIE.length + 1);
    if (cur) return cur;
    const id = memo ?? mint();
    memo = id;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${PRESENCE_COOKIE}=${id}; Path=/; SameSite=Lax${secure}`;
    return id;
  } catch {
    memo ??= mint();
    return memo;
  }
}
