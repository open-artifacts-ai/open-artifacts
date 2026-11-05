// Shared by the billing tests: a hosted install and a fake BillingGate that
// answers as oa-<p>-billing (#849) does, checking each signed POST's
// signature over the route path and the exact body text.
import { env } from "cloudflare:workers";
import { publicFromPkcs8, verifyRequest } from "@oa/auth-core";
import type { BillingStatus, BillingTier } from "@oa/shared";
import { createApp } from "../src/app.js";
import { storePlan } from "../src/billing/store.js";
import type { Env } from "../src/env.js";
import { TEST_BROKER_KEY } from "./auth-helpers.js";
import { fetchAndWait } from "./helpers.js";

export const DAY = 86_400_000;
export const INSTALL = "ibilltest0001";

/** A hosted install with spaces on and no provisioned TIER. */
export const H = {
  ...(env as object),
  HOSTED: "1",
  INSTALL_ID: INSTALL,
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  FEATURES: "spaces,content_revocation",
  TIER: undefined,
} as unknown as Env;

export type BillingRow = {
  tier: BillingTier;
  status: BillingStatus;
  trialEndsAt: number | null;
  graceUntil: number | null;
  version: number;
};
export type BillingCall = {
  path: string;
  body: Record<string, unknown> | null;
  status: number;
};

/** A fake billing behind a fake gate. `row` is the install's tier row. */
export function fakeBilling(install = INSTALL) {
  const s = {
    row: {
      tier: "business",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 1,
    } as BillingRow,
    calls: [] as BillingCall[],
    down: false,
  };
  let x: Promise<string> | null = null;
  const answer = (
    path: string,
    body: Record<string, unknown> | null,
    r: Response,
  ) => {
    s.calls.push({ path, body, status: r.status });
    return r;
  };
  const gate = {
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (s.down) throw new Error("Network connection lost");
      if (req.method === "GET")
        return answer(
          path,
          null,
          path === "/tier"
            ? Response.json({ ...s.row, asOf: Date.now() })
            : new Response("nf", { status: 404 }),
        );
      const text = await req.text();
      x ??= publicFromPkcs8(TEST_BROKER_KEY);
      const ok = await verifyRequest(
        await x,
        path,
        req.headers.get("x-oa-kid") ?? "",
        text,
        req.headers.get("x-oa-sig") ?? "",
      );
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!ok)
        return answer(
          path,
          body,
          Response.json({ error: "bad_signature" }, { status: 401 }),
        );
      // The gate's own check: the body names the gate's install only.
      if (body.install !== install)
        return answer(
          path,
          body,
          Response.json(
            { error: "install_mismatch" },
            { status: 403, headers: { "x-oa-gate": "1" } },
          ),
        );
      if (path === "/trial/start") {
        if (s.row.tier === "free" && s.row.trialEndsAt === null)
          s.row = {
            ...s.row,
            tier: "trial",
            trialEndsAt: Date.now() + 14 * DAY,
            version: s.row.version + 1,
          };
        return answer(
          path,
          body,
          Response.json({ ...s.row, asOf: Date.now() }),
        );
      }
      if (path === "/usage")
        return answer(
          path,
          body,
          Response.json({ ok: true, month: body.month, count: body.count }),
        );
      if (path === "/checkout")
        return answer(
          path,
          body,
          Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
        );
      if (path === "/portal")
        return answer(
          path,
          body,
          Response.json({ url: "https://billing.stripe.com/p/session/test_1" }),
        );
      return answer(path, body, new Response("nf", { status: 404 }));
    },
  };
  return { s, gate, props: { BILLING: gate } };
}

const app = createApp();

/** One app request as `auth` (a cookie or a PAT), with the CSRF header unless csrf: false. */
export function send(
  props: Record<string, unknown>,
  path: string,
  auth: string | null,
  init: {
    method?: string;
    body?: unknown;
    raw?: string;
    e?: Env;
    csrf?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.csrf !== false) headers["x-oa-request"] = "1";
  if (auth?.startsWith("oa_pat_")) headers.authorization = `Bearer ${auth}`;
  else if (auth) headers.cookie = auth;
  const body =
    init.raw ??
    (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    }),
    init.e ?? H,
    props,
  );
}

/** Caches a billing answer now (the version rule applies). */
export const cachePlan = (row: BillingRow, now = Date.now(), e: Env = H) =>
  storePlan(e, { ...row, asOf: now }, now);

/** Drops every billing setting and creator row. */
export async function clearBilling() {
  await env.DB.prepare("delete from settings where key like 'billing.%'").run();
  await env.DB.prepare("delete from creator_months").run();
}
