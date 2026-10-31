import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import {
  type CreateInstallSchema,
  canonicalJson,
  checkCreateFields,
  slugError,
  type Tier,
} from "@oa/shared/provisioning";
import type { z } from "zod";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { newInstallId } from "../ids.js";
import type { Principal } from "../principal.js";
import { chargeSelfServeCreate } from "../services/counters.js";
import { accept, guard, replay, writeOf } from "../services/jobs.js";
import type { HandlerArgs } from "./handlers.js";
import type { RouteResult } from "./invoke.js";
import { slugHeld } from "./reads.js";
import { resolveRelease } from "./writes.js";

// R4 POST /installs (3.3, 3.6, 4.2, 7). One D1 batch writes the job, the
// signup, its secret, the lifecycle row, the account claim (self-serve) and
// the audit row; then admin, token and OIDC creates start ProvisionInstall,
// and self-serve ones go to the SIGNUPS queue, whose consumer admit()s them
// under the daily cap (7).

type Body = z.infer<typeof CreateInstallSchema>;

/**
 * What a self-serve principal carries beyond the C4 Principal: its Google
 * `hd`, and whether it is a staging OIDC test user. Set by authenticate()
 * (W5a, W5b); absent reads as no hd and not a test user.
 */
export type SelfServeFacts = { hd?: string; testUser?: boolean };

/** The canonical signups.vars (0007): never an email. */
export function signupVars(
  auth: { providers: readonly string[]; domains: readonly string[] },
  tier: Tier,
  testHooks: boolean,
): string {
  return canonicalJson({
    AUTH_PROVIDERS: auth.providers.join(","),
    AUTH_DOMAINS: auth.domains.join(","),
    TIER: tier,
    ...(testHooks ? { TEST_DOMAIN: STAGING_TEST_DOMAIN } : {}),
  });
}

const liveClaim = async (env: Env, sub: string) =>
  (await env.PLATFORM_DB.prepare(
    "SELECT 1 AS x FROM signup_accounts WHERE owner_sub = ? AND freed_at IS NULL",
  )
    .bind(sub)
    .first()) !== null;

function slugRule(slug: string) {
  const e = slugError(slug);
  if (e) throw new ApiError(e);
}

/** 4.2 self-serve policy, in order, after the forbidden fields. */
async function selfServePolicy(
  a: HandlerArgs,
  p: Principal & SelfServeFacts,
  body: Body,
): Promise<{ hd: string; email: string }> {
  const { env, surface } = a;
  const testUser = env.OA_ENV === "staging" && p.testUser === true;
  const admitted =
    env.SIGNUPS_ENABLED === "true" ||
    (env.SIGNUPS_ENABLED === "test-users" && testUser);
  if (!admitted) throw new ApiError("signups_closed");
  // Self-serve is HTTP only: /mcp answers a user 401 before this (4.2).
  if (surface.kind !== "http") throw new ApiError("forbidden");
  if (body.turnstile === undefined) throw new ApiError("turnstile_failed");
  const t = await env.PROVISIONER.verifyTurnstile({
    token: body.turnstile,
    remoteIp: surface.client.ip,
    action: "signup",
    hostname: surface.client.host,
    testUser,
  });
  if (!t.ok) throw new ApiError("turnstile_failed");
  if (!(await chargeSelfServeCreate(env, surface.client.ip)))
    throw new ApiError("rate_limited");
  // The one place the hd rule lives (4.2); Gmail owners wait for #864/#865.
  if (!p.hd || !p.email || !p.sub)
    throw new ApiError("forbidden", "a Google Workspace account is required");
  if (await liveClaim(env, p.sub)) throw new ApiError("signup_limit");
  return { hd: p.hd, email: p.email };
}

export async function createInstall(a: HandlerArgs): Promise<RouteResult> {
  const { env } = a;
  const p = a.principal as Principal & SelfServeFacts;
  const body = a.input.body as Body;
  if (p.kind === "system") throw new ApiError("forbidden");
  const f = checkCreateFields(body, p.kind, env.OA_ENV, STAGING_TEST_DOMAIN);
  if (f) throw new ApiError(f.code, `${f.field}: ${f.code}`);

  const w = await writeOf(env, p, a.surface, "R4", null, body);
  const prior = await replay(w);
  if (prior) return prior;

  const user = p.kind === "user";
  const ss = user ? await selfServePolicy(a, p, body) : null;
  slugRule(body.slug);
  const testHooks = body.testHooks === true;
  const version =
    body.version === undefined
      ? undefined
      : await resolveRelease(
          env,
          body.version,
          testHooks ? "redline" : "release",
        );
  if (await slugHeld(env, body.slug)) throw new ApiError("slug_taken");

  // checkCreateFields required these for every principal but U.
  const tier: Tier = ss ? env.SELF_SERVE_TIER : (body.tier as Tier);
  const auth = ss
    ? { providers: ["google"], domains: [ss.hd] }
    : (body.auth as NonNullable<Body["auth"]>);
  const ownerEmail = ss ? ss.email : (body.ownerEmail as string);
  const sendWelcome = ss ? true : body.sendWelcome === true;
  const ownerSub = ss ? (p.sub as string) : null;

  const now = Date.now();
  const installId = newInstallId();
  const db = env.PLATFORM_DB;
  // The signup's id is its first create job's id (0007).
  const after = (jobId: string): D1PreparedStatement[] => [
    db
      .prepare(
        `INSERT INTO signups (signup_id, source, owner_sub, slug, job_id, vars, version, test_hooks, send_welcome, status, admitted_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
      )
      .bind(
        jobId,
        ss ? "self-serve" : "admin",
        ownerSub,
        body.slug,
        signupVars(auth, tier, testHooks),
        version ?? null,
        testHooks ? 1 : 0,
        sendWelcome ? 1 : 0,
        // Admin, token and OIDC creates are admitted here; self-serve ones
        // by the consumer's admit() (5.2 step 1).
        ss ? "pending" : "queued",
        ss ? null : now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?1, ?2)",
      )
      .bind(jobId, ownerEmail),
    db
      .prepare(
        "INSERT INTO install_lifecycle (install_id, source, owner_sub, tier, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      )
      .bind(installId, ss ? "self-serve" : "admin", ownerSub, tier, now),
    // One live install per account (7): claim, or reclaim a freed row; the
    // guard aborts the batch when another signup holds the claim.
    ...(ownerSub
      ? [
          db
            .prepare(
              `INSERT INTO signup_accounts (owner_sub, signup_id, created_at) VALUES (?1, ?2, ?3)
ON CONFLICT (owner_sub) DO UPDATE SET signup_id = excluded.signup_id, created_at = excluded.created_at, freed_at = NULL
WHERE signup_accounts.freed_at IS NOT NULL`,
            )
            .bind(ownerSub, jobId, now),
          guard(
            env,
            "SELECT 1 FROM signup_accounts WHERE owner_sub = ? AND signup_id = ?",
            ownerSub,
            jobId,
          ),
        ]
      : []),
  ];
  return accept(w, {
    job: {
      kind: "create",
      installId,
      signupId: "self",
      args: version ? { version } : {},
    },
    after,
    onConflict: async () => {
      if (ownerSub && (await liveClaim(env, ownerSub)))
        throw new ApiError("signup_limit");
      throw new ApiError("slug_taken");
    },
    start: ss
      ? async (jobId) => {
          await env.SIGNUPS.send({ jobId });
        }
      : undefined,
  });
}
