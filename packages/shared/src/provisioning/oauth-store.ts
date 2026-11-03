// The OAuth store jobs (#1008): R29 sets OAUTH_STORE, R30 runs the KV -> D1
// copy. Both are the `update` kind: 0008's CHECK has no room for another
// kind, and migrations are additive, so the copy is a variant of it in
// jobs.args, as R26's revoke is of redline_creds. No zod: the provisioner's
// and the API's own checks read these.

export const OAUTH_STORE_MODES = ["kv", "dual", "d1"] as const;
export type OAuthStoreMode = (typeof OAUTH_STORE_MODES)[number];

/** How long dual must have been live before a copy (the server's runbook). */
export const OAUTH_DUAL_SETTLE_MS = 60_000;

/**
 * hosted_audit's record of a mode verified live on /healthz, written by R29's
 * job; detail is {mode}. R30 reads when dual went live from it.
 */
export const OAUTH_MODE_LIVE_ACTION = "oauth_store.mode_live";
/** The install's last verified mode. Bind: install id. */
export const OAUTH_MODE_LIVE_SQL = `SELECT at, detail FROM hosted_audit WHERE install_id = ? AND action = '${OAUTH_MODE_LIVE_ACTION}' ORDER BY id DESC LIMIT 1`;

/** When dual went live per that row; null unless the last verified mode is dual. */
export function dualLiveAt(
  row: { at: number; detail: string | null } | null,
): number | null {
  if (!row?.detail) return null;
  try {
    const d = JSON.parse(row.detail) as { mode?: unknown } | null;
    return d?.mode === "dual" ? row.at : null;
  } catch {
    return null;
  }
}

/** What an install stores as its mode; unset is kv, as on the server. */
export function storedOAuthMode(vars: string | null): string {
  if (vars === null) return "kv";
  try {
    const v = (JSON.parse(vars) as { OAUTH_STORE?: unknown } | null)
      ?.OAUTH_STORE;
    return typeof v === "string" && v.trim() !== "" ? v.trim() : "kv";
  } catch {
    return "kv";
  }
}

/**
 * hosted_audit's record that OAUTH_COPY_KEY is off an install's script: a
 * delete that worked, or a secret list without it. Detail {}.
 */
export const COPY_KEY_GONE_ACTION = "oauth_copy.key_gone";

/**
 * SQL over jobs alias `j`: a copy_key_left job whose key no later record saw
 * gone. Open until then: no lookback, and no later job's success closes it.
 */
export const copyKeyLeftOpen = (j: string) =>
  `(${j}.status = 'failed' AND ${j}.error_code = 'copy_key_left' AND NOT EXISTS (SELECT 1 FROM hosted_audit g WHERE g.install_id = ${j}.install_id AND g.action = '${COPY_KEY_GONE_ACTION}' AND g.at >= COALESCE(${j}.finished_at, ${j}.updated_at)))`;
/** An install with a left key still open. Bind: install id. */
export const COPY_KEY_LEFT_SQL = `SELECT 1 AS x FROM jobs j WHERE j.install_id = ? AND ${copyKeyLeftOpen("j")} LIMIT 1`;

export type OAuthJob = { op: "set"; mode: OAuthStoreMode } | { op: "copy" };

/** jobs.args of an R29 job. */
export const oauthStoreJobArgs = (b: {
  vars: { OAUTH_STORE: OAuthStoreMode };
}) => ({ vars: { OAUTH_STORE: b.vars.OAUTH_STORE } });
/** jobs.args of an R30 job: never the key or a cursor; counts join it at the end. */
export const oauthCopyJobArgs = () => ({ oauthCopy: true as const });

/**
 * An `update` job's args as its operation, or null for anything else. Only
 * these two shapes run: a row is a request, never a fact (2.5).
 */
export function parseOAuthJob(a: Record<string, unknown>): OAuthJob | null {
  const { vars, oauthCopy } = a;
  if (oauthCopy === true) return vars === undefined ? { op: "copy" } : null;
  if (oauthCopy !== undefined || !vars || typeof vars !== "object") return null;
  const keys = Object.keys(vars);
  const mode = (vars as { OAUTH_STORE?: unknown }).OAUTH_STORE;
  return keys.length === 1 && OAUTH_STORE_MODES.includes(mode as OAuthStoreMode)
    ? { op: "set", mode: mode as OAuthStoreMode }
    : null;
}

/** parseOAuthJob over raw jobs.args; null when it is not one of ours. */
export function oauthJobOf(raw: string): OAuthJob | null {
  try {
    const a = JSON.parse(raw) as unknown;
    return a && typeof a === "object" && !Array.isArray(a)
      ? parseOAuthJob(a as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
