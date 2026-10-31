/** Control characters, DEL or any whitespace (browsers strip tabs and newlines from URLs). */
const unsafeChar = (c: string) => {
  const n = c.charCodeAt(0);
  return n <= 0x1f || n === 0x7f || /\s/.test(c);
};

/**
 * A same-origin path to send someone to after sign-in, or "/". Only a string
 * with exactly one leading "/" passes: no "//" or "/\" (protocol-relative to
 * another host), no scheme, and no control or whitespace characters.
 */
export const safeReturn = (raw: unknown): string => {
  if (typeof raw !== "string" || raw[0] !== "/") return "/";
  if (raw[1] === "/" || raw[1] === "\\") return "/";
  if ([...raw].some(unsafeChar)) return "/";
  return raw;
};
