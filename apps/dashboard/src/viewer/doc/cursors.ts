// Remote cursors (design rule 3): a 2px caret with a small name flag. People's
// flags are pill-shaped; an agent's flag has a rounded-square mark in the
// agent's own colour. Outsiders see a generic "Agent".

export interface CaretUser {
  name?: string;
  color?: string;
  kind?: "user" | "agent";
}

const OUTSIDER_AGENT = { name: "Agent", color: "#6b7280" };

function readable(hex: string): "#fff" | "#111" {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = Number.parseInt(m[1], 16);
  const lum =
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) /
    255;
  return lum > 0.6 ? "#111" : "#fff";
}

function resolve(u: CaretUser, outsider: boolean) {
  const agent = u.kind === "agent";
  if (agent && outsider) return { agent, ...OUTSIDER_AGENT };
  return {
    agent,
    name: (u.name || (agent ? "Agent" : "Someone")).slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(u.color ?? "")
      ? (u.color as string)
      : "#6b7280",
  };
}

export function renderCaret(u: CaretUser, outsider: boolean): HTMLElement {
  const { agent, name, color } = resolve(u, outsider);
  const caret = document.createElement("span");
  caret.className = "oa-doc-caret";
  caret.style.setProperty("--oa-caret", color);
  const flag = document.createElement("span");
  flag.className = "oa-doc-flag";
  flag.dataset.kind = agent ? "agent" : "user";
  flag.style.setProperty("--oa-flag-fg", readable(color));
  if (agent) {
    const mark = document.createElement("span");
    mark.className = "oa-doc-flag-mark";
    mark.setAttribute("aria-hidden", "true");
    flag.append(mark);
  }
  flag.append(document.createTextNode(name));
  caret.append(flag);
  return caret;
}

export function renderSelection(u: CaretUser, outsider: boolean) {
  const { color } = resolve(u, outsider);
  return { class: "oa-doc-selection", style: `--oa-caret: ${color}` };
}

/** A stable, readable colour for a name (people who pick no colour). */
const PALETTE = [
  "#2563eb",
  "#c2410c",
  "#15803d",
  "#9333ea",
  "#be185d",
  "#0e7490",
  "#a16207",
];
export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
