import { displayKind, stripTerminalControls } from "@oa/bus-ipc";
import type { Ctx } from "../context.ts";
import { cols, cutCols, cutMiddle } from "../copy.ts";
import { bold, glyph, paint, type Style } from "../term.ts";

// Control, format and line-separator characters: never shown.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKING_CAP = 10;
const WIDE_COLS = 100;

export type Verdict = "working" | "degraded" | "down";

export type InstanceView = {
  name: string;
  host: string;
  ok: boolean;
  reason?: "can't reach" | "revoked";
};

export type StatusAgent = {
  name: string;
  kind: string;
  machine: string;
  state: "live" | "queued";
  status?: string | undefined;
  status_label?: string | undefined;
  status_at?: string | undefined;
};

export type OtherProject = {
  namespace: string;
  count: number;
};

export type AttentionItem = {
  problem: string;
  fix: string;
};

export type StatusScreen = {
  version: string;
  verdict: Verdict;
  machine?: string | undefined;
  instances: InstanceView[];
  /** Printed between instances and Agents only when non-empty (#3328 S2). */
  attention?: AttentionItem[];
  /** Omitted when the daemon or all instances are down. */
  project?: {
    agents: StatusAgent[];
    others: OtherProject[];
  };
  agentsPageUrl?: string | undefined;
  busCmd: string;
  now: number;
  width: number;
};

/** Strips terminal controls and invisible formatting characters. */
export const cleanText = (s: string): string =>
  stripTerminalControls(s)
    .replace(HIDDEN, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

/** Terminal width in columns, falling back to COLUMNS env or 80. */
export function terminalWidth(ctx: Pick<Ctx, "stdout" | "env">): number {
  const col = ctx.stdout.columns;
  if (typeof col === "number" && Number.isFinite(col) && col > 0)
    return Math.max(40, Math.floor(col));
  const envCol = Number.parseInt(ctx.env.COLUMNS ?? "", 10);
  if (Number.isFinite(envCol) && envCol > 0) return Math.max(40, envCol);
  return 80;
}

/** Compact machine label for the verdict line and agent rows. */
export function shortMachine(label: string): string {
  const s = cleanText(label);
  if (!s) return "";
  const host = s.includes(" ") ? s : (s.split(".")[0] ?? s);
  if (/macbook/i.test(host)) return "MacBook";
  if (/mac[\s-]?studio/i.test(host)) return "Mac Studio";
  if (/mac[\s-]?mini/i.test(host)) return "Mac Mini";
  if (/\bimac\b/i.test(host)) return "iMac";
  if (/workstation/i.test(host)) return "Workstation";
  const possessive = /^[a-z0-9]+['’]s\s+(.+)$/i.exec(host);
  return possessive?.[1] ?? host;
}

const SHORT_APP: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  antigravity: "agy",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

/** Compact app label for agent rows. */
export function shortApp(kind: string): string {
  return Object.hasOwn(SHORT_APP, kind)
    ? (SHORT_APP[kind] as string)
    : cleanText(displayKind(kind));
}

/** Compact age ("now", "6m", "3h", "2d"); empty when no valid timestamp. */
export function shortAge(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (24 * 60))}d`;
}

/** Short project name for "Other projects: name (count)". */
export function shortNamespace(ns: string): string {
  const s = cleanText(ns);
  const slash = s.lastIndexOf("/");
  return slash >= 0 && slash < s.length - 1 ? s.slice(slash + 1) : s;
}

const DEFAULT_NAME =
  /^(agent|claude|code|codex|opencode|pi|omp|hermes|openclaw|agy)(-\d+)?$/i;

/**
 * Harness-generated default names with no real status (or only "starting")
 * are counted as unnamed and hidden from the default screen.
 */
export function isUnnamedHidden(a: StatusAgent): boolean {
  if (!DEFAULT_NAME.test(a.name.trim())) return false;
  if (!a.status) return true;
  if (a.status === "idle") {
    const label = a.status_label?.trim() ?? "";
    return label === "" || label === "starting";
  }
  return false;
}

type Group = "needs_you" | "working" | "idle_old";

export function classifyAgent(a: StatusAgent, now: number): Group {
  if (a.status === "waiting_on_owner" || a.status === "blocked")
    return "needs_you";
  if (!a.status) return "idle_old";
  if (a.status === "idle") {
    const at = a.status_at ? Date.parse(a.status_at) : Number.NaN;
    if (!Number.isFinite(at) || now - at >= DAY_MS) return "idle_old";
  }
  return "working";
}

const padRight = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - cols(s)));

const byRecent = (a: StatusAgent, b: StatusAgent): number => {
  const ta = a.status_at ? Date.parse(a.status_at) : -Infinity;
  const tb = b.status_at ? Date.parse(b.status_at) : -Infinity;
  const va = Number.isFinite(ta) ? ta : -Infinity;
  const vb = Number.isFinite(tb) ? tb : -Infinity;
  if (va !== vb) return vb - va;
  return a.name.localeCompare(b.name);
};

const wrapWithPrefix = (
  firstPrefix: string,
  firstPrefixCols: number,
  contPrefix: string,
  contPrefixCols: number,
  text: string,
  width: number,
  more: string,
): string[] => {
  const cleaned = cleanText(text);
  const firstRoom = Math.max(8, width - firstPrefixCols);
  if (cols(cleaned) <= firstRoom) return [`${firstPrefix}${cleaned}`];
  const words = cleaned.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  let room = firstRoom;
  let prefix = firstPrefix;
  for (const w of words) {
    const piece = cols(w) > room ? cutCols(w, room, more) : w;
    if (!cur) {
      cur = piece;
    } else if (cols(cur) + 1 + cols(piece) <= room) {
      cur = `${cur} ${piece}`;
    } else {
      out.push(`${prefix}${cur}`);
      prefix = contPrefix;
      room = Math.max(8, width - contPrefixCols);
      cur = cols(w) > room ? cutCols(w, room, more) : w;
    }
  }
  if (cur) out.push(`${prefix}${cur}`);
  return out;
};

/** Renders the default `oa-bus status` screen within `screen.width` columns. */
export function renderStatusScreen(
  style: Style,
  screen: StatusScreen,
): string[] {
  const { width, now, busCmd } = screen;
  const p = (tone: Parameters<typeof paint>[1], s: string) =>
    paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  const sep = g("sep");
  const more = g("more");
  const lines: string[] = [];

  // 1. Verdict line
  const verdictPlain =
    screen.verdict === "working"
      ? `${g("live")} working`
      : screen.verdict === "degraded"
        ? `${g("degraded")} degraded`
        : `${g("cross")} down`;
  const verdictStyled =
    screen.verdict === "working"
      ? p("success", verdictPlain)
      : screen.verdict === "degraded"
        ? p("warning", verdictPlain)
        : p("danger", verdictPlain);
  const headLeft = `oa-bus ${cleanText(screen.version)} ${sep} `;
  const machine = screen.machine ? shortMachine(screen.machine) : "";
  if (machine) {
    const mid = ` ${sep} this `;
    const room = Math.max(
      4,
      width - cols(headLeft) - cols(verdictPlain) - cols(mid),
    );
    const mCut = cutCols(machine, room, more);
    lines.push(`${headLeft}${verdictStyled}${mid}${mCut}`);
  } else {
    lines.push(`${headLeft}${verdictStyled}`);
  }

  // 2. Instances
  if (screen.instances.length > 0) {
    const wide = width >= WIDE_COLS;
    const renderOne = (inst: InstanceView, maxCols: number): string => {
      const host = cleanText(inst.host);
      if (inst.ok) {
        const prefix = `${g("done")} `;
        const h = cutMiddle(host, Math.max(4, maxCols - cols(prefix)), more);
        return `${p("success", g("done"))} ${h}`;
      }
      const tag = ` (${inst.reason ?? "can't reach"})`;
      const prefix = `${g("cross")} `;
      const h = cutMiddle(
        host,
        Math.max(4, maxCols - cols(prefix) - cols(tag)),
        more,
      );
      return `${p("danger", g("cross"))} ${h}${p("muted", tag)}`;
    };
    const plainLen = (inst: InstanceView): number => {
      const host = cleanText(inst.host);
      if (inst.ok) return cols(`${g("done")} ${host}`);
      return cols(`${g("cross")} ${host} (${inst.reason ?? "can't reach"})`);
    };

    const totalWide =
      2 +
      screen.instances.reduce((sum, inst) => sum + plainLen(inst), 0) +
      Math.max(0, screen.instances.length - 1) * 4;
    if (wide && screen.instances.length > 1 && totalWide <= width) {
      lines.push(
        `  ${screen.instances.map((i) => renderOne(i, width)).join("    ")}`,
      );
    } else {
      for (const inst of screen.instances) {
        lines.push(`  ${renderOne(inst, width - 2)}`);
      }
    }
  }

  // 2b. Needs attention (#3328 S2) — only when something is wrong
  const attention = screen.attention ?? [];
  if (attention.length > 0) {
    lines.push("");
    lines.push(p("warning", `Needs attention (${attention.length})`));
    for (const item of attention) {
      lines.push(
        ...wrapWithPrefix(
          `  ${p("warning", "!")} `,
          4,
          "    ",
          4,
          item.problem,
          width,
          more,
        ),
      );
      lines.push(
        ...wrapWithPrefix(
          `    ${p("muted", "Fix:")} `,
          9,
          "    ",
          4,
          item.fix,
          width,
          more,
        ),
      );
    }
  }

  // 3. Agents + Other projects + More footer
  if (screen.project) {
    lines.push("");
    const allAgents = screen.project.agents;
    const hidden = allAgents.filter(isUnnamedHidden);
    const named = allAgents.filter((a) => !isUnnamedHidden(a));

    const metaParts = [
      `${named.length} named`,
      ...(hidden.length > 0 ? [`${hidden.length} unnamed hidden`] : []),
      "this project",
    ];
    const meta = metaParts.join(` ${sep} `);
    const agentsLead = "Agents  ";
    lines.push(
      `${bold(style, "Agents")}  ${p("muted", cutCols(meta, Math.max(4, width - cols(agentsLead)), more))}`,
    );

    const needsYou: StatusAgent[] = [];
    const working: StatusAgent[] = [];
    const idleOld: StatusAgent[] = [];
    for (const a of named) {
      const grp = classifyAgent(a, now);
      if (grp === "needs_you") needsYou.push(a);
      else if (grp === "working") working.push(a);
      else idleOld.push(a);
    }
    needsYou.sort(byRecent);
    working.sort(byRecent);
    idleOld.sort((a, b) => a.name.localeCompare(b.name));

    const showMachine = width >= WIDE_COLS;
    const shownWorking = working.slice(0, WORKING_CAP);
    const visibleRows = [...needsYou, ...shownWorking];
    const maxName = Math.max(
      0,
      ...visibleRows.map((a) => cols(cleanText(a.name))),
    );
    const nameW = showMachine ? Math.min(28, Math.max(20, maxName)) : 20;
    const appW = 8;
    const machineW = showMachine ? 12 : 0;
    const ageW = Math.max(
      3,
      ...visibleRows.map((a) => cols(shortAge(a.status_at, now))),
    );
    const statusW = Math.max(
      10,
      width - 2 - (nameW + 1) - appW - machineW - (ageW + 1),
    );

    const renderAgentRow = (a: StatusAgent): string => {
      const nameStr = padRight(cutCols(cleanText(a.name), nameW, more), nameW);
      const appStr = padRight(cutCols(shortApp(a.kind), appW - 1, more), appW);
      const machStr = showMachine
        ? padRight(
            cutCols(shortMachine(a.machine), machineW - 1, more),
            machineW,
          )
        : "";
      const label = a.status_label ? cleanText(a.status_label) : "";
      let statusStr = "";
      if (label) {
        const quoted = `"${label}"`;
        statusStr =
          cols(quoted) <= statusW
            ? quoted
            : `"${cutCols(label, Math.max(1, statusW - 2), more)}"`;
      } else if (a.status) {
        statusStr = cutCols(a.status.replace(/_/g, " "), statusW, more);
      }
      const age = shortAge(a.status_at, now);
      const left = `  ${bold(style, nameStr)} ${p("muted", appStr)}${showMachine ? p("muted", machStr) : ""}`;
      if (!age) return `${left}${statusStr}`.trimEnd();
      return `${left}${padRight(statusStr, statusW)} ${p("muted", age.padStart(ageW))}`;
    };

    if (needsYou.length > 0) {
      lines.push(p("warning", "NEEDS YOU"));
      for (const a of needsYou) lines.push(renderAgentRow(a));
    }
    if (working.length > 0) {
      lines.push(p("success", "WORKING"));
      for (const a of shownWorking) lines.push(renderAgentRow(a));
      if (working.length > WORKING_CAP) {
        const rest = working.length - WORKING_CAP;
        const overflow = `  ${more} ${rest} more working  (${busCmd} status --agents)`;
        lines.push(p("muted", cutCols(overflow, width, more)));
      }
    }
    if (idleOld.length > 0) {
      const head = `IDLE OVER A DAY (${idleOld.length})  `;
      const names = idleOld.map((a) => cleanText(a.name)).join(", ");
      lines.push(
        p(
          "muted",
          `${head}${cutCols(names, Math.max(4, width - cols(head)), more)}`,
        ),
      );
    }

    if (screen.project.others.length > 0) {
      const list = screen.project.others
        .map((o) => `${shortNamespace(o.namespace)} (${o.count})`)
        .join(", ");
      lines.push(p("muted", cutCols(`Other projects: ${list}`, width, more)));
    }

    lines.push("");
    const flags = `--agents ${sep} --messages ${sep} --instances ${sep} --json`;
    const page = screen.agentsPageUrl ? cleanText(screen.agentsPageUrl) : "";
    if (page) {
      const onePlain = `More: ${flags}   or ${page}`;
      if (cols(onePlain) <= width) {
        lines.push(`${p("muted", `More: ${flags}   or `)}${p("accent", page)}`);
      } else {
        lines.push(p("muted", cutCols(`More: ${flags}`, width, more)));
        lines.push(
          `      ${p("accent", cutMiddle(page, Math.max(10, width - 6), more))}`,
        );
      }
    } else {
      lines.push(p("muted", cutCols(`More: ${flags}`, width, more)));
    }
  }

  return lines;
}
