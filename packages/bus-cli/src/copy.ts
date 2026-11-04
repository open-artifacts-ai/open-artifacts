import { displayKind, type StatusFields, statusSaysText } from "@oa/bus-ipc";
import { type AgentKind, BUS_ROUTES } from "@oa/bus-protocol";
import { box, glyph, paint, type Style, type Tone } from "./term.ts";

/**
 * Every line the CLI prints: design/cli/transcript.md states 1 to 10,
 * verbatim. The few lines it does not name are marked DRAFT. Change wording
 * here; the logic never holds copy.
 */

export const WIDTH = 80;
const MIN = 10 * 60_000;

export type HarnessName = "claude" | "opencode" | "pi" | "omp" | "codex";
export const HARNESS_LABEL: Record<HarnessName, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "oh-my-pi",
  codex: "Codex",
};
/** The dashboard's labels for AGENT_KINDS. */
export const KIND_LABEL: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "oh-my-pi",
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

export function copy(style: Style) {
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
      next(
        "Run npx @open-artifacts/bus install to restart it with the new one.",
      ),
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
      warn("No Claude Code, OpenCode, Pi, oh-my-pi or Codex found"),
      next("Install one, then run npx @open-artifacts/bus again."),
    ],
    restarted: () => done("Restarted the OpenCode service to load the plugin"),
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
      next("Install the Codex CLI, then run npx @open-artifacts/bus again."),
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
            next(
              "After a reboot, start it again with npx @open-artifacts/bus daemon.",
            ),
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
              next("Run npx @open-artifacts/bus install."),
            ],
    // install --no-service: the service step is skipped, nothing is started.
    serviceSkipped: () => [
      warn("Skipped the service, so no daemon is running."),
      next(
        "Start it with npx @open-artifacts/bus daemon, and again after a reboot.",
      ),
    ],
    // doctor, after the daemon line.
    serviceNodeMissing: (node: string) => [
      fail(`The service runs a Node that is gone: ${clip(node, 42)}.`),
      next(
        "Run npx @open-artifacts/bus install to point it at your current Node.",
      ),
    ],
    lingerOff: () => [
      warn("The daemon stops when you log out (systemd lingering is off)."),
      next("Run loginctl enable-linger $USER to keep it running."),
    ],
    daemonInTheWay: (socket: string, pid: number) => {
      const head = `Another daemon is still running (pid ${pid}) on `;
      return [
        fail(`${head}${clip(socket, 3 + len(head) + 1)}.`),
        next(
          `Stop it with kill ${pid}, then run npx @open-artifacts/bus install again.`,
        ),
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
      next("Run npx @open-artifacts/bus@latest install."),
    ],
    // Status and doctor, when the hub's `/healthz` names a problem (#294).
    hubProblem: (problem: string) => [
      fail(`The instance reports a problem: ${displayKind(problem)}`),
      next("Ask the instance's admin to check it."),
    ],
    daemonTimeout: () => [
      fail("The daemon did not start within 10 seconds."),
      next("Run npx @open-artifacts/bus doctor to see why."),
    ],

    rosterHeader: (namespace: string, live: number, queued: number) => {
      const n = live + queued;
      const meta = queued
        ? `${live} live ${g("sep")} ${queued} queued`
        : `${live} live`;
      const lead = `${n} agent${n === 1 ? "" : "s"} in namespace `;
      return `${lead}${p("accent", clip(namespace, len(lead) + 2 + len(meta)))}  ${p("muted", meta)}`;
    },
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
      `  ${p("muted", `and ${n} more ${g("sep")} npx @open-artifacts/bus status`)}`,
    queuedFootnote: () => [
      p(
        "muted",
        "Mail to a queued agent waits up to 1 hour for its machine to reconnect;",
      ),
      p("muted", "then the sender is told."),
    ],
    noAgents: (namespace: string) => {
      const lead = "No agents in namespace ";
      return [
        `${lead}${p("accent", clip(namespace, len(lead) + 5))} yet.`,
        "Start Claude Code, OpenCode, Pi, oh-my-pi or Codex in this folder and it joins.",
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
      p(
        "muted",
        "Check this machine anytime with npx @open-artifacts/bus status.",
      ),

    // 3, 4, 6
    denied: () => [
      fail("This machine was not approved."),
      next("Run npx @open-artifacts/bus again to get a new code."),
    ],
    expired: (code: string) => [
      fail(`Code ${code} expired after 10 minutes.`),
      next("Run npx @open-artifacts/bus again to get a new code."),
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
      next("Run npx @open-artifacts/bus doctor to see why."),
    ],
    // A SOCKET_PATH start failure, in place of `failed`.
    socketPathFailed: (message: string) => [
      fail("The daemon cannot listen on its socket."),
      next(p("muted", clip(message.split("\n")[0] ?? "", 3))),
      next("Run npx @open-artifacts/bus doctor to see why."),
    ],
    usage: (message: string) => [
      // The parser's message, as a sentence.
      fail(clip(message.charAt(0).toUpperCase() + message.slice(1), 3)),
      next(
        "Run npx @open-artifacts/bus with install, login, daemon, status, logs,",
      ),
      next(
        "doctor, global add|rm|list, uninstall, mcp <claude|opencode|pi|codex>",
      ),
      next("or version."),
      next("install takes --no-service to skip the launchd or systemd step."),
    ],
    skipped: (h: HarnessName, reason: string) => [
      warn(
        `Skipped ${HARNESS_LABEL[h]}: ${clip(reason, 14 + len(HARNESS_LABEL[h]))}`,
      ),
      next("Fix it, then run npx @open-artifacts/bus again."),
    ],
    noHub: () => [
      fail("No Open Artifacts instance to connect to."),
      next("Run npx @open-artifacts/bus --instance <your instance URL>,"),
      next("or set OA_BUS_INSTANCE."),
    ],
    hubMismatch: (approved: string, asked: string, askedUrl: string) => {
      // Both hosts share the line: each keeps at least 20 columns.
      const a = clip(approved, 39 + Math.min(len(asked), 20));
      const b = clip(asked, 39 + len(a));
      return [
        fail(`This machine is approved for ${a}, not ${b}.`),
        next("Run npx @open-artifacts/bus uninstall --purge first, then"),
        next(`npx @open-artifacts/bus --instance ${clip(askedUrl, 39)}.`),
      ];
    },
    checkOk: (label: string) => done(label),
    checkFailed: (label: string, action: string) => [fail(label), next(action)],
    noNamespace: () =>
      p(
        "muted",
        "This folder has no namespace, so there is no roster to show.",
      ),
    couldNotRemove: (h: HarnessName, reason: string) => [
      warn(
        `Could not remove the bus from ${HARNESS_LABEL[h]}: ${clip(reason, 37 + len(HARNESS_LABEL[h]))}`,
      ),
      next("Fix it, then run npx @open-artifacts/bus uninstall again."),
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
      next(
        "Wait a few seconds and run npx @open-artifacts/bus uninstall --purge again.",
      ),
      next(
        "If it keeps running, run npx @open-artifacts/bus doctor to see why.",
      ),
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
      next("Run npx @open-artifacts/bus to restart it,"),
      next("or npx @open-artifacts/bus doctor to see why."),
    ],
    statusDaemonStalled: () => [
      fail("Daemon not responding"),
      next(
        "It is running but not answering. Try again, or run npx @open-artifacts/bus doctor.",
      ),
    ],
    hubNotReachable: (
      host: string,
      error: string | undefined,
      again: string,
    ) => [
      `${fail(`Hub not reachable at ${clip(host, 26 + (error ? len(error) + 2 : 0))}`)}${
        error ? `  ${p("muted", error)}` : ""
      }`,
      next(
        `Check your network, then run npx @open-artifacts/bus ${again} again.`,
      ),
    ],
    notRegistered: () => [
      fail("This computer is not connected to a bus."),
      next("Run npx @open-artifacts/bus to approve it."),
    ],
    revoked: () => [
      fail("This machine was revoked."),
      next("Run npx @open-artifacts/bus install to approve it again."),
    ],

    // 8. doctor
    nodeOk: (version: string) => done(`Node ${version}`),
    nodeOld: (version: string) => [
      fail(`Node ${clip(version, 39)} is too old (needs 22 or newer)`),
      next(
        "Install Node 22 or newer, then run npx @open-artifacts/bus doctor again.",
      ),
    ],
    credentials: (path: string, token: string) =>
      done(`Credentials at ${clip(path, 37)}`, tokenTail(token, more)),
    noCredentials: (path: string) => [
      fail(`No credentials at ${clip(path, 21)}`),
      next("Run npx @open-artifacts/bus to approve this machine."),
    ],
    revokedCheck: () => [
      fail("This machine was revoked"),
      next("Run npx @open-artifacts/bus install to approve it again."),
    ],
    // DRAFT: the short socket folder a long OA_BUS_HOME needs is not ours.
    socketFolderUnsafe: (dir: string, why: string) => [
      fail(`Daemon socket folder ${clip(dir, 33)} is unsafe`),
      next(`It ${why}. Remove it, then run npx @open-artifacts/bus.`),
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
      next(
        "Remove it, then run npx @open-artifacts/bus global add <dir> again.",
      ),
    ],
    globalAsked: () => [
      warn("This repo's .oa-bus.json asks for global, which is ignored here."),
      next("Allow it with npx @open-artifacts/bus global add ."),
    ],
    daemonNotRunning: () => [
      fail("Daemon is not running"),
      next("Run npx @open-artifacts/bus to restart it."),
    ],
    daemonNotResponding: () => [
      fail("Daemon is not responding"),
      next(
        "Try again in a moment, or run npx @open-artifacts/bus to restart it.",
      ),
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
      next("Run npx @open-artifacts/bus to wire it."),
    ],
    claudeAccepts: () =>
      done("Claude Code accepts messages from other machines"),
    claudeIsolates: (settings: string) => [
      warn("Claude Code ignores messages from other machines"),
      next(`Set isolatePeerMachines to false in ${clip(settings, 40)}.`),
    ],
    // Codex's checks, after its wiring line (C26e).
    codexWakes: (bin: string) => done(`Codex wakes with ${clip(bin, 20)}`),
    codexNoWakeCheck: () => [
      warn("No codex binary found, so idle Codex threads are not woken"),
      next(
        "Install the Codex CLI, then run npx @open-artifacts/bus install again.",
      ),
    ],
    codexHomeMismatch: (shell: string, service: string) => {
      // Both paths share the line: the shell's keeps at least 15 columns.
      const a = clip(service, 49 + Math.min(len(shell), 15));
      const b = clip(shell, 49 + len(a));
      return [
        warn(`The daemon reads Codex from ${a}, this shell from ${b}`),
        next(
          "Run npx @open-artifacts/bus install from this shell to match it.",
        ),
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
        next(
          "Run opencode upgrade, then npx @open-artifacts/bus install again.",
        ),
      ];
    },
    opencodeUnknown: () => [
      warn("OpenCode version unknown"),
      next(
        "Run opencode --version to check it, then npx @open-artifacts/bus install again.",
      ),
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
      "run npx @open-artifacts/bus to reconnect it.",
      p(
        "muted",
        "To remove everything, run npx @open-artifacts/bus uninstall --purge.",
      ),
    ],
    deleted: (home: string) =>
      done(`Deleted ${clip(home, 35)}, including machine.json`),
    stillListed: (label: string, host: string) => [
      warn(`${clip(label, 30)} is still listed on the bus`),
      next(
        `Revoke it in the dashboard at ${clip(host, 56)} to remove it for good.`,
      ),
      next("To use this computer again, run npx @open-artifacts/bus."),
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
      next(
        "Check the path, then run npx @open-artifacts/bus global add again.",
      ),
    ],
    globalRemoved: (dir: string) => [
      done(`${clip(dir, 24)} is no longer global.`),
      p("muted", "   Sessions already running there change when they restart."),
    ],
    globalNotListed: (dir: string) =>
      warn(`${clip(dir, 36)} was not global. Nothing changed.`),
    globalNone: () => [
      "No global directories.",
      p("muted", "Add one with npx @open-artifacts/bus global add <dir>."),
    ],
    globalList: (dirs: string[]) => [
      `${dirs.length} global ${dirs.length === 1 ? "directory" : "directories"}`,
      ...dirs.map((d) => `  ${clip(d, 2)}`),
    ],

    // logs, mcp (DRAFT)
    noLog: (path: string) => [
      warn(`No daemon log yet at ${clip(path, 24)}`),
      next(
        "Run npx @open-artifacts/bus daemon to see its output in this terminal.",
      ),
    ],
    mcpPi: () => [
      warn("Pi uses the bus extension, not an MCP server."),
      next("Run npx @open-artifacts/bus to install the extension."),
    ],
  };
  return all;
}

export type Copy = ReturnType<typeof copy>;
