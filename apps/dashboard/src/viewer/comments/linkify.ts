/** Splits comment text into plain and http(s) URL pieces. Pure; the caller
    builds React elements, so nothing here is ever HTML. */
export type LinkPiece = { text: string; url?: true };

const URL_RE = /https?:\/\/[^\s<>]+/gi;
const TRAIL = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
const PAIRS: Record<string, string> = { ")": "(", "]": "[" };

function trim(raw: string): string {
  const seen: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0 };
  for (const c of raw) if (c in seen) seen[c] = (seen[c] ?? 0) + 1;
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1] ?? "";
    const open = PAIRS[last];
    if (TRAIL.has(last)) end--;
    else if (open && (seen[last] ?? 0) > (seen[open] ?? 0)) {
      seen[last] = (seen[last] ?? 0) - 1;
      end--;
    } else break;
  }
  return raw.slice(0, end);
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
