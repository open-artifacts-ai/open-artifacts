// The Turnstile derivation (design v7 5.3, 5.4, 2.6): the env's one widget,
// named platformNames(env).turnstile, and its secret, read with the
// provisioning token (cf.turnstileList, then cf.turnstileWidget). Create,
// upgrade and rollback pass the pair when codes are on; verifyTurnstile
// checks a self-serve token against it. The secret is never returned by
// RPC, logged or put in a step output or error.
import {
  type Cf,
  type Env as DeployEnv,
  ProvisionRefused,
  platformNames,
  TURNSTILE_TEST_KEYS,
} from "@oa/provision";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The env's widget pair; refused unless exactly one widget has its name. */
export async function turnstilePair(
  cf: Cf,
  env: DeployEnv,
): Promise<{ sitekey: string; secret: string }> {
  const name = platformNames(env).turnstile;
  const mine = (await cf.turnstileList()).filter((w) => w.name === name);
  if (mine.length !== 1)
    throw new ProvisionRefused(
      `${mine.length} Turnstile widgets are named ${name}; exactly one is needed`,
      "invalid_state",
    );
  const sitekey = (mine[0] as { sitekey: string }).sitekey;
  const w = await cf.turnstileWidget(sitekey);
  if (
    !w ||
    w.name !== name ||
    w.sitekey !== sitekey ||
    typeof w.secret !== "string" ||
    w.secret === ""
  )
    throw new ProvisionRefused(
      `the Turnstile widget ${name} has no secret`,
      "invalid_state",
    );
  return { sitekey, secret: w.secret };
}

/** How long verifyTurnstile reuses the widget pair (2.6). */
export const TURNSTILE_PAIR_TTL_MS = 5 * 60_000;
// Per isolate, module scope (never on an RPC class): a signup flood must not
// drive two Cloudflare REST calls per request on PROVISION_TOKEN.
const pairs = new Map<
  string,
  { at: number; pair: { sitekey: string; secret: string } }
>();

/** turnstilePair, cached per account and env for TURNSTILE_PAIR_TTL_MS. */
export async function cachedTurnstilePair(
  key: { accountId: string; env: DeployEnv },
  now: number,
  cf: () => Promise<Cf>,
): Promise<{ sitekey: string; secret: string }> {
  const k = `${key.accountId}:${key.env}`;
  const hit = pairs.get(k);
  if (hit && now >= hit.at && now - hit.at < TURNSTILE_PAIR_TTL_MS)
    return hit.pair;
  const pair = await turnstilePair(await cf(), key.env);
  pairs.set(k, { at: now, pair });
  return pair;
}

/** Tests only: forget every cached pair. */
export const clearTurnstilePairs = (): void => pairs.clear();

/**
 * Siteverify one token. With the widget's secret the answer must also name
 * `action` and `hostname`; Turnstile's test secret answers neither, so with
 * it only `success` counts. Any non-200 or malformed answer is a refusal.
 */
export async function siteverify(
  fetcher: typeof fetch,
  o: {
    secret: string;
    token: string;
    remoteIp: string;
    action: string;
    hostname: string;
  },
): Promise<boolean> {
  const form = new FormData();
  form.set("secret", o.secret);
  form.set("response", o.token);
  form.set("remoteip", o.remoteIp);
  const res = await fetcher(SITEVERIFY, { method: "POST", body: form });
  if (res.status !== 200) {
    await res.body?.cancel();
    return false;
  }
  const b = (await res.json().catch(() => null)) as {
    success?: unknown;
    action?: unknown;
    hostname?: unknown;
  } | null;
  if (b?.success !== true) return false;
  if (o.secret === TURNSTILE_TEST_KEYS.secret) return true;
  return b.action === o.action && b.hostname === o.hostname;
}
