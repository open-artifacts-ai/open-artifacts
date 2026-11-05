import type { State } from "./state.ts";
import type { Ctx } from "./step.ts";
import { NeedInput } from "./step.ts";

export type Plan = "free" | "paid" | "unknown";
export type Warning = { code: string; plan: Plan; message: string };

export const DASH_PLANS =
  "https://dash.cloudflare.com/?to=/:account/workers/plans";

/** Workers rate plans that include Workers Paid (developers.cloudflare.com/tenant/reference/subscriptions). */
const PAID_IDS = new Set([
  "WORKERS_PAID",
  "PARTNERS_WORKERS_SS",
  "PARTNERS_WORKERS_ENT",
]);
/** Subscription states that are live; Cancelled, Failed, Expired, AwaitingPayment are not. */
const LIVE = new Set(["Paid", "Provisioned", "Trial"]);

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The Workers plan, read-only: every page of `GET /accounts/{id}/subscriptions`.
 * Paid when an item's `rate_plan.id` is a Workers Paid plan (WORKERS_PAID) and
 * its `state` is live; a Workers Paid item without a `state` is unknown. Needs
 * Billing Read (the `wrangler login` token lacks it): any error or a result of
 * the wrong shape is `unknown`, never a guess.
 */
export async function detectPlan(ctx: Ctx, accountId: string): Promise<Plan> {
  let subs: unknown[];
  try {
    subs = await ctx.api.all<unknown>(`/accounts/${accountId}/subscriptions`);
  } catch {
    return "unknown";
  }
  if (
    !subs.every(
      (s) => isObj(s) && (s.rate_plan === undefined || isObj(s.rate_plan)),
    )
  )
    return "unknown";
  const workers = (subs as Record<string, unknown>[]).filter((s) => {
    const id = (s.rate_plan as { id?: unknown } | undefined)?.id;
    return typeof id === "string" && PAID_IDS.has(id.toUpperCase());
  });
  if (workers.some((s) => LIVE.has(String(s.state)))) return "paid";
  if (workers.some((s) => s.state === undefined)) return "unknown";
  return "free";
}

/** What Workers Free means for this app; none on Paid. */
export function warnings(plan: Plan, paid = false): Warning[] {
  if (plan === "paid" || paid) return [];
  const w = (code: string, message: string) => ({ code, plan, message });
  return [
    ...(plan === "unknown"
      ? [
          w(
            "plan-unknown",
            "Setup couldn't read your Cloudflare plan, so here are the free-plan notes to be safe. If you're on Workers Paid, you can ignore them.",
          ),
        ]
      : []),
    w(
      "cpu-limit",
      "Cloudflare's free plan gives each request a small amount of processing time, so a very large publish can occasionally fail. Trying again usually works.",
    ),
    w(
      "kv-writes",
      "The free plan limits how many sign-ins can be saved each day. Connecting many AI agents, or reconnecting them often, can reach that limit until the next day.",
    ),
    w(
      "no-email",
      "The free plan can't send emails, so teammates won't get invite emails. You can share the invite link yourself.",
    ),
    w(
      "individual-use",
      "This setup suits one person. For a team, Cloudflare's Workers Paid plan ($5 a month) adds invite emails and more headroom.",
    ),
  ];
}

const yes = (a: string) => /^y(es)?$/i.test(a);

/**
 * Plan-dependent choices, once the plan is known; returns extra warnings.
 * Team: flag, then saved state, then the question; never guessed when setup
 * can't ask (except --check, which only reports). Team on Free (or unknown)
 * needs a confirmation; email needs Paid, --yes-paid, or (plan unknown only)
 * a saved yes, and a saved no holds until --team. Thumbnails (BROWSER +
 * SERVER_THUMBNAILS): flag, then Paid, then saved state only when the plan is
 * unknown.
 */
export async function decide(
  state: State,
  ctx: Ctx,
  plan: Plan,
): Promise<Warning[]> {
  const o = ctx.opts;
  const extra: Warning[] = [];
  let team = o.teamChoice;
  if (team === undefined && !o.check) {
    if (!o.interactive) throw new NeedInput("Pass --solo or --team");
    const q =
      plan === "paid"
        ? "Workers Paid detected. Just you, or a team? [solo/team] (team adds email invites):"
        : "Just you, or a team? [solo/team] (email invites need Workers Paid):";
    team = /^t(eam)?$/i.test(await ctx.deps.prompt(q));
    if (team && plan !== "paid")
      team = yes(
        await ctx.deps.prompt(
          `This account looks like Workers Free (plan: ${plan}), which is for individual use; invite email stays off unless you rerun with --yes-paid. Set up a team anyway? [y/N]`,
        ),
      );
  }
  // A saved --no-email (email off) holds on any plan until --team is passed again.
  const keptOff = !o.noEmail && !o.teamFlag && state.email === false;
  const email =
    Boolean(team) &&
    !o.noEmail &&
    !keptOff &&
    (plan === "paid" ||
      o.yesPaid ||
      (plan === "unknown" && state.email === true));
  if (team && !email && !o.noEmail && !keptOff)
    ctx.notes.push(
      `email off: Workers Paid not detected, so invites can't be sent. If the account is on Workers Paid (${DASH_PLANS}), rerun with --team --yes-paid`,
    );
  if (team && keptOff)
    ctx.notes.push(
      "email off (saved in state.json); rerun with --team to turn invites on",
    );
  if (team)
    ctx.notes.push(
      "team: every Access sign-in, viewers included, uses a Zero Trust seat. Free up to 50 users, then $7 per user per month for every user (see the self-hosting costs docs)",
    );
  const browser =
    o.browserFlag ??
    (plan === "paid" || o.yesPaid
      ? true
      : plan === "free"
        ? false
        : // Saved state: absent means on (state.ts), so an upgrade keeps it.
          (state.browser ?? (o.upgrade && !ctx.noState)));
  const planVar: "free" | "paid" =
    o.planFlag ??
    (plan === "paid" || o.yesPaid
      ? "paid"
      : plan === "unknown" && o.upgrade && state.planVar
        ? state.planVar
        : "free");
  if (o.browserFlag && plan !== "paid" && planVar !== "paid")
    extra.push({
      code: "browser-free",
      plan,
      message:
        "Thumbnails need Cloudflare's Workers Paid plan, so on the free plan they won't work even with --browser.",
    });
  o.planVar = planVar;
  o.team = Boolean(team);
  o.email = email;
  o.browser = browser;
  if (!o.team) o.emailDomain = undefined;
  // --check without a saved choice only reports: it leaves `team` unset.
  Object.assign(state, {
    plan,
    ...(team === undefined ? {} : { team }),
    email,
    emailDomain: o.emailDomain,
    browser,
  });
  return extra;
}
