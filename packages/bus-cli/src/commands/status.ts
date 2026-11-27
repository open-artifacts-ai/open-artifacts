import { existsSync, readFileSync } from "node:fs";
import {
  canonicalAddress,
  listInstances,
  readFolders,
  resolveNamespace,
} from "@oa/bus-daemon";
import { type StatusReply, stripTerminalControls } from "@oa/bus-ipc";
import { semverGte } from "@oa/bus-protocol";
import { hostSlug } from "@oa/shared/secrets";
import {
  type Ctx,
  probeDaemon,
  say,
  sayErr,
  socketFolderLines,
  tilde,
} from "../context.ts";
import { HARNESS_LABEL } from "../copy.ts";
import { originOf, readMachine } from "../machine.ts";
import type { Harness } from "../steps/adapters.ts";
import { savedSkill, skillVersion } from "../steps/skill.ts";
import {
  type AttentionItem,
  cleanText,
  type InstanceView,
  type OtherProject,
  renderStatusScreen,
  type StatusAgent,
  terminalWidth,
  type Verdict,
} from "./status-view.ts";

/** A late message counts for Needs attention only when well past normal 5 s delivery (#3328 S2). */
export const LATE_ATTENTION_MS = 60_000;

export const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/** `major.minor.patch` of a semver, without pre-release or build; undefined when it is not one. */
const core = (v: string): string | undefined => {
  const c = v.replace(/[-+].*$/, "");
  return semverGte(v, v) && semverGte(c, c) ? c : undefined;
};

const UPDATE_PROBE_MS = 1500;
// Control, format and line-separator characters: never shown.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** What `/healthz` says: the hub's version and, when it has one, a problem. */
export type Healthz = { version?: string; problem?: string };

/** The fields of a `/healthz` body, reading at most 4 KB; empty when it has none. */
export const healthzBody = async (res: Response): Promise<Healthz> => {
  try {
    const reader = res.body?.getReader();
    if (!reader) return {};
    const dec = new TextDecoder();
    let text = "";
    while (text.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    const body = JSON.parse(text.slice(0, 4096)) as {
      version?: unknown;
      problem?: unknown;
    };
    return {
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.problem === "string" && body.problem !== ""
        ? { problem: stripTerminalControls(body.problem) }
        : {}),
    };
  } catch {
    return {};
  }
};

/** The hub's `/healthz` within a short bound, no redirects; empty on any failure. */
const probeHealthz = async (ctx: Ctx, hub: string): Promise<Healthz> => {
  try {
    const res = await ctx.fetch(`${hub.replace(/\/+$/, "")}/healthz`, {
      redirect: "error",
      signal: AbortSignal.timeout(UPDATE_PROBE_MS),
    });
    return res.ok ? await healthzBody(res) : {};
  } catch {
    return {};
  }
};

/**
 * The newest of the hub's and this CLI's core versions when it is newer than
 * the daemon's (C26h, C26i), compared on major.minor.patch only: a staging
 * hub's `0.47.0-abc1234` is 0.47.0, and a pre-release of the same core is
 * never newer. A daemon that predates `hub_version` is answered by the hub's
 * `/healthz` within a short bound. Undefined while the hub link is down, when
 * nothing is newer, or when a version is not a version: then nothing is said.
 */
export const updateTarget = async (
  ctx: Ctx,
  st: { hub: string; version: string; hub_version?: string | undefined },
  probe: () => Promise<string | undefined>,
): Promise<string | undefined> => {
  if (st.hub !== "connected") return undefined;
  const mine = core(st.version);
  if (mine === undefined) return undefined;
  const hubV = st.hub_version ?? (await probe());
  const newest = [hubV, ctx.version]
    .map((v) => (v === undefined ? undefined : core(v)))
    .filter((v): v is string => v !== undefined)
    .reduce<string | undefined>(
      (a, b) => (a === undefined || !semverGte(a, b) ? b : a),
      undefined,
    );
  return newest !== undefined && !semverGte(mine, newest) ? newest : undefined;
};

const FOLDERS_SHOWN = 50;

/**
 * #2793: with two or more instances, which hub each is and which folders use
 * which. With one, nothing: the output stays as it was.
 * Kept exported for `--instances` (S3) and callers.
 */
export function instanceBlocks(
  ctx: Ctx,
  rows: readonly {
    name: string;
    link: "connected" | "not_connected";
    revoked: boolean;
    agents: number;
    guests?: readonly { name: string }[];
  }[],
): string[][] {
  const list = listInstances(ctx.home);
  if (list.length < 2) return [];
  const clean = (t: string) => stripTerminalControls(t).replace(HIDDEN, "");
  const inst = [
    "Instances",
    ...list.flatMap((i) => {
      const r = rows.find((x) => x.name === i.name);
      const state = r?.revoked
        ? "revoked"
        : r?.link === "connected"
          ? "connected"
          : "not connected";
      const addr = clean(canonicalAddress(i.hub) ?? "(address unreadable)");
      const n = r?.agents ?? 0;
      return [
        `  ${clean(i.name)}${i.main ? " (main)" : ""}  ${addr}  ${state}  ${n} ${n === 1 ? "agent" : "agents"}`,
        // #2793 S3b: sessions homed elsewhere that used this instance's tools.
        ...(r?.guests ?? []).map((g) => `    guest session: ${clean(g.name)}`),
      ];
    }),
  ];
  const map = Object.entries(readFolders(ctx.home).map).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  const folders =
    map.length === 0
      ? []
      : [
          [
            "Folders",
            ...map
              .slice(0, FOLDERS_SHOWN)
              .map(
                ([dir, name]) =>
                  `  ${clean(tilde(ctx, dir))} -> ${clean(name)}`,
              ),
            ...(map.length > FOLDERS_SHOWN
              ? [`  and ${map.length - FOLDERS_SHOWN} more`]
              : []),
          ],
        ];
  return [inst, ...folders];
}

function buildInstances(
  ctx: Ctx,
  mainHub: string,
  mainRevoked: boolean,
  st?: StatusReply,
): InstanceView[] {
  const configured = listInstances(ctx.home);
  if (configured.length < 2) {
    if (mainRevoked) {
      return [
        {
          name: "main",
          host: hostOf(mainHub),
          ok: false,
          reason: "revoked",
        },
      ];
    }
    const ok = st?.hub === "connected";
    return [
      {
        name: "main",
        host: hostOf(mainHub),
        ok,
        ...(ok ? {} : { reason: "can't reach" as const }),
      },
    ];
  }
  const rows = st?.instances ?? [];
  return configured.map((inst) => {
    const r = rows.find((x) => x.name === inst.name);
    if (r?.revoked || (inst.main && mainRevoked)) {
      return {
        name: inst.name,
        host: hostOf(inst.hub),
        ok: false,
        reason: "revoked" as const,
      };
    }
    const ok = r
      ? r.link === "connected"
      : Boolean(inst.main && st?.hub === "connected");
    return {
      name: inst.name,
      host: hostOf(inst.hub),
      ok,
      ...(ok ? {} : { reason: "can't reach" as const }),
    };
  });
}

function currentNamespace(ctx: Ctx, st: StatusReply): string | undefined {
  if (st.namespace) return st.namespace;
  if (ctx.cwd && existsSync(ctx.cwd)) {
    try {
      return resolveNamespace(ctx.cwd).namespace;
    } catch {}
  }
  return st.namespaces[0]?.namespace;
}

function partitionNamespaces(
  ctx: Ctx,
  st: StatusReply,
): { agents: StatusAgent[]; others: OtherProject[] } {
  const cur = currentNamespace(ctx, st);
  const byNs = new Map<string, StatusAgent[]>();
  for (const block of st.namespaces) {
    const list = byNs.get(block.namespace) ?? [];
    for (const a of block.agents) {
      if (
        !list.some(
          (x) =>
            x.name === a.name && x.kind === a.kind && x.machine === a.machine,
        )
      ) {
        list.push(a);
      }
    }
    byNs.set(block.namespace, list);
  }
  const agents = cur ? (byNs.get(cur) ?? []) : [];
  const others: OtherProject[] = [];
  for (const [namespace, list] of byNs) {
    if (namespace === cur || list.length === 0) continue;
    others.push({ namespace, count: list.length });
  }
  return { agents, others };
}

const SKILL_HARNESSES: readonly Harness[] = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "hermes",
  "openclaw",
  "antigravity",
];

function outdatedSkills(
  ctx: Ctx,
  hubHost: string,
  hubVersion: string | undefined,
): AttentionItem[] {
  const hubCore = hubVersion ? core(hubVersion) : undefined;
  if (!hubCore) return [];
  const folder = `open-artifacts-${hostSlug(hubHost)}`;
  const seenFiles = new Set<string>();
  const items: AttentionItem[] = [];
  for (const h of SKILL_HARNESSES) {
    const file = savedSkill({ home: ctx.userHome, env: ctx.env }, h, folder);
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);
    let savedVer: string | undefined;
    try {
      savedVer = skillVersion(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const savedCore = savedVer ? core(savedVer) : undefined;
    if (!savedCore || semverGte(savedCore, hubCore)) continue;
    items.push({
      problem: `The ${HARNESS_LABEL[h]} skill is out of date (${savedVer}).`,
      fix: `run ${ctx.busCmd} skill`,
    });
  }
  return items;
}

function collectAttention(
  ctx: Ctx,
  opts: {
    mainHub: string;
    instances: InstanceView[];
    st: StatusReply;
    health: Healthz;
  },
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const inst of opts.instances) {
    if (inst.ok) continue;
    if (inst.reason === "revoked") {
      items.push({
        problem: `${inst.host} revoked this machine.`,
        fix: `run ${ctx.busCmd} install to approve it again`,
      });
    } else {
      items.push({
        problem: `${inst.host} doesn't answer. Agents there won't get messages.`,
        fix: `check your network, then ${ctx.busCmd} doctor`,
      });
    }
  }
  if (opts.health.problem !== undefined) {
    items.push({
      problem: `${hostOf(opts.mainHub)} reports a problem: ${cleanText(opts.health.problem)}.`,
      fix: "ask the instance's admin to check it",
    });
  }
  const unlinked = (opts.st.claude_sessions ?? []).filter(
    (s) => s.state === "unlinked",
  );
  if (unlinked.length > 0) {
    items.push({
      problem:
        unlinked.length === 1
          ? `1 session here isn't linked: its page edits show "not linked".`
          : `${unlinked.length} sessions here aren't linked: their page edits show "not linked".`,
      fix: `run /mcp in that session.  Details: ${ctx.busCmd} status --links`,
    });
  }
  items.push(
    ...outdatedSkills(
      ctx,
      hostOf(opts.mainHub),
      opts.st.hub_version ?? opts.health.version,
    ),
  );
  const veryLate = (opts.st.late ?? []).filter(
    (l) => typeof l.delay_ms === "number" && l.delay_ms >= LATE_ATTENTION_MS,
  );
  if (veryLate.length > 0) {
    items.push({
      problem:
        veryLate.length === 1
          ? "1 message delivered over a minute late."
          : `${veryLate.length} messages delivered over a minute late.`,
      fix: `run ${ctx.busCmd} status --messages`,
    });
  }
  return items;
}

/**
 * Default `oa-bus status` screen (#3328 S1/S2). Read-only; never prints the token.
 * Exit 0 only when working (daemon up, all instances connected, no attention items).
 */
export async function status(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  const width = terminalWidth(ctx);
  const m = readMachine(ctx.home);
  if (m.state !== "ok") {
    say(
      ctx,
      renderStatusScreen(ctx.style, {
        version: ctx.version,
        verdict: "down",
        instances: [],
        busCmd: ctx.busCmd,
        now: ctx.now(),
        width,
      }),
    );
    sayErr(ctx, c.notRegistered());
    return 1;
  }
  if (m.revoked) {
    const instances = buildInstances(ctx, m.hub, true);
    say(
      ctx,
      renderStatusScreen(ctx.style, {
        version: ctx.version,
        verdict: "down",
        machine: m.label,
        instances,
        attention: [
          {
            problem: `${hostOf(m.hub)} revoked this machine.`,
            fix: `run ${ctx.busCmd} install to approve it again`,
          },
        ],
        busCmd: ctx.busCmd,
        now: ctx.now(),
        width,
      }),
    );
    sayErr(ctx, c.revoked());
    return 1;
  }
  // Started now so it overlaps the daemon probe; awaited only once daemon answers.
  const health = probeHealthz(ctx, m.hub);
  const probe = await probeDaemon(ctx, { timeoutMs: 3000 });
  if (probe.state !== "up") {
    const startCmd = ctx.service.kind
      ? `${ctx.busCmd} install`
      : `${ctx.busCmd} daemon`;
    const attention: AttentionItem[] = [
      probe.state === "stalled"
        ? {
            problem: "The bus daemon isn't responding.",
            fix: `try again, or run ${ctx.busCmd} doctor`,
          }
        : {
            problem: "The bus daemon isn't running.",
            fix: `run ${startCmd}`,
          },
    ];
    say(
      ctx,
      renderStatusScreen(ctx.style, {
        version: ctx.version,
        verdict: "down",
        machine: m.label,
        instances: buildInstances(ctx, m.hub, false),
        attention,
        busCmd: ctx.busCmd,
        now: ctx.now(),
        width,
      }),
    );
    sayErr(
      ctx,
      probe.state === "stalled"
        ? c.statusDaemonStalled()
        : (socketFolderLines(ctx) ?? c.statusDaemonDown()),
    );
    return 1;
  }
  const st = probe.st;
  const hz = await health;
  const instances = buildInstances(ctx, m.hub, false, st);
  const attention = collectAttention(ctx, {
    mainHub: m.hub,
    instances,
    st,
    health: hz,
  });
  const anyUp = instances.some((i) => i.ok);
  const verdict: Verdict = !anyUp
    ? "down"
    : attention.length > 0
      ? "degraded"
      : "working";
  const agentsPageUrl = `${originOf(m.hub)}/settings/agents`;

  say(
    ctx,
    renderStatusScreen(ctx.style, {
      version: ctx.version,
      verdict,
      machine: m.label || st.label,
      instances,
      attention,
      ...(anyUp ? { project: partitionNamespaces(ctx, st) } : {}),
      agentsPageUrl,
      busCmd: ctx.busCmd,
      now: ctx.now(),
      width,
    }),
  );
  return verdict === "working" ? 0 : 1;
}
