// The billing backfill (self-serve billing, SS1e): one tiers row in the env's
// billing D1 (oa-<p>-billing) for each active hosted install that has none.
// Each install's tier is its provisioned TIER var (parseTier): trial, team,
// business, or none (free). A row that exists is never overwritten (ON
// CONFLICT DO NOTHING), so a second run writes nothing.
import { parseTier } from "@oa/shared";
import type { Cf } from "./cf.js";
import {
  assertOwnResource,
  type Env,
  platformNames,
  TRIAL_MS,
} from "./names.js";

export type BackfillTier = "free" | "trial" | "team" | "business";

export interface BackfillEntry {
  install: string;
  slug: string;
  /** null when the install is skipped before its tier is known. */
  tier: BackfillTier | null;
  /** write: no row yet (dry run) or written now; present: a row exists. */
  action: "write" | "present" | "skip";
  reason?: string;
}

export interface BackfillResult {
  dryRun: boolean;
  entries: BackfillEntry[];
  /** Rows a dry run would write (0 on a real run). */
  planned: number;
  written: number;
  present: number;
  skipped: number;
}

/**
 * A trial's end is now + TRIAL_MS (a NULL trial end never expires); every
 * backfilled row is active at version 1.
 */
export const BACKFILL_SQL =
  "INSERT INTO tiers (install_id, tier, status, trial_ends_at, version, updated_at) VALUES (?1, ?2, 'active', ?3, 1, ?4) ON CONFLICT (install_id) DO NOTHING RETURNING install_id";

function tierOf(vars: unknown): { tier: BackfillTier } | { reason: string } {
  if (typeof vars !== "string") return { reason: "no stored vars" };
  let v: unknown;
  try {
    v = JSON.parse(vars);
  } catch {
    return { reason: "stored vars are not JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { reason: "stored vars are not an object" };
  const raw = (v as Record<string, unknown>).TIER;
  if (raw === undefined || raw === "") return { tier: "free" };
  if (typeof raw !== "string") return { reason: "TIER is not a string" };
  const t = parseTier(raw);
  return t ? { tier: t } : { reason: "unknown TIER" };
}

/**
 * Plans (dryRun) or writes the backfill. `onEntry` runs after each install
 * of a real run is settled (the caller's audit row); a throw stops the run.
 */
export async function billingBackfill(o: {
  cf: Cf;
  env: Env;
  now: number;
  dryRun: boolean;
  onEntry?: (e: BackfillEntry) => Promise<void>;
}): Promise<BackfillResult> {
  const { cf, env } = o;
  const names = platformNames(env);
  const find = async (name: string, what: string) => {
    assertOwnResource(name, env);
    const id = await cf.d1Get(name);
    if (!id) throw new Error(`${what} D1 ${name} not found`);
    return id;
  };
  const platform = await find(names.db, "platform");
  const billing = await find(names.billing, "billing");
  const installs = ((
    await cf.d1Query(
      platform,
      "SELECT id, slug, state, vars FROM installs ORDER BY id",
    )
  )[0]?.results ?? []) as {
    id: string;
    slug: string;
    state: string;
    vars: unknown;
  }[];
  const have = new Set(
    (
      (await cf.d1Query(billing, "SELECT install_id FROM tiers"))[0]?.results ??
      []
    ).map((r) => r.install_id),
  );
  const entries: BackfillEntry[] = [];
  for (const i of installs) {
    let e: BackfillEntry;
    if (i.state !== "active")
      e = {
        install: i.id,
        slug: i.slug,
        tier: null,
        action: "skip",
        reason: `state ${i.state}`,
      };
    else {
      const t = tierOf(i.vars);
      if ("reason" in t)
        e = {
          install: i.id,
          slug: i.slug,
          tier: null,
          action: "skip",
          reason: t.reason,
        };
      else
        e = {
          install: i.id,
          slug: i.slug,
          tier: t.tier,
          action: have.has(i.id) ? "present" : "write",
        };
    }
    if (!o.dryRun && e.action === "write") {
      const r = await cf.d1Query(billing, BACKFILL_SQL, [
        e.install,
        e.tier,
        e.tier === "trial" ? o.now + TRIAL_MS : null,
        o.now,
      ]);
      // A row that appeared since the read (a trial start): left as it is.
      if (r[0]?.results?.length !== 1) e.action = "present";
    }
    entries.push(e);
    if (!o.dryRun) await o.onEntry?.(e);
  }
  const count = (a: BackfillEntry["action"]) =>
    entries.filter((e) => e.action === a).length;
  return {
    dryRun: o.dryRun,
    entries,
    planned: o.dryRun ? count("write") : 0,
    written: o.dryRun ? 0 : count("write"),
    present: count("present"),
    skipped: count("skip"),
  };
}
