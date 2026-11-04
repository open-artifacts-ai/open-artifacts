import { join } from "node:path";
import type { State } from "./state.ts";
import type { Ctx } from "./step.ts";

/**
 * The oldest deployed version this checkout upgrades from. 0.109.0 is the
 * first release with Durable Object tag v4, which adds BusHub unbound; from
 * #1315 the template binds BUS_HUB. An install below it takes 0.109.0 (or any
 * later release before the bind) first, so the class never ships in the same
 * deploy that binds it. Raise this when a release binds a class added since.
 */
export const MIN_UPGRADE_FROM = "0.109.0";

export type VersionInfo = {
  repoVersion: string;
  liveVersion?: string;
  downgrade: boolean;
  /** The deployed version is below MIN_UPGRADE_FROM and this checkout is past it. */
  belowMinUpgrade: boolean;
};

/** The repo version: root package.json, else the release-please manifest. */
export function repoVersion(ctx: Ctx): string {
  const json = (p: string) =>
    JSON.parse(ctx.fs.read(join(ctx.root, p)) ?? "{}");
  return (
    json("package.json").version ??
    json(".release-please-manifest.json")["."] ??
    "0.0.0"
  );
}

/** X.Y.Z of a version, dropping any v prefix and -pre or +build suffix; undefined when it isn't one. */
function base(v: unknown): number[] | undefined {
  const m =
    typeof v === "string"
      ? v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
      : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** The deployed version: live /healthz `version`, else the saved one; a failed or odd answer is unknown. */
async function liveVersion(state: State, ctx: Ctx) {
  try {
    const r = await ctx.deps.fetch(`https://${ctx.opts.appHost}/healthz`, {
      signal: AbortSignal.timeout(10_000),
    });
    const v = r.ok
      ? ((await r.json().catch(() => ({}))) as { version?: unknown }).version
      : undefined;
    if (base(v)) return base(v);
  } catch {}
  return base(state.deployedVersion);
}

/**
 * Compares this checkout with the deployed version. A fresh install (not --upgrade, and
 * no workerVersion, deployedVersion or accessAppId saved) has nothing to compare and makes no request. Suffixes are
 * dropped: -dev+sha is not a tag to check out.
 */
export async function versionInfo(
  state: State,
  ctx: Ctx,
): Promise<VersionInfo> {
  let raw: string | undefined;
  try {
    raw = repoVersion(ctx);
  } catch {}
  const a = base(raw);
  if (!a)
    throw new Error(
      `cannot read this checkout's version (${JSON.stringify(raw)}) from package.json; fix it before deploying`,
    );
  const out = {
    repoVersion: a.join("."),
    downgrade: false,
    belowMinUpgrade: false,
  };
  const existing =
    ctx.opts.upgrade ||
    state.workerVersion ||
    state.deployedVersion ||
    state.accessAppId;
  if (!existing) return out;
  const b = await liveVersion(state, ctx);
  if (!b) return out;
  const min = base(MIN_UPGRADE_FROM) as number[];
  return {
    ...out,
    liveVersion: b.join("."),
    downgrade: cmp(a, b) < 0,
    belowMinUpgrade: cmp(b, min) < 0 && cmp(a, min) > 0,
  };
}

/** Order of two X.Y.Z triples: negative, zero or positive. */
function cmp(a: number[], b: number[]): number {
  const i = a.findIndex((x, k) => x !== b[k]);
  return i < 0 ? 0 : a[i] - b[i];
}

export const belowMinUpgradeMessage = (v: VersionInfo) =>
  `the deployed ${v.liveVersion} is older than ${MIN_UPGRADE_FROM}, the oldest version this release (${v.repoVersion}) upgrades from; upgrade to v${MIN_UPGRADE_FROM} first (git checkout v${MIN_UPGRADE_FROM}, then run the same upgrade), then check out this release and run it again`;

export const downgradeMessage = (v: VersionInfo) =>
  `this checkout is ${v.repoVersion}, older than the deployed ${v.liveVersion}; check out ${v.liveVersion} or newer (git checkout v${v.liveVersion}), or pass --allow-downgrade to deploy an older release on purpose`;
