import { randomBytes } from "node:crypto";
import { makeApi } from "../cf.ts";
import type { Ctx, Step } from "../step.ts";
import { linkFor, tokenById } from "../tokens.ts";
import { generateVapidPair } from "../vapid.ts";

export const ACCESS_SECRET = "ACCESS_CLIENT_SECRET";
const GENERATED = ["SESSION_SECRET", "CONTENT_SIGNING_KEY"];
const OPTIONAL = "ANALYTICS_TOKEN";
/** Browser push keys: generated once, never rotated (rotating breaks every subscription). */
const PUBLIC = "VAPID_PUBLIC_KEY";
const PRIVATE = "VAPID_PRIVATE_KEY";
const VAPID = [PUBLIC, PRIVATE];
/** OA_SETUP_PUSH_KEYS=off: leave VAPID alone entirely (CI sets it until the owner turns push on). */
const pushKeys = (ctx: Ctx) =>
  ctx.deps.env.OA_SETUP_PUSH_KEYS?.trim().toLowerCase() !== "off";
/**
 * A lone public key is refused: something else made it and replacing it would
 * break its subscriptions. A lone private key is our own interrupted run (the
 * private key goes first, and no browser can subscribe without the public one),
 * so it is regenerated.
 */
const lonePublic = (have: Set<string>) =>
  have.has(PUBLIC) && !have.has(PRIVATE)
    ? `Worker has ${PUBLIC} but not ${PRIVATE}; setup will not overwrite half a push key pair (that would break every subscription). Delete ${PUBLIC} with \`wrangler secret delete\` and rerun, or put ${PRIVATE} back`
    : undefined;
const analyticsLink = (ctx: Ctx, accountId?: string) =>
  linkFor(tokenById("analytics", { name: ctx.opts.name }), { accountId });
/** ANALYTICS_TOKEN from the environment (a dedicated token; never CLOUDFLARE_API_TOKEN). */
const envAnalytics = (ctx: Ctx) => ctx.deps.env.ANALYTICS_TOKEN?.trim() || "";

/**
 * True when `value` is the deploy token: the same string, or the same token id
 * from `GET /user/tokens/verify` (which answers for any live token).
 */
export async function reusesDeployToken(ctx: Ctx, value: string) {
  const deploy = ctx.deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!deploy) return false;
  if (deploy === value) return true;
  const id = async (t: string) => {
    try {
      const r = await makeApi(
        ctx.deps,
        ctx.wrangler,
        t,
      )<{ id?: string }>("GET", "/user/tokens/verify");
      return r?.id;
    } catch {
      return undefined;
    }
  };
  const [a, b] = await Promise.all([id(deploy), id(value)]);
  return Boolean(a && a === b);
}

/** Worker secret names. A Worker that doesn't exist yet has none. */
export async function listSecrets(ctx: Ctx): Promise<Set<string>> {
  let out: string;
  try {
    out = await ctx.wrangler([
      "secret",
      "list",
      "--name",
      ctx.opts.name,
      "--format",
      "json",
    ]);
  } catch (e) {
    if (/Worker "[^"]*".* not found/.test((e as Error).message))
      return new Set();
    throw e;
  }
  const list = jsonArray<{ name: string }>(out, "wrangler secret list");
  return new Set(list.map((s) => s.name));
}

/** Parses wrangler JSON output from the first line starting with `[` (banners may hold brackets). */
export function jsonArray<T>(out: string, what: string): T[] {
  const i = out.search(/^\s*\[/m);
  if (i < 0) throw new Error(`\`${what}\` returned no JSON array`);
  return JSON.parse(out.slice(i)) as T[];
}

/**
 * Puts a Worker secret via stdin, never argv. On a Worker that doesn't exist
 * yet, wrangler 4 (non-interactive) first creates an empty draft Worker.
 */
export async function putSecret(ctx: Ctx, name: string, value: string) {
  try {
    await ctx.wrangler(["secret", "put", name, "--name", ctx.opts.name], {
      input: value,
      sensitive: true,
    });
  } catch (e) {
    const escaped = JSON.stringify(value).slice(1, -1);
    const msg = (e as Error).message
      .replaceAll(value, "[redacted]")
      .replaceAll(escaped, "[redacted]");
    throw new Error(`secret put ${name} failed: ${msg}`);
  }
}

const random = () => randomBytes(32).toString("base64url");

export const secrets: Step = {
  name: "secrets",
  async check(state, ctx) {
    const have = await listSecrets(ctx);
    if (envAnalytics(ctx)) {
      // A provided token is put on every run, so rotating the source rotates
      // the Worker. --check can't read the stored value: present counts as done.
      if (!ctx.opts.check) return "todo";
      if (have.has(OPTIONAL))
        ctx.notes.push(
          `${OPTIONAL} set; the exported value is re-put on the next run`,
        );
      return GENERATED.every((n) => have.has(n)) &&
        (!pushKeys(ctx) || VAPID.every((n) => have.has(n))) &&
        have.has(OPTIONAL)
        ? "done"
        : "todo";
    }
    const quiet =
      !ctx.opts.interactive || ctx.opts.upgrade || state.analyticsSkipped;
    const done =
      GENERATED.every((n) => have.has(n)) &&
      (!pushKeys(ctx) || VAPID.every((n) => have.has(n))) &&
      (quiet || have.has(OPTIONAL));
    return done ? "done" : "todo";
  },
  async apply(state, ctx) {
    const have = await listSecrets(ctx);
    const missing = GENERATED.filter((n) => !have.has(n));
    if (ctx.opts.upgrade && missing.length)
      return {
        status: "action_required",
        message: `Worker secrets missing: ${missing.join(", ")}; --upgrade never generates them, run a full setup first (without --upgrade)`,
      };
    for (const n of GENERATED)
      if (!have.has(n)) await putSecret(ctx, n, random());
    const half = pushKeys(ctx) ? lonePublic(have) : undefined;
    if (half) return { status: "action_required", message: half };
    if (pushKeys(ctx) && !have.has(PUBLIC)) {
      // Keys go straight to wrangler's stdin: never to disk, argv or output.
      const pair = await generateVapidPair();
      // Private first: a run cut off between the two leaves a lone private key, which a rerun replaces.
      await putSecret(ctx, PRIVATE, pair.privateKey);
      await putSecret(ctx, PUBLIC, pair.publicKey);
    }
    const refuse = () =>
      ctx.notes.push(
        `${OPTIONAL} is the deploy token (same token id), not stored; create a dedicated read-only one: ${analyticsLink(ctx, state.accountId)}`,
      );
    const provided = envAnalytics(ctx);
    if (provided) {
      if (await reusesDeployToken(ctx, provided)) refuse();
      else await putSecret(ctx, OPTIONAL, provided);
      return undefined;
    }
    if (
      have.has(OPTIONAL) ||
      !ctx.opts.interactive ||
      ctx.opts.upgrade ||
      state.analyticsSkipped
    )
      return undefined;
    const q = `${OPTIONAL} for the Usage page (optional). Create a read-only token: ${analyticsLink(ctx, state.accountId)}\nPaste it (input hidden; Enter to skip):`;
    const v = await ctx.deps.prompt(q, { secret: true });
    if (v && (await reusesDeployToken(ctx, v))) refuse();
    else if (v) await putSecret(ctx, OPTIONAL, v);
    else state.analyticsSkipped = true;
    return undefined;
  },
};
