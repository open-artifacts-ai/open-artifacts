import { stripTerminalControls } from "@oa/bus-ipc";
import { semverGte } from "@oa/bus-protocol";
import {
  type Ctx,
  probeDaemon,
  say,
  sayErr,
  socketFolderLines,
} from "../context.ts";
import { ago, forHowLong, type HubLink } from "../copy.ts";
import { readMachine } from "../machine.ts";
import { rosters } from "./install.ts";

export const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/** An older daemon omits `hub_ever` and `hub_since`: not connected reads as connecting. */
const linkOf = (
  st: {
    hub: string;
    hub_ever?: boolean | undefined;
    hub_since?: number | undefined;
  },
  now: number,
): HubLink => {
  if (st.hub === "connected") return { state: "connected" };
  if (!st.hub_ever) return { state: "connecting" };
  return {
    state: "reconnecting",
    for: st.hub_since === undefined ? undefined : forHowLong(st.hub_since, now),
  };
};

/** `major.minor.patch` of a semver, without pre-release or build; undefined when it is not one. */
const core = (v: string): string | undefined => {
  const c = v.replace(/[-+].*$/, "");
  return semverGte(v, v) && semverGte(c, c) ? c : undefined;
};

const UPDATE_PROBE_MS = 1500;

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

/**
 * Transcript state 7. Read-only; never prints the token. Exit 0 only when
 * the daemon reports an open hub link.
 */
export async function status(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const m = readMachine(ctx.home);
  if (m.state !== "ok") {
    sayErr(ctx, c.notRegistered());
    return 1;
  }
  // machine.json's hub: OA_BUS_INSTANCE only picks one before login.
  const host = hostOf(m.hub);
  if (m.revoked) {
    say(ctx, c.hubRow(host), c.machineRow(m.label));
    sayErr(ctx, c.revoked());
    return 1;
  }
  // Started now so it overlaps the daemon probe; awaited only where printed.
  const health = probeHealthz(ctx, m.hub);
  const probe = await probeDaemon(ctx, { timeoutMs: 3000 });
  if (probe.state !== "up") {
    say(ctx, c.hubRow(host), c.machineRow(m.label));
    sayErr(
      ctx,
      probe.state === "stalled"
        ? c.statusDaemonStalled()
        : (socketFolderLines(ctx) ?? c.statusDaemonDown()),
    );
    return 1;
  }
  const st = probe.st;
  say(ctx, c.hubRow(host, linkOf(st, ctx.now())), c.machineRow(m.label));
  say(ctx, c.daemonRunning(st.pid, ctx.service.kind, ctx.service.fallback));
  // One bounded fetch serves both: the problem shows even with the link down.
  const { problem } = await health;
  if (problem !== undefined) say(ctx, c.hubProblem(problem));
  const update = await updateTarget(
    ctx,
    st,
    async () => (await health).version,
  );
  if (update) say(ctx, c.updateAvailable(update, st.version));
  if (st.hub !== "connected") {
    // Without the hub, no row's state can be known.
    sayErr(ctx, c.hubNotReachable(host, st.hub_error, "status"));
    return 1;
  }
  if (st.namespaces.length > 0) say(ctx, "", rosters(ctx, st.namespaces));
  const late = [...(st.late ?? [])].sort((a, b) => b.at - a.at);
  if (late.length > 0)
    say(ctx, "", [
      c.lateHeader(late.length),
      ...late.flatMap((l) => [
        c.lateRow(l.from, l.to, ago(l.at, ctx.now())),
        ...(l.excerpt ? [c.lateQuote(stripTerminalControls(l.excerpt))] : []),
      ]),
    ]);
  return problem === undefined ? 0 : 1;
}
