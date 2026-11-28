import { displayKind, stripTerminalControls } from "@oa/bus-ipc";
import type { Ctx } from "../context.ts";
import { ago, cols, cutCols, cutMiddle } from "../copy.ts";
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
  waiting?:
    | {
        kind: "permission";
        label?: string | undefined;
        since: string;
      }
    | undefined;
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
  if (a.waiting?.kind === "permission") return false;
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
  if (
    a.waiting?.kind === "permission" ||
    a.status === "waiting_on_owner" ||
    a.status === "blocked"
  )
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

const ageTimestamp = (a: StatusAgent): string | undefined =>
  a.waiting?.kind === "permission" ? a.waiting.since : a.status_at;

const byRecent = (a: StatusAgent, b: StatusAgent): number => {
  const ta = ageTimestamp(a)
    ? Date.parse(ageTimestamp(a) as string)
    : -Infinity;
  const tb = ageTimestamp(b)
    ? Date.parse(ageTimestamp(b) as string)
    : -Infinity;
  const va = Number.isFinite(ta) ? ta : -Infinity;
  const vb = Number.isFinite(tb) ? tb : -Infinity;
  if (va !== vb) return vb - va;
  return a.name.localeCompare(b.name);
};

/** #3363: permission waits rank above self-reported waiting_on_owner / blocked. */
const byNeedsYou = (a: StatusAgent, b: StatusAgent): number => {
  const aw = a.waiting?.kind === "permission" ? 0 : 1;
  const bw = b.waiting?.kind === "permission" ? 0 : 1;
  if (aw !== bw) return aw - bw;
  return byRecent(a, b);
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
    needsYou.sort(byNeedsYou);
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
      ...visibleRows.map((a) => cols(shortAge(ageTimestamp(a), now))),
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
      if (a.waiting?.kind === "permission") {
        const wLabel = a.waiting.label ? cleanText(a.waiting.label) : "";
        const text = wLabel
          ? `Waiting for your OK (${wLabel})`
          : "Waiting for your OK";
        statusStr = cutCols(text, statusW, more);
      } else if (label) {
        const quoted = `"${label}"`;
        statusStr =
          cols(quoted) <= statusW
            ? quoted
            : `"${cutCols(label, Math.max(1, statusW - 2), more)}"`;
      } else if (a.status) {
        statusStr = cutCols(a.status.replace(/_/g, " "), statusW, more);
      }
      const age = shortAge(ageTimestamp(a), now);
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

export type StatusNamespaceBlock = {
  namespace: string;
  current: boolean;
  agents: StatusAgent[];
};

/** `--agents`: all agents across projects, aligned like S1 with full untruncated status text (#3328 S3). */
export function renderAgentsDetail(
  style: Style,
  blocks: StatusNamespaceBlock[],
  now: number,
  width = 120,
): string[] {
  const p = (tone: Parameters<typeof paint>[1], s: string) =>
    paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  const sep = g("sep");
  const more = g("more");
  if (blocks.length === 0 || blocks.every((b) => b.agents.length === 0)) {
    return [p("muted", "No agents on the bus.")];
  }
  const allAgents = blocks.flatMap((b) => b.agents);
  const maxName = Math.max(0, ...allAgents.map((a) => cols(cleanText(a.name))));
  const nameW = Math.min(28, Math.max(20, maxName));
  const appW = 8;
  const machineW = 12;
  const ageW = Math.max(
    3,
    ...allAgents.map((a) => cols(shortAge(ageTimestamp(a), now))),
  );
  const minStatusW = Math.max(
    40,
    width - 2 - (nameW + 1) - appW - machineW - (ageW + 1),
  );

  const lines: string[] = [];
  for (const block of blocks) {
    if (block.agents.length === 0) continue;
    if (lines.length > 0) lines.push("");
    const tag = block.current
      ? "this project"
      : shortNamespace(block.namespace);
    lines.push(
      `${bold(style, "Agents")}  ${p("muted", `${block.agents.length} total ${sep} ${tag} (${cleanText(block.namespace)})`)}`,
    );
    const needsYou: StatusAgent[] = [];
    const working: StatusAgent[] = [];
    const idle: StatusAgent[] = [];
    for (const a of block.agents) {
      const grp = classifyAgent(a, now);
      if (grp === "needs_you") needsYou.push(a);
      else if (grp === "working") working.push(a);
      else idle.push(a);
    }
    needsYou.sort(byNeedsYou);
    working.sort(byRecent);
    idle.sort((a, b) => a.name.localeCompare(b.name));

    const emitGroup = (
      title: string,
      tone: Parameters<typeof paint>[1],
      list: StatusAgent[],
    ) => {
      if (list.length === 0) return;
      lines.push(p(tone, title));
      for (const a of list) {
        const nameStr = padRight(
          cutCols(cleanText(a.name), nameW, more),
          nameW,
        );
        const appStr = padRight(
          cutCols(shortApp(a.kind), appW - 1, more),
          appW,
        );
        const machStr = padRight(
          cutCols(shortMachine(a.machine), machineW - 1, more),
          machineW,
        );
        const label = a.status_label ? cleanText(a.status_label) : "";
        let statusStr = "";
        if (a.waiting?.kind === "permission") {
          const wLabel = a.waiting.label ? cleanText(a.waiting.label) : "";
          statusStr = wLabel
            ? `Waiting for your OK (${wLabel})`
            : "Waiting for your OK";
        } else if (label) {
          statusStr = `"${label}"`;
        } else if (a.status) {
          statusStr = a.status.replace(/_/g, " ");
        }
        const age = shortAge(ageTimestamp(a), now);
        const left = `  ${bold(style, nameStr)} ${p("muted", appStr)}${p("muted", machStr)}`;
        if (!age) {
          lines.push(`${left}${statusStr}`.trimEnd());
        } else {
          const statusPadded =
            cols(statusStr) < minStatusW
              ? padRight(statusStr, minStatusW)
              : statusStr;
          lines.push(
            `${left}${statusPadded} ${p("muted", age.padStart(ageW))}`,
          );
        }
      }
    };
    emitGroup("NEEDS YOU", "warning", needsYou);
    emitGroup("WORKING", "success", working);
    emitGroup("IDLE", "muted", idle);
  }
  return lines;
}

export type LateMessageView = {
  from: string;
  to: string;
  excerpt?: string | undefined;
  at: number;
  delay_ms?: number | undefined;
};

const shortDelay = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
};

/** `--messages`: today's late deliveries, newest first (#3328 S3). */
export function renderMessagesDetail(
  style: Style,
  messages: LateMessageView[],
  now: number,
): string[] {
  const p = (tone: Parameters<typeof paint>[1], s: string) =>
    paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  if (messages.length === 0) return [p("muted", "No late messages.")];
  const sorted = [...messages].sort((a, b) => b.at - a.at);
  const lines: string[] = [
    `${bold(style, "Late messages")}  ${p("muted", `${sorted.length} ${sorted.length === 1 ? "message" : "messages"}`)}`,
  ];
  for (const m of sorted) {
    const when = ago(m.at, now);
    const delay =
      m.delay_ms !== undefined ? ` (${shortDelay(m.delay_ms)} delay)` : "";
    lines.push(
      `  ${cleanText(m.from)} ${g("step")} ${cleanText(m.to)}  ${p("muted", `${when}${delay}`)}`,
    );
    if (m.excerpt) {
      lines.push(`    "${cleanText(m.excerpt)}"`);
    }
  }
  return lines;
}

export type InstanceDetailRow = {
  name: string;
  url: string;
  main: boolean;
  connected: boolean;
  revoked: boolean;
  agents: number;
  guests: string[];
};

/** `--instances`: configured instances and folder mappings (#3328 S3). */
export function renderInstancesDetail(
  style: Style,
  instances: InstanceDetailRow[],
  folders: [string, string][],
): string[] {
  const p = (tone: Parameters<typeof paint>[1], s: string) =>
    paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  const lines: string[] = [bold(style, "Instances")];
  for (const i of instances) {
    const badge = i.revoked
      ? p("danger", `${g("cross")} revoked`)
      : i.connected
        ? p("success", `${g("done")} connected`)
        : p("danger", `${g("cross")} not connected`);
    const count = `${i.agents} ${i.agents === 1 ? "agent" : "agents"}`;
    lines.push(
      `  ${bold(style, cleanText(i.name))}${i.main ? p("muted", " (main)") : ""}  ${cleanText(i.url)}  ${badge}  ${p("muted", count)}`,
    );
    for (const guest of i.guests) {
      lines.push(`    ${p("muted", `guest session: ${cleanText(guest)}`)}`);
    }
  }
  if (folders.length > 0) {
    lines.push("", bold(style, "Folders"));
    for (const [dir, inst] of folders) {
      lines.push(`  ${cleanText(dir)} ${g("step")} ${cleanText(inst)}`);
    }
  }
  return lines;
}

export type LinkSessionView = {
  name: string;
  cwd: string;
  state: string;
  cause?: string | undefined;
};

/** `--links`: live Claude sessions and whether each is linked (#3328 S3). */
export function renderLinksDetail(
  style: Style,
  sessions: LinkSessionView[],
): string[] {
  const p = (tone: Parameters<typeof paint>[1], s: string) =>
    paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  if (sessions.length === 0) return [p("muted", "No live Claude sessions.")];
  const lines: string[] = [bold(style, "Session links")];
  let hasUnlinked = false;
  for (const s of sessions) {
    const isLinked = s.state === "linked";
    const isStarting = s.state === "starting";
    if (!isLinked && !isStarting) hasUnlinked = true;
    const badge = isLinked
      ? p("success", `${g("done")} linked`)
      : isStarting
        ? p("muted", `${g("queued")} starting`)
        : p("danger", `${g("cross")} unlinked`);
    const cause = s.cause ? p("muted", ` (${cleanText(s.cause)})`) : "";
    lines.push(
      `  ${badge}  ${bold(style, cleanText(s.name))}  ${p("muted", cleanText(s.cwd))}${cause}`,
    );
  }
  if (hasUnlinked) {
    lines.push("", `  ${p("muted", "Fix:")} run /mcp in any unlinked session`);
  }
  return lines;
}
