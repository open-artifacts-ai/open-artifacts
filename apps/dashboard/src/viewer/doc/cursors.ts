// Remote cursors (design rule 3): a 2px caret with a small name flag. People's
// flags are pill-shaped; an agent's flag has a rounded-square mark in the
// agent's own colour. Outsiders see a generic "Agent".
//
// The flag shows for FLAG_MS after that person's cursor moves, or while the
// caret is hovered; otherwise only the coloured caret and a small dot (a
// rounded square for an agent) stay.

export interface CaretUser {
  name?: string;
  color?: string;
  kind?: "user" | "agent";
  /** The sender's client id, when it sends one: tells two tabs of one name apart. */
  cid?: number;
}

/** How long a name flag stays open after its cursor moves. */
export const FLAG_MS = 2000;

/** What identifies a caret: its client id if sent, else its name. */
export const caretKey = (u: CaretUser) => String(u.cid ?? u.name ?? "");

/**
 * Which carets recently moved. A caret's flag is open while its key is active;
 * touch() opens it and closes it again after FLAG_MS. Open flags are marked
 * data-active on the caret element, found under root().
 */
export class CaretActivity {
  private open = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private root: () => ParentNode | null) {}

  isActive(key: string) {
    return this.open.has(key);
  }
  touch(key: string) {
    this.open.add(key);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.open.delete(key);
        this.timers.delete(key);
        this.mark(key, false);
      }, FLAG_MS),
    );
    this.mark(key, true);
    // The caret widget may be (re)built just after this; render() checks
    // isActive, and this catches one that was already in place.
    queueMicrotask(() => this.open.has(key) && this.mark(key, true));
  }
  private mark(key: string, on: boolean) {
    for (const el of this.root()?.querySelectorAll<HTMLElement>(
      ".oa-doc-caret",
    ) ?? []) {
      if (el.dataset.key !== key) continue;
      if (on) el.dataset.active = "";
      else delete el.dataset.active;
    }
  }
  destroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.open.clear();
  }
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

export function renderCaret(
  u: CaretUser,
  outsider: boolean,
  activity?: CaretActivity,
): HTMLElement {
  const { agent, name, color } = resolve(u, outsider);
  const caret = document.createElement("span");
  caret.className = "oa-doc-caret";
  const key = caretKey(u);
  caret.dataset.key = key;
  caret.dataset.kind = agent ? "agent" : "user";
  if (activity?.isActive(key)) caret.dataset.active = "";
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
  // The collapsed mark: a dot, or a rounded square for an agent.
  const dot = document.createElement("span");
  dot.className = "oa-doc-dot";
  dot.setAttribute("aria-hidden", "true");
  caret.append(dot, flag);
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
