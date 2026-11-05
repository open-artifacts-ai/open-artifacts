import { R } from "@oa/shared";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

async function attempt(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn("smoke warm-up: retrying", (e as Error).message);
    await fn();
  }
}

/**
 * In CI the smoke run needs both: without STAGING_URL every suite skips, and
 * without STAGING_OWNER_PAT the seven authenticated suites skip, and the run
 * still goes green on curl checks alone (review item 25). Locally they stay
 * optional. Names the missing variables, never a value.
 */
export function missingSmokeEnv(
  env: Record<string, string | undefined>,
): string[] {
  if (env.CI !== "true") return [];
  return ["STAGING_URL", "STAGING_OWNER_PAT"].filter((k) => !env[k]?.trim());
}

/** Warms a just-deployed Worker (healthz, then one publish) before the smoke suite. */
export default async function warmup(): Promise<void> {
  const missing = missingSmokeEnv(process.env);
  if (missing.length)
    throw new Error(
      `smoke: ${missing.join(" and ")} must be set in CI (the authenticated suites would skip and the run would pass)`,
    );
  if (!base) return;
  await attempt(async () => {
    const r = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`healthz ${r.status}`);
  });
  if (!pat) return;
  const auth = { authorization: `Bearer ${pat}` };
  let id: string | undefined;
  await attempt(async () => {
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        title: `smoke warm-up ${new Date().toISOString()}`,
        format: "markdown",
        content: "# warm-up\n",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status !== 201) throw new Error(`publish ${r.status}`);
    id = ((await r.json()) as { id: string }).id;
  });
  if (id)
    await fetch(`${base}${R.artifact(id)}`, { method: "DELETE", headers: auth })
      .then((d) => {
        if (d.status !== 204)
          console.warn(`smoke warm-up: DELETE ${id} -> ${d.status}`);
      })
      .catch(() => console.warn(`smoke warm-up: DELETE ${id} failed`));
}
