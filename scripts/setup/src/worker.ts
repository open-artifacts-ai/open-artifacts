import type { Ctx } from "./step.ts";

/** Deployed vars compared when state is rebuilt (names only in messages). */
export const PINNED = [
  "APP_HOST",
  "CONTENT_HOST",
  "OWNER_EMAIL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_CLIENT_ID",
] as const;

type Settings = {
  bindings?: { type: string; name: string; text?: string }[];
};

type Binding = NonNullable<Settings["bindings"]>[number];

/** A Worker's bindings; undefined when it does not exist (404), [] when the read had none. */
export async function scriptBindings(
  api: Ctx["api"],
  name: string,
  accountId: string,
): Promise<Binding[] | undefined> {
  const path = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`;
  const settings = await api<Settings>("GET", path).catch((e) => {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  });
  // A 200 without bindings is a partial read, not "no Worker".
  return settings && (settings.bindings ?? []);
}

/** The live Worker's bindings; undefined when no Worker exists (404). */
export const workerBindings = (ctx: Ctx, accountId: string) =>
  scriptBindings(ctx.api, ctx.opts.name, accountId);

/**
 * The live Worker's plain-text vars, from `GET .../workers/scripts/{name}/settings`.
 * Undefined when it was never deployed: no Worker (404), or a draft (made by a
 * secret put) carrying none of the PINNED vars.
 */
export async function deployedVars(
  ctx: Ctx,
  accountId: string,
): Promise<Map<string, string | undefined> | undefined> {
  const vars = new Map(
    ((await workerBindings(ctx, accountId)) ?? [])
      .filter((b) => b.type === "plain_text")
      .map((b) => [b.name, b.text]),
  );
  return PINNED.some((k) => vars.has(k)) ? vars : undefined;
}

type Deployments = {
  deployments?: { versions?: { version_id: string; percentage: number }[] }[];
};

/**
 * The version id serving all traffic, from `GET .../workers/scripts/{name}/deployments`
 * (newest first). Undefined when no Worker is deployed (404); throws when
 * traffic is split or empty, since no single version is "current".
 */
export async function currentVersion(
  api: Ctx["api"],
  name: string,
  accountId: string,
) {
  const path = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/deployments`;
  const res = await api<Deployments>("GET", path).catch((e) => {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  });
  if (!res) return undefined;
  const vs = res.deployments?.[0]?.versions ?? [];
  if (vs.length !== 1 || vs[0].percentage !== 100)
    throw new Error("traffic is split across versions or not readable");
  return vs[0].version_id;
}
