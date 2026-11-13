import { displayKind, type StatusFields, statusSaysText } from "@oa/bus-ipc";
import { type AgentKind, BUS_CMD, BUS_ROUTES } from "@oa/bus-protocol";
import type { Isolation } from "./context.ts";
import { box, glyph, paint, type Style, type Tone } from "./term.ts";

/**
 * Every line the CLI prints: design/cli/transcript.md states 1 to 10,
 * verbatim. The few lines it does not name are marked DRAFT. Change wording
 * here; the logic never holds copy.
 */

export const WIDTH = 80;
const MIN = 10 * 60_000;

export type HarnessName =
  | "claude"
  | "opencode"
  | "pi"
  | "omp"
  | "codex"
  | "hermes"
  | "openclaw";
export const HARNESS_LABEL: Record<HarnessName, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "oh-my-pi",
  codex: "Codex",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};
/** The dashboard's labels for AGENT_KINDS. */
export const KIND_LABEL: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "oh-my-pi",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  codex: "Codex",
};
/** A known kind's label; any other kind shows as its own token (C26h). */
export const kindLabel = (kind: string): string =>
  Object.hasOwn(KIND_LABEL, kind)
    ? KIND_LABEL[kind as AgentKind]
    : displayKind(kind);

export type RosterAgent = StatusFields & {
  name: string;
  kind: string;
  machine: string;
  state: "live" | "queued";
};

const sourceText = (source: "config" | "git" | "dir" | "cwd") =>
  source === "config"
    ? "an approved .oa-bus.json"
    : source === "git"
      ? "the git remote"
      : source === "dir"
        ? "the git folder's name"
        : "the folder's name";

const len = (s: string) => [...s].length;

/**
 * Cuts the middle out of `value` so it is at most `max` long. The end is
 * kept whole when it fits in half: the last path segment (the repo name) or
 * the last two host labels (the domain).
 */
export function cutMiddle(value: string, max: number, more = "…"): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  const keep = Math.max(0, max - len(more));
  const slash = value.lastIndexOf("/");
  const dot = value.lastIndexOf(".", value.lastIndexOf(".") - 1);
  const end =
    slash >= 0 ? value.slice(slash) : dot >= 0 ? value.slice(dot) : "";
  const tail =
    len(end) > 0 && len(end) <= keep / 2 ? len(end) : Math.ceil(keep / 2);
  return (
    chars.slice(0, keep - tail).join("") +
    more +
    chars.slice(chars.length - tail).join("")
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** East Asian Wide and Fullwidth ranges: two columns each. */
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
/** Marks, joiners and variation selectors: no column of their own. */
const ZERO = /^(?:\p{M}|\p{Cf}|[\ufe00-\ufe0f])*$/u;

/** How many terminal columns one grapheme takes: 0, 1 or 2. */
const graphemeCols = (g: string): number =>
  ZERO.test(g)
    ? 0
    : /\p{Extended_Pictographic}/u.test(g) || WIDE.test(g)
      ? 2
      : 1;

/** How many terminal columns `s` takes: wide CJK and emoji count 2. */
export const cols = (s: string): number => {
  let n = 0;
  for (const { segment } of graphemes.segment(s)) n += graphemeCols(segment);
  return n;
};

/**
 * `value` cut at its end so it takes at most `max` columns, `more` included
 * when cut; never half a grapheme.
 */
export function cutCols(value: string, max: number, more = "…"): string {
  if (cols(value) <= max) return value;
  const room = max - cols(more);
  let out = "";
  let n = 0;
  for (const { segment } of graphemes.segment(value)) {
    const w = graphemeCols(segment);
    if (n + w > room) break;
    out += segment;
    n += w;
  }
  return out + more;
}

/** A roster cell: cut to width minus 2 columns plus "…", then padded, so columns keep a space. */
export function cell(value: string, width: number, more = "…"): string {
  const v = cols(value) > width - 2 ? cutCols(value, width - 1, more) : value;
  return v + " ".repeat(Math.max(0, width - cols(v)));
}

/** `oa_machine_…7f3a`: never more of a token than its prefix and 4 characters. */
export const tokenTail = (token: string, more = "…") =>
  `oa_machine_${more}${token.slice(-4)}`;

/** Whole minutes since `at`, rounded down. */
const minutesSince = (at: number, now: number) =>
  Math.floor((now - at) / 60_000);

/** "now", "2 min ago", "3 h ago" (Design): whole units, rounded down. */
export function ago(at: number, now: number): string {
  const mins = minutesSince(at, now);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

/** "for 2 min", "for 1 h" (Design): whole units, rounded down; nothing under 1 min. */
export function forHowLong(since: number, now: number): string | undefined {
  const mins = minutesSince(since, now);
  if (mins < 1) return undefined;
  return mins < 60 ? `for ${mins} min` : `for ${Math.floor(mins / 60)} h`;
}

export type HubLink = {
  state: "connected" | "reconnecting" | "connecting";
  /** `forHowLong`'s answer, for a link that dropped. */
  for?: string | undefined;
};

const listing = (names: string[], last: "and" | "or") =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;

export function copy(style: Style, bus: string = BUS_CMD) {
  const p = (tone: Tone, s: string) => paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  const more = g("more");
  const done = (s: string, meta?: string) =>
    `${p("success", g("done"))}  ${s}${meta ? `  ${p("muted", meta)}` : ""}`;
  const warn = (s: string) => `${p("warning", g("retry"))}  ${s}`;
  const fail = (s: string) => `${p("danger", g("fail"))}  ${s}`;
  const step = (s: string) => `${g("step")}  ${s}`;
  const next = (s: string) => `   ${s}`;
  /** Cuts `value` so the whole line, glyph and meta included, fits in 80. */
  const clip = (value: string, rest: number) =>
    cutMiddle(value, WIDTH - rest, more);
  const b = box(style);

  const all = {
    header: (version: string) => `oa-bus ${version}`,

    // 1. First run
    opening: () => step("Opening your browser to approve this machine"),
    ifNotOpened: (url: string) =>
      next(`If it did not open: ${p("accent", url)}`),
    noBrowser: () => step("No browser found. Open this URL on any machine:"),
    openThisUrl: () => step("Open this URL on any machine:"),
    url: (url: string) => next(p("accent", url)),
    codeBox: (code: string) => {
      const rule = b.h.repeat(len(code) + 4);
      return [
        next(p("hairline", `${b.tl}${rule}${b.tr}`)),
        next(
          `${p("hairline", b.v)}  ${p("accent", code)}  ${p("hairline", b.v)}  Your code. Type it on the approval page.`,
        ),
        next(
          `${p("hairline", `${b.bl}${rule}${b.br}`)}  ${p("muted", "Valid 10 minutes.")}`,
        ),
      ];
    },
    waiting: (frame: string, leftMs: number, failing: boolean) => {
      const s = Math.max(0, Math.floor(Math.min(leftMs, MIN) / 1000));
      const left = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
      return `${p("warning", frame)}  Waiting for approval  ${p("muted", left)}${
        failing ? `  ${p("warning", "hub unreachable, retrying")}` : ""
      }`;
    },
    waitingPlain: () => `Waiting for approval (up to 10 minutes)${more}`,
    approved: (label: string) => done(`Approved as ${clip(label, 15)}`),
    tokenSaved: (path: string, token: string) =>
      done(`Token saved to ${path}`, tokenTail(token, more)),
    /**
     * After approval: the instance, and its /bus page, where this machine is
     * revoked and share notices are picked. One line when it fits in 80.
     */
    connected: (origin: string) => {
      const page = `${origin}${BUS_ROUTES.page}`;
      const one = `Connected to ${origin}. Manage machines: ${page}`;
      if (len(one) + 3 <= WIDTH) return [done(one)];
      return [
        done(`Connected to ${clip(origin, 17)}.`),
        next(`Manage machines: ${clip(page, 20)}`),
      ];
    },
    // `login` saved a new token; the running daemon keeps the old one.
    daemonOldToken: (pid: number) => [
      warn(`The daemon (pid ${pid}) still uses the old token.`),
      next(`Run ${bus} install to restart it with the new one.`),
    ],
    alreadyConnected: (label: string) =>
      done(`Already connected as ${clip(label, 24)}`),

    configured: (names: HarnessName[]) =>
      done(
        `Configured ${listing(
          names.map((h) => HARNESS_LABEL[h]),
          "and",
        )}`,
      ),
    noHarness: () => [
      warn(
        "No Claude Code, OpenCode, Pi, oh-my-pi, Codex, Hermes or OpenClaw found",
      ),
      next(`Install one, then run ${bus} again.`),
    ],
    restarted: () => done("Restarted the OpenCode service to load the plugin"),
    // Run from inside OpenCode, where a restart would end the session running this.
    opencodeRestartYourself: (isolated = false) => [
      warn(
        isolated
          ? "OpenCode was not restarted: this install is not on your account's home"
          : "OpenCode was not restarted: this ran inside an OpenCode session",
      ),
      next(
        isolated
          ? "To load the plugin, run on your account: opencode service restart"
          : "Outside OpenCode, in a terminal, run: opencode service restart",
      ),
    ],
    // After the configured line, when PI_CODING_AGENT_DIR points both at one folder.
    sharedPiFile: () =>
      next(
        p(
          "muted",
          "Pi and oh-my-pi share one extension folder, so one file serves both.",
        ),
      ),
    // After the configured line, when Codex has no binary to wake with (C26e).
    codexNoWake: () => [
      warn(
        "No codex binary found, so the bus can't wake an idle Codex thread.",
      ),
      next(`Install the Codex CLI, then run ${bus} again.`),
    ],
    // After the configured line, when the Hermes plugin was copied and enabled.
    hermesRestart: () =>
      next("Restart running Hermes sessions and gateways to load the plugin."),
    // After uninstall removed the Hermes plugin folder with no hermes binary to disable it.
    hermesNoCli: (config: string) => [
      warn("Hermes isn't on PATH, so oa-bus may still be enabled in Hermes."),
      next(
        `Run hermes plugins disable oa-bus, or remove oa-bus from plugins.enabled in ${config}.`,
      ),
    ],
    // After the configured line, when the OpenClaw plugin was installed and enabled.
    openclawRestart: () => [
      next("Run openclaw gateway restart to load the plugin."),
    ],
    // After the configured line, when OpenClaw is in Nix mode: plugin commands are off there.
    openclawNix: () => [
      warn("OpenClaw is in Nix mode, so oa-bus didn't change it."),
      next("Add the oa-bus plugin through your Nix setup instead."),
    ],
    // After uninstall removed the OpenClaw plugin folder with no openclaw binary to uninstall it.
    openclawNoCli: () => [
      warn(
        "Removed the oa-bus plugin files, but OpenClaw isn't on PATH, so its config may still enable oa-bus.",
      ),
      next(
        "Once openclaw is on PATH again, run openclaw plugins uninstall oa-bus.",
      ),
    ],
    // Doctor, and status when the plugin is installed. Static: nothing in OpenClaw's config is read.
    openclawDmNote: () => [
      "OpenClaw: by default (dmScope), everyone who sends it a direct message",
      "shares one session, and that session is one bus address. If people other",
      "than you can message it, set a per-peer dmScope and keep dmPolicy on",
      "pairing or an allowlist.",
    ],
    opencodeNotRunning: () =>
      done("OpenCode service not running; it loads the plugin when it starts"),
    daemonRunning: (
      pid: number,
      service?: "launchd" | "systemd",
      fallback?: boolean,
    ) =>
      fallback && !service
        ? // The service manager cannot run it: install again won't help.
          [
            warn(
              "Daemon running without a service, so it won't restart after a reboot.",
            ),
            next(`After a reboot, start it again with ${bus} daemon.`),
          ]
        : service
          ? [
              done(
                service === "launchd"
                  ? "Daemon running as a launchd service"
                  : "Daemon running as a systemd user service",
                `pid ${pid}`,
              ),
            ]
          : // Running in a terminal: nothing brings it back after a reboot.
            [
              warn(
                "Daemon running, but no service will restart it after a reboot.",
              ),
              next(`Run ${bus} install.`),
            ],
    // install --no-service: the service step is skipped, nothing is started.
    // install: the bus then runs as a plain daemon (daemonRunning says so).
    serviceOtherHome: (why: Isolation, removing = false, plain = false) => [
      warn(
        `Skipped ${removing ? "removing " : ""}the background service: ${
          why === "home"
            ? "this HOME isn't your account's home"
            : why === "bus-home"
              ? "the bus home is outside your account's home"
              : "XDG_CONFIG_HOME is outside your account's home"
        }.${removing ? "" : plain ? " It never gets a background service there, so the bus runs as a plain daemon." : " Use --no-service to skip it on purpose."}`,
      ),
    ],
    serviceSkipped: () => [
      warn("Skipped the service, so no daemon is running."),
      next(`Start it with ${bus} daemon, and again after a reboot.`),
    ],
    // doctor, after the daemon line.
    serviceNodeMissing: (node: string) => [
      fail(`The service runs a Node that is gone: ${clip(node, 42)}.`),
      next(`Run ${bus} install to point it at your current Node.`),
    ],
    // doctor, after the service-node line.
    badNode: (node: string, reason: string) => [
      fail(`The service runs a Node that cannot start: ${clip(node, 42)}.`),
      `   ${reason}`,
      next(`Run ${bus} install again with a working Node first on your PATH.`),
    ],
    lingerOff: () => [
      warn("The daemon stops when you log out (systemd lingering is off)."),
      next("Run loginctl enable-linger $USER to keep it running."),
    ],
    daemonInTheWay: (socket: string, pid: number) => {
      const head = `Another daemon is still running (pid ${pid}) on `;
      return [
        fail(`${head}${clip(socket, 3 + len(head) + 1)}.`),
        next(`Stop it with kill ${pid}, then run ${bus} install again.`),
      ];
    },
    daemonStillRunning: (pid: number) => [
      warn(`The daemon is still running (pid ${pid}).`),
      next(`Stop it with kill ${pid}.`),
    ],
    // Status and doctor, when the hub runs a newer release (C26h). Each
    // version is cut to 19, so the line stays within 80 columns.
    updateAvailable: (hub: string, mine: string) => [
      warn(
        `Update available: ${cutMiddle(hub, 19, more)} (this machine runs ${cutMiddle(mine, 19, more)})`,
      ),
      next(`Run ${BUS_CMD}@latest install.`),
    ],
    // Status and doctor, when the hub's `/healthz` names a problem (#294).
    hubProblem: (problem: string) => [
      fail(`The instance reports a problem: ${displayKind(problem)}`),
      next("Ask the instance's admin to check it."),
    ],
    daemonTimeout: () => [
      fail("The daemon did not start within 10 seconds."),
      next(`Run ${bus} doctor to see why.`),
    ],

    rosterHeader: (namespace: string, live: number, queued: number) => {
      const n = live + queued;
      const meta = queued
        ? `${live} live ${g("sep")} ${queued} queued`
        : `${live} live`;
      const lead = `${n} agent${n === 1 ? "" : "s"} in namespace `;
      return `${lead}${p("accent", clip(namespace, len(lead) + 2 + len(meta)))}  ${p("muted", meta)}`;
    },
    /** #1570: where a namespace came from, under its header. */
    namespaceSource: (source: "config" | "git" | "dir" | "cwd") =>
      p("muted", `  namespace from ${sourceText(source)}`),
    rosterRow: (a: RosterAgent) =>
      `  ${cell(a.name, 20, more)}${cell(kindLabel(a.kind), 13, more)}${cell(a.machine, 22, more)}${
        a.state === "live"
          ? p("success", `${g("live")} live`)
          : p("warning", `${g("queued")} queued`)
      }`,
    /** The row's status, under it (AC5c): the agent's own report, cut to 80 columns. */
    rosterSays: (a: RosterAgent, now: number) => {
      const says = statusSaysText(a, now);
      if (says === undefined) return undefined;
      return `    ${p("muted", cutCols(says, WIDTH - 4, more))}`;
    },
    rosterMore: (n: number) =>
      `  ${p("muted", `and ${n} more ${g("sep")} ${bus} status`)}`,
    queuedFootnote: () => [
      p(
        "muted",
        "Mail to a queued agent waits up to 7 days for its machine to reconnect;",
      ),
      p("muted", "then the sender is told."),
    ],
    noAgents: (namespace: string) => {
      const lead = "No agents in namespace ";
      return [
        `${lead}${p("accent", clip(namespace, len(lead) + 5))} yet.`,
        "Start Claude Code, OpenCode, Pi, oh-my-pi, Codex, Hermes or OpenClaw",
        "in this folder. It joins.",
      ];
    },
    // 7. status: messages delivered after send_message stopped waiting.
    lateHeader: (n: number) =>
      `${n} message${n === 1 ? "" : "s"} delivered late  ${p("muted", "last hour")}`,
    /** Both names are cut in the middle, the longer first, so the row fits in 80. */
    lateRow: (from: string, to: string, when: string) => {
      const room = WIDTH - len(`  ${" to "}  ${when}`);
      let [f, t] = [from, to];
      if (len(f) + len(t) > room) {
        const half = Math.floor(room / 2);
        if (len(f) <= half) t = cutMiddle(t, room - len(f), more);
        else if (len(t) <= room - half) f = cutMiddle(f, room - len(t), more);
        else
          [f, t] = [cutMiddle(f, half, more), cutMiddle(t, room - half, more)];
      }
      return `  ${f} to ${t}  ${p("muted", when)}`;
    },
    lateQuote: (excerpt: string) => `    "${excerpt}"`,

    statusHint: () =>
      p("muted", `Check this machine anytime with ${bus} status.`),

    // 3, 4, 6
    denied: () => [
      fail("This machine was not approved."),
      next(`Run ${bus} again to get a new code.`),
    ],
    expired: (code: string) => [
      fail(`Code ${code} expired after 10 minutes.`),
      next(`Run ${bus} again to get a new code.`),
    ],
    unreachable: (
      host: string,
      waitS: number,
      attempt: number,
      total: number,
    ) => [
      warn(`Couldn't reach ${clip(host, 18)}`),
      next(
        p(
          "muted",
          `Retrying in ${waitS} s${more} attempt ${attempt} of ${total}`,
        ),
      ),
    ],
    unreachableFinal: (host: string, attempts: number, error: string) => {
      const tail = `after ${attempts} attempts.`;
      return [
        `${fail(`Couldn't reach ${clip(host, 21 + len(tail) + len(error))} ${tail}`)}  ${p("muted", error)}`,
        next("Check your network or the --instance URL, then try again."),
      ];
    },

    // Not in the transcript (DRAFT until Design names them).
    /** Any failure the transcript does not name. */
    failed: (message: string) => [
      fail(clip(message.split("\n")[0] ?? "", 3)),
      next(`Run ${bus} doctor to see why.`),
    ],
    // A SOCKET_PATH start failure, in place of `failed`.
    socketPathFailed: (message: string) => [
      fail("The daemon cannot listen on its socket."),
      next(p("muted", clip(message.split("\n")[0] ?? "", 3))),
      next(`Run ${bus} doctor to see why.`),
    ],
    usage: (message: string) => [
      // The parser's message, as a sentence.
      fail(clip(message.charAt(0).toUpperCase() + message.slice(1), 3)),
      next(`Run ${bus} with install, login, daemon, status, logs,`),
      next(
        "doctor, global add|rm|list, uninstall, mcp <claude|opencode|pi|codex>",
      ),
      next("or version."),
      next(`Run ${bus} --help to list every command and flag.`),
    ],
    help: () => [
      `usage: ${bus} [command] [flags]`,
      "",
      "Commands",
      "  install      Approve this machine, wire your harnesses, start the daemon (the default)",
      "  login        Approve this machine again",
      "  uninstall    Remove what install added",
      "  status       Who is on the bus, from this folder",
      "  logs         The daemon log",
      "  doctor       Check the install and say what to fix",
      "  daemon       Run the daemon in this terminal",
      "  global       add <dir>, rm <dir> or list: folders shared across namespaces",
      "  namespace    approve [dir], revoke <dir> or list",
      "  link         <dir> <dir> or list; unlink <dir> <dir>",
      "  leads        check [name]",
      "  mcp          <claude|opencode|codex|pi>: the MCP server a harness runs",
      "  version      Print the version",
      "  help         This text",
      "",
      "Flags",
      "  install      --instance <url>   the instance to connect to",
      "               --check            only report what is set up; change nothing",
      "               --habits | --no-habits | --show-habits",
      "                                  add, decline or show the always-on habit lines",
      "               --no-service       skip the launchd or systemd step",
      "               --no-open          do not open a browser for approval",
      "               --json             the result as one JSON line on stdout",
      "               --yes, -y          answer yes where install asks",
      "  login        --instance <url>, --no-open",
      "  daemon       --instance <url>",
      "  uninstall    --purge            also delete the bus home and what install made",
      "  namespace    --yes, -y          approve without asking (namespace approve)",
      "  every command: --home <dir> (bus home), --no-color, --help, -h, --version, -v",
    ],
    skipped: (h: HarnessName, reason: string) => [
      warn(
        `Skipped ${HARNESS_LABEL[h]}: ${clip(reason, 14 + len(HARNESS_LABEL[h]))}`,
      ),
      next(`Fix it, then run ${bus} again.`),
    ],
    noHub: () => [
      fail("No Open Artifacts instance to connect to."),
      next(`Run ${bus} --instance <your instance URL>,`),
      next("or set OA_BUS_INSTANCE."),
    ],
    hubMismatch: (approved: string, asked: string, askedUrl: string) => {
      // Both hosts share the line: each keeps at least 20 columns.
      const a = clip(approved, 39 + Math.min(len(asked), 20));
      const b = clip(asked, 39 + len(a));
      return [
        fail(`This machine is approved for ${a}, not ${b}.`),
        next(`Run ${bus} uninstall --purge first, then`),
        next(`${bus} --instance ${clip(askedUrl, 39)}.`),
      ];
    },
    checkOk: (label: string, details: string[] = []) => [
      done(label),
      ...details.map((d) => next(d)),
    ],
    checkFailed: (label: string, action: string, details: string[] = []) => [
      fail(label),
      ...details.map((d) => next(d)),
      next(action),
    ],
    // One harness under the harnesses line of `install --check`.
    checkHarness: (h: HarnessName, state: string) =>
      `${HARNESS_LABEL[h]}: ${state}`,
    noNamespace: () =>
      p(
        "muted",
        "This folder has no namespace, so there is no roster to show.",
      ),
    couldNotRemove: (h: HarnessName, reason: string) => [
      warn(
        `Could not remove the bus from ${HARNESS_LABEL[h]}: ${clip(reason, 37 + len(HARNESS_LABEL[h]))}`,
      ),
      next(`Fix it, then run ${bus} uninstall again.`),
    ],
    purgeLeftDir: (home: string) => [
      warn(
        `Left ${clip(home, 57)} in place: it holds files the bus did not create.`,
      ),
    ],
    purgeRefused: (home: string) => [
      fail(
        `${clip(home, 64)} does not look like a bus folder, so it was not deleted.`,
      ),
      next("Remove the bus files in it yourself, or unset OA_BUS_HOME."),
    ],
    purgeDaemonRunning: (home: string) => [
      fail(
        `The daemon is still running, so ${clip(home, 52)} was not deleted.`,
      ),
      next(`Wait a few seconds and run ${bus} uninstall --purge again.`),
      next(`If it keeps running, run ${bus} doctor to see why.`),
    ],

    // 7. status
    hubRow: (host: string, link?: HubLink) => {
      if (!link) return `Hub      ${clip(host, 9)}`;
      const word = `${link.state === "connected" ? g("live") : g("queued")} ${link.state}`;
      const tone = link.state === "connected" ? "success" : "warning";
      const dur = link.for ? `  ${p("muted", link.for)}` : "";
      return `Hub      ${clip(host, 9 + 2 + len(word) + (link.for ? 2 + len(link.for) : 0))}  ${p(tone, word)}${dur}`;
    },
    machineRow: (label: string) => `Machine  ${clip(label, 9)}`,
    statusDaemonDown: () => [
      fail("Daemon not running"),
      next(`Run ${bus} to restart it,`),
      next(`or ${bus} doctor to see why.`),
    ],
    statusDaemonStalled: () => [
      fail("Daemon not responding"),
      next(`It is running but not answering. Try again, or run ${bus} doctor.`),
    ],
    hubNotReachable: (
      host: string,
      error: string | undefined,
      again: string,
    ) => [
      `${fail(`Hub not reachable at ${clip(host, 26 + (error ? len(error) + 2 : 0))}`)}${
        error ? `  ${p("muted", error)}` : ""
      }`,
      next(`Check your network, then run ${bus} ${again} again.`),
    ],
    notRegistered: () => [
      fail("This computer is not connected to a bus."),
      next(`Run ${bus} to approve it.`),
    ],
    revoked: () => [
      fail("This machine was revoked."),
      next(`Run ${bus} install to approve it again.`),
    ],

    // 8. doctor
    nodeOk: (version: string) => done(`Node ${version}`),
    nodeOld: (version: string) => [
      fail(`Node ${clip(version, 39)} is too old (needs 22 or newer)`),
      next(`Install Node 22 or newer, then run ${bus} doctor again.`),
    ],
    credentials: (path: string, token: string) =>
      done(`Credentials at ${clip(path, 37)}`, tokenTail(token, more)),
    noCredentials: (path: string) => [
      fail(`No credentials at ${clip(path, 21)}`),
      next(`Run ${bus} to approve this machine.`),
    ],
    revokedCheck: () => [
      fail("This machine was revoked"),
      next(`Run ${bus} install to approve it again.`),
    ],
    // DRAFT: the short socket folder a long OA_BUS_HOME needs is not ours.
    socketFolderUnsafe: (dir: string, why: string) => [
      fail(`Daemon socket folder ${clip(dir, 33)} is unsafe`),
      next(`It ${why}. Remove it, then run ${bus}.`),
    ],
    // DRAFT: another user made it first; in sticky /tmp only an admin can remove it.
    socketFolderNotYours: (dir: string) => [
      fail(`Daemon socket folder ${clip(dir, 49)} belongs to another user`),
      next(`Ask an admin to remove it (sudo rm -r ${clip(dir, 43)}),`),
      next("or set a shorter OA_BUS_HOME."),
    ],
    // global.json is malformed or not safely ours; `why` completes "It …".
    globalUnusable: (path: string, why: string) => [
      warn(`${clip(path, 45)} can't be used, so no directory is global.`),
      next(p("muted", clip(`It ${why}.`, 3))),
      next(`Remove it, then run ${bus} global add <dir> again.`),
    ],
    /** doctor (#1570): the folder's namespace and where it comes from. */
    namespaceIs: (
      namespace: string,
      source: "config" | "git" | "dir" | "cwd",
    ) => `Namespace ${namespace} (from ${sourceText(source)})`,
    /** A refused or noted config file (#1527): the reason, then the exact fix. Paths arrive already shortened. */
    configFile: (f: {
      file: string;
      state: "refused" | "noted" | "pending";
      reason: string;
      fix: string;
      restart?: boolean;
    }) => [
      warn(
        f.state === "refused"
          ? `${f.file} ${f.reason}, so it is ignored.`
          : f.state === "pending"
            ? `${f.file} ${f.reason}, so its namespace is ignored.`
            : `${f.file} ${f.reason}; it is still used.`,
      ),
      next(`Fix: ${f.fix}`),
      ...(f.restart ? [next("Restart the session to pick up a fix.")] : []),
    ],
    globalAsked: () => [
      warn("This repo's .oa-bus.json asks for global, which is ignored here."),
      next(`Allow it with ${bus} global add .`),
    ],
    daemonNotRunning: () => [
      fail("Daemon is not running"),
      next(`Run ${bus} to restart it.`),
    ],
    daemonNotResponding: () => [
      fail("Daemon is not responding"),
      next(`Try again in a moment, or run ${bus} to restart it.`),
    ],
    hubReachable: (host: string) => done(`Hub reachable at ${clip(host, 20)}`),
    wired: (h: HarnessName, version?: string) =>
      done(
        version
          ? `${HARNESS_LABEL[h]} ${clip(version, 40)} wired`
          : `${HARNESS_LABEL[h]} wired`,
      ),
    notWired: (h: HarnessName) => [
      fail(`${HARNESS_LABEL[h]} is not wired`),
      next(`Run ${bus} to wire it.`),
    ],
    claudeAccepts: () =>
      done("Claude Code accepts messages from other machines"),
    claudeIsolates: (settings: string) => [
      warn("Claude Code ignores messages from other machines"),
      next(`Set isolatePeerMachines to false in ${clip(settings, 40)}.`),
    ],
    // Codex's checks, after its wiring line (C26e).
    codexWakes: (bin: string) => done(`Codex wakes with ${clip(bin, 20)}`),
    // The Claude Code plugins (#2095). Drafts for OA Product: wording is theirs.
    outputStyleOn: () => [
      done("Turned on the Artifacts Teammate output style"),
      next("Restart your Claude Code sessions to use it."),
    ],
    // `style` is undefined when the choice is not a style name (null, a number, "default").
    outputStyleKept: (style?: string) =>
      done(
        `Added the Artifacts Teammate output style. You're on ${style ?? "the default style"}; switch with /output-style.`,
      ),
    pluginsInstalled: () =>
      done(
        "Installed the Claude Code plugins: session shortcuts and output style",
      ),
    pluginsNoClaude: () => [
      warn("Claude Code isn't on PATH, so its plugins were skipped."),
      next(`Install Claude Code, then run ${bus} again.`),
    ],
    pluginsTooOld: (found: string | undefined, min: string) => [
      warn(
        `Claude Code ${found ?? "(unknown version)"} is too old for the plugins, so they were skipped.`,
      ),
      next(`Update to ${min} or newer, then run ${bus} again.`),
    ],
    pluginsForeignMarketplace: (name: string) => [
      warn(
        `A Claude Code marketplace named "${name}" already exists and isn't from Open Artifacts, so it was left alone and the plugins weren't installed.`,
      ),
      next(`Rename or remove that marketplace, then run ${bus} again.`),
    ],
    pluginsFailed: (what: string, why: string) => [
      warn(`Couldn't ${clip(what, 20)}: ${clip(why, 30)}.`),
      next(`The bus tools are set up. Run ${bus} again to retry the plugins.`),
    ],
    pluginsNoNamespace: (
      why: "timeout" | "none" | "error",
      fallback: string,
    ) => [
      warn(
        why === "timeout"
          ? `Claude Code didn't list your MCP servers in time, so the shortcuts assume your Open Artifacts tools are named "${fallback}".`
          : why === "error"
            ? `Couldn't ask Claude Code about your "${fallback}" MCP server, so the shortcuts assume your Open Artifacts tools are named "${fallback}".`
            : `Found no Claude Code MCP server for this instance, so the shortcuts assume it's named "${fallback}".`,
      ),
      next(
        "If they have another name, run: claude plugin configure open-artifacts-shortcuts",
      ),
    ],
    pluginsKeptSource: (ref?: string) => [
      warn(
        `Kept the Open Artifacts plugins on ${ref ?? "their default branch"}, as you set them.`,
      ),
    ],
    pluginsRolledBack: (state: "all" | "some" | "none", why: string) => [
      warn(
        state === "all"
          ? "Put the previous Open Artifacts plugin source back, so your plugins are as they were. Run the install again to retry the move."
          : state === "some"
            ? "Put the previous Open Artifacts plugin source back, but only some of the plugins came back. Run the install again to finish."
            : `Couldn't put the previous plugin source back either (${why}), so the Open Artifacts plugins are not installed. Run the install again.`,
      ),
    ],
    pluginsStyleCleared: () => [
      warn(
        "Turned the Artifacts Teammate output style off again, because its plugin is not installed. The install turns it back on.",
      ),
    ],
    pluginsLostOptions: (mcpServer: string) => [
      warn(
        `The shortcuts' saved server name "${mcpServer}" was lost with the removed plugins. Run: claude plugin configure open-artifacts-shortcuts and enter it again.`,
      ),
    ],
    pluginsAddUnknown: (why: string) => [
      warn(
        `Couldn't add the plugin source (${why}) and couldn't check what is installed, so nothing was changed back. Run the install again.`,
      ),
    ],
    pluginsBadInstance: () => [
      warn(
        "Couldn't read this instance's address, so the shortcuts don't know where your pages are yet.",
      ),
      next(
        "Run: claude plugin configure open-artifacts-shortcuts and enter your instance's URL.",
      ),
    ],
    pluginsUninstallNoClaude: (manual: string[]) => [
      warn(
        "Claude Code isn't on PATH, so its Open Artifacts plugins weren't removed.",
      ),
      next(`Once it is, run: ${manual.join("; ")}`),
    ],
    pluginsUninstallFailed: (what: string, why: string) => [
      warn(`Couldn't remove ${clip(what, 20)}: ${clip(why, 30)}.`),
      next(`Run ${bus} uninstall again to finish.`),
    ],
    // Doctor and status.
    pluginsDoctor: () =>
      done("Claude Code plugins installed: session shortcuts, output style"),
    pluginsDoctorMissing: (ids: string[]) => [
      fail(
        ids.length === 1
          ? `Claude Code plugin missing: ${ids[0]}.`
          : `Claude Code plugins missing: ${ids.join(", ")}.`,
      ),
      next(`Run ${bus} to install ${ids.length === 1 ? "it" : "them"}.`),
    ],
    pluginsDoctorUnconfigured: () => [
      warn("The session shortcuts plugin has no instance URL"),
      next(`Run ${bus} to set it.`),
    ],
    pluginsDoctorUnknown: () => [
      warn("Couldn't ask Claude Code about the Open Artifacts plugins."),
      next(
        `Check that \`claude plugin list\` runs, then run ${bus} doctor again.`,
      ),
    ],
    styleFileOld: (where: string) => [
      warn(
        `An older output style file (${clip(where, 20)}) also lists Artifacts Teammate, so it shows twice.`,
      ),
      next(`Run ${bus} to remove the old file.`),
    ],
    styleFileOldNoClaude: (where: string, min: string) => [
      warn(
        `An older output style file (${clip(where, 20)}) is still in use. ${bus} can't replace it until Claude Code ${min} or later is on PATH.`,
      ),
      next(`Install or update Claude Code, then run ${bus}.`),
    ],
    pluginsSetupFailed: (why: string) => [
      warn(`Couldn't set up the Claude Code plugins: ${clip(why, 30)}.`),
      next(`The bus tools are set up. Run ${bus} again to retry.`),
    ],
    pluginsRemoveFailed: (why: string) => [
      warn(`Couldn't remove the Claude Code plugins: ${clip(why, 30)}.`),
      next(`Run ${bus} uninstall again to finish.`),
    ],
    pluginsStatus: () =>
      done("Claude Code plugins: session shortcuts, output style"),
    // #1626: the `oa-bus` shim on PATH.
    shimInstalled: (where: string) =>
      done(`Installed the oa-bus command: ${clip(where, 30)}`),
    shimNotOnPath: (dir: string, hint: string) => [
      warn(
        `${clip(dir, 30)} is not on your PATH, so \`oa-bus\` won't run yet.`,
      ),
      next(`To fix it, add this line to your shell profile: ${hint}`),
    ],
    shimForeign: (where: string) => [
      warn(`Left ${clip(where, 30)} alone: it isn't from Open Artifacts.`),
      next(
        `Typing \`oa-bus\` runs that file, not this install. Remove it, or use \`${BUS_CMD}\`.`,
      ),
    ],
    shimOtherHome: (where: string, home: string) => [
      warn(
        `Left ${clip(where, 30)} alone: it belongs to the install in ${clip(home, 30)}.`,
      ),
      next(
        `Typing \`oa-bus\` runs that install, not this one. Use \`${BUS_CMD}\` for this one.`,
      ),
    ],
    shimRemoved: (where: string) =>
      done(`Removed the oa-bus command: ${clip(where, 30)}`),
    shimDoctorOk: (where: string) =>
      done(`oa-bus on your PATH runs this install (${clip(where, 30)})`),
    shimDoctorOffPath: (where: string, hint: string) => [
      warn(`oa-bus is not on your PATH (the command is in ${clip(where, 30)})`),
      next(`To fix it, add this line to your shell profile: ${hint}`),
    ],
    shimDoctorOther: (where: string) => [
      warn(`oa-bus on your PATH is not this install's (${clip(where, 30)})`),
      next(
        `Remove it, or put this install's first. Re-run ${BUS_CMD} install to refresh ours.`,
      ),
    ],
    shimDoctorMissing: () => [
      warn("oa-bus is not on your PATH"),
      next(`Run ${BUS_CMD} install to add it.`),
    ],
    codexSkill: (where: string) =>
      done(`Codex skill installed in ${clip(where, 20)}`),
    codexSkillTwice: (file: string, block: string) => [
      warn("The Codex skill is installed twice, so it loads twice"),
      next(
        `It's in both ${clip(file, 30)} and ${clip(block, 20)}. Run ${bus} install again to keep just one.`,
      ),
    ],
    codexSkillSharedTwice: () => [
      warn("The Codex skill is installed twice, so it loads twice"),
      next(
        "Codex shares its skills folder with pi and omp, so it also sees their copy.",
      ),
    ],
    codexNoWakeCheck: () => [
      warn("No codex binary found, so idle Codex threads are not woken"),
      next(`Install the Codex CLI, then run ${bus} install again.`),
    ],
    codexHomeMismatch: (shell: string, service: string) => {
      // Both paths share the line: the shell's keeps at least 15 columns.
      const a = clip(service, 49 + Math.min(len(shell), 15));
      const b = clip(shell, 49 + len(a));
      return [
        warn(`The daemon reads Codex from ${a}, this shell from ${b}`),
        next(`Run ${bus} install from this shell to match it.`),
      ];
    },
    codexFullAccess: (config: string) => [
      warn(
        "Codex runs with danger-full-access, so one thread can pose as another",
      ),
      next(`Set sandbox_mode to workspace-write in ${clip(config, 43)}.`),
    ],
    // writable_roots lets threads write CODEX_HOME; the covering entry may be a parent (~).
    codexWritableHome: (dir: string, config: string) => [
      warn(
        `Codex lets threads write ${clip(dir, 63)}, so one thread can pose as another`,
      ),
      next(
        `Remove the entry that covers it from writable_roots in ${clip(config, 59)}.`,
      ),
    ],
    opencodeTooOld: (version: string, min: string) => {
      const rest = ` is too old for the plugin (needs ${min} or newer)`;
      return [
        warn(`OpenCode ${clip(version, 12 + len(rest))}${rest}`),
        next(`Run opencode upgrade, then ${bus} install again.`),
      ];
    },
    // doctor: OpenCode's Open Artifacts entry runs oa-bus, and oa-bus is gone (#1856).
    opencodeProxyMissing: (name: string, program: string) => [
      fail(
        `OpenCode's ${name} entry runs ${clip(program, 60)}, which is missing.`,
      ),
      next(
        `Run ${bus} install again, or ${bus} uninstall to put your own entry back.`,
      ),
    ],
    // doctor: Codex's Open Artifacts entry runs oa-bus, and oa-bus is gone (#1856).
    codexProxyMissing: (name: string, program: string) => [
      fail(
        `Codex's ${name} entry runs ${clip(program, 60)}, which is missing.`,
      ),
      next(
        `Run ${bus} install again, or ${bus} uninstall to put your own entry back.`,
      ),
    ],
    opencodeUnknown: () => [
      warn("OpenCode version unknown"),
      next(`Run opencode --version to check it, then ${bus} install again.`),
    ],
    summary: (failed: number, warnings: number, passed: number) =>
      p(
        "muted",
        failed + warnings === 0
          ? `All ${passed} checks passed.`
          : `${[
              failed ? `${failed} failed` : "",
              warnings ? `${warnings} warning${warnings > 1 ? "s" : ""}` : "",
              passed ? `${passed} passed` : "",
            ]
              .filter(Boolean)
              .join(", ")}.`,
      ),

    // 9, 10. uninstall
    serviceRemoved: (kind: "launchd" | "systemd") =>
      done(
        kind === "launchd"
          ? "Stopped and removed the launchd service"
          : "Stopped and removed the systemd user service",
      ),
    noService: () => done("No service to remove"),
    daemonStopped: () => done("Stopped the daemon"),
    removedFrom: (names: HarnessName[]) =>
      done(
        `Removed the bus from ${listing(
          names.map((h) => HARNESS_LABEL[h]),
          "and",
        )}`,
      ),
    noneWired: () => done("No harness had the bus wired"),
    removedPluginFolder: () => done("Removed the OpenCode plugin folder"),
    restartedUnload: () =>
      done("Restarted the OpenCode service to unload the plugin"),
    opencodeNotRunningUnload: () =>
      done("OpenCode service not running; nothing to restart"),
    kept: (machineFile: string) => [
      `Kept ${clip(machineFile, 46)}. This machine stays approved on the bus;`,
      `run ${bus} to reconnect it.`,
      p("muted", `To remove everything, run ${bus} uninstall --purge.`),
    ],
    deleted: (home: string) =>
      done(`Deleted ${clip(home, 35)}, including machine.json`),
    stillListed: (label: string, origin: string) => [
      warn(`${clip(label, 30)} is still listed on the bus`),
      next("Revoke it on the machines page to remove it for good:"),
      next(clip(`${origin}/settings/machines`, 3)),
      next(`To use this computer again, run ${bus}.`),
    ],

    // 11. global
    globalAdded: (dir: string) => [
      done(
        `${clip(dir, 60)} is now global. Agents started there see every namespace.`,
      ),
      p("muted", "   Sessions already running there change when they restart."),
    ],
    globalAlready: (dir: string) => done(`${clip(dir, 22)} is already global.`),
    globalNotDir: (dir: string) => [
      fail(`${clip(dir, 23)} is not a directory.`),
      next(`Check the path, then run ${bus} global add again.`),
    ],
    globalRemoved: (dir: string) => [
      done(`${clip(dir, 24)} is no longer global.`),
      p("muted", "   Sessions already running there change when they restart."),
    ],
    globalNotListed: (dir: string) =>
      warn(`${clip(dir, 36)} was not global. Nothing changed.`),
    globalNone: () => [
      "No global directories.",
      p("muted", `Add one with ${bus} global add <dir>.`),
    ],
    globalList: (dirs: string[]) => [
      `${dirs.length} global ${dirs.length === 1 ? "directory" : "directories"}`,
      ...dirs.map((d) => `  ${clip(d, 2)}`),
    ],

    // 13. lead templates (#1328). DRAFT: not in the transcript yet.
    leadsNoHub: () => [
      fail("This machine has no instance to check briefs against."),
      next(`Run ${bus} install first.`),
    ],
    leadsFolderUnusable: (dir: string, why: string) => [
      fail(`${clip(dir, 40)} can't be used: ${why}.`),
    ],
    leadsNone: (dir: string) => [
      "No lead templates.",
      p("muted", clip(`Put <name>.json files in ${dir}.`, 3)),
    ],
    leadsNoSuch: (name: string, dir: string) => [
      fail(`No template named ${clip(name, 30)} in ${clip(dir, 40)}.`),
    ],
    leadsOk: (t: {
      name: string;
      harness: string;
      role: string;
      cap: string;
      hash: string;
    }) =>
      done(
        `${clip(t.name, 40)}  ${t.harness}, role ${clip(t.role, 30)}, cap ${t.cap}`,
        t.hash.slice(0, 12),
      ),
    leadsRefused: (name: string, why: string) =>
      fail(`${clip(name, 24)}: ${clip(why, 30)}`),
    leadsSummary: (ok: number, refused: number) =>
      `${ok} usable, ${refused} refused. Nothing was started or changed.`,

    // 12. namespace approvals (#1525)
    nsUnusable: (path: string, why: string) => [
      warn(`${clip(path, 45)} can't be used, so no namespace is approved.`),
      next(p("muted", clip(`It ${why}.`, 3))),
      next(`Remove it, then run ${bus} namespace approve <dir> again.`),
    ],
    nsNoFile: (dir: string) => [
      fail(`${clip(dir, 40)} has no .oa-bus.json.`),
      next("Check the path: approval is for the namespace that file sets."),
    ],
    nsFileUnusable: (file: string, why: string) => [
      fail(`${clip(file, 40)} can't be read: it ${why}.`),
    ],
    nsNoNamespace: (file: string) =>
      warn(`${clip(file, 40)} sets no namespace. Nothing to approve.`),
    nsNotDir: (dir: string) => [
      fail(`${clip(dir, 23)} is not a directory.`),
      next(`Check the path, then run ${bus} namespace approve again.`),
    ],
    nsAsk: (dir: string, namespace: string) => [
      `${dir} sets its namespace to ${namespace}.`,
      "Agents started there join it and can message everyone in it.",
    ],
    /** #1570: a git remote now derives another namespace than the folder first got. */
    nsAskRemote: (dir: string, namespace: string, recorded: string) => [
      `${dir} first got the namespace ${recorded}; its git remote now gives ${namespace}.`,
      "Agents started there join it and can message everyone in it.",
    ],
    nsPrompt: () => "Approve it? [y/N] ",
    nsNeedTty: (command: string) => [
      fail("Approving a namespace needs your user."),
      next(`Ask them to run this in a terminal: ${command}`),
    ],
    nsDeclined: () => warn("Not approved. Nothing changed."),
    nsAlready: (dir: string, namespace: string) =>
      done(`${clip(dir, 20)} is already approved for ${clip(namespace, 40)}.`),
    nsApproved: (dir: string, namespace: string) => [
      done(
        `${clip(dir, 20)} may now use the namespace ${clip(namespace, 40)}.`,
      ),
      p(
        "muted",
        "   Agents already running there keep their namespace until they restart.",
      ),
    ],
    nsRevoked: (dir: string) => [
      done(`${clip(dir, 24)} is no longer approved.`),
      p(
        "muted",
        "   Agents already running there keep their namespace until they restart.",
      ),
    ],
    nsNotListed: (dir: string) =>
      warn(`${clip(dir, 36)} was not approved. Nothing changed.`),
    nsNone: () => [
      "No approved namespaces.",
      p("muted", `Approve one with ${bus} namespace approve <dir>.`),
    ],
    nsList: (rows: { dir: string; namespace: string }[]) => [
      `${rows.length} approved ${rows.length === 1 ? "namespace" : "namespaces"}`,
      ...rows.map((r) => `  ${clip(r.dir, 2)}  ${p("muted", r.namespace)}`),
    ],

    // link, unlink (#1567)
    linkNotDir: (dir: string) => fail(`${clip(dir, 20)} is not a directory.`),
    linkSame: (a: string, b: string, namespace: string) => [
      fail(`${clip(a, 20)} and ${clip(b, 20)} are in the same namespace.`),
      next(
        `Both are ${clip(namespace, 12)}. A link joins two different namespaces.`,
      ),
    ],
    linkNeedLogin: () => [
      fail("This machine is not signed in to a hub."),
      next(`Run ${bus} login, then try again.`),
    ],
    linkUnauthorized: () => [
      fail("The hub did not accept this machine's token."),
      next(`Run ${bus} login, then try again.`),
    ],
    linkRefused: (reason: string | undefined) =>
      reason === "rate_limited"
        ? [
            fail("This machine asked for too many link changes."),
            next("Try again in an hour."),
          ]
        : reason === "proposal_limit"
          ? [
              fail("Too many link changes are waiting for you."),
              next("Confirm or let them expire, then try again."),
            ]
          : reason === "no_bus"
            ? [
                fail("The hub has no connected machine for you yet."),
                next(`Start the daemon with ${bus}, then try again.`),
              ]
            : [fail("The hub refused the request.")],
    linkBadReply: () => [
      fail("The hub's answer was not a confirm link for this instance."),
      next("Nothing was changed."),
    ],
    linkProposed: (
      action: "link" | "unlink",
      a: { dir: string; namespace: string },
      b: { dir: string; namespace: string },
      url: string,
    ) => [
      step(`${action === "link" ? "Link" : "Unlink"} these two namespaces`),
      next(`${clip(a.namespace, 8)}  ${p("muted", clip(a.dir, 12))}`),
      next(`${clip(b.namespace, 8)}  ${p("muted", clip(b.dir, 12))}`),
      "",
      next(p("accent", url)),
      next("Open this in your browser to confirm."),
      p(
        "muted",
        "   Nothing changes until you confirm. The link works once, for an hour.",
      ),
    ],
    linkList: (busUrl: string) => [
      "Links are managed on your bus page.",
      next(p("accent", busUrl)),
    ],

    // logs, mcp (DRAFT)
    noLog: (path: string) => [
      warn(`No daemon log yet at ${clip(path, 24)}`),
      next(`Run ${bus} daemon to see its output in this terminal.`),
    ],
    mcpPi: () => [
      warn("Pi uses the bus extension, not an MCP server."),
      next(`Run ${bus} to install the extension.`),
    ],
  };
  return all;
}

export type Copy = ReturnType<typeof copy>;
