/** Splits comment text into plain and http(s) URL pieces. Pure; the caller
    builds React elements, so nothing here is ever HTML. */
export type LinkPiece = { text: string; url?: true };

const URL_RE = /https?:\/\/[^\s<>]+/gi;
const TRAIL = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
const PAIRS: Record<string, string> = { ")": "(", "]": "[" };

const count = (s: string, c: string) => s.split(c).length - 1;

function trim(raw: string): string {
  let u = raw;
  for (;;) {
    const last = u.at(-1) ?? "";
    const open = PAIRS[last];
    if (TRAIL.has(last) || (open && count(u, last) > count(u, open))) {
      u = u.slice(0, -1);
    } else return u;
  }
}

export function linkify(text: string): LinkPiece[] {
  const out: LinkPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trim(m[0]);
    if (!/^https?:\/\/[^/?#]/i.test(url)) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: url, url: true });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
