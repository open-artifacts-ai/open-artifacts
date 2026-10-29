// ProvisionInstall: one admitted signup becomes one hosted install and at
// most one welcome email. Instance id = signup id; params are the stored
// row's { signupId, slug, ownerSub }. The owner's email is read from
// signup_secret inside the steps that need it and never leaves them: no step
// output, error, log line or param carries it.
//
// 1. reserve: the install id, picked once and stored on the row (a rerun
//    reads it back), and the row's stored slug; status creating.
// 2. create: each attempt sweeps first (an ss-<signupId> owner token a
//    crashed attempt left), then WfpProvisioner.create with the reserved
//    install id and the stored slug (a rerun resumes it; an install already
//    active under it is done). A lease-held refusal retries past LEASE_MS;
//    every other refusal is terminal; any other error retries.
// 3. notify: claim the welcome (a conditional write); send only on the claim.
// 4. done: sweep again, delete signup_secret, status ready.
// Each failing attempt writes its category to the row's error (status
// unchanged); a step that fails for good ends in the `fail` step, which
// sweeps and sets status failed, keeping that error. Every decision is read
// from D1, never from instance state, so a replay ends the same way.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  cfClient,
  type Env as DeployEnv,
  HOSTED_DOMAINS,
  isReleaseVersion,
  NAMESPACES,
  newInstallId,
  r2BindingReleaseReader,
  WfpProvisioner,
} from "@oa/provision";
import { categoryOf, classify, stepError } from "./errors.js";
import type { ProvisionParams } from "./message.js";
import { welcomeEmail } from "./welcome.js";

export interface WorkflowEnv {
  PLATFORM_DB: D1Database;
  RELEASES: R2Bucket;
  WELCOME_EMAIL: SendEmail;
  PROVISION_TOKEN: SecretsStoreSecret;
  /** "staging" or "prod"; anything else fails the signup (internal). */
  OA_ENV: string;
  /** The release every signup gets (bundle "release"). */
  RELEASE_VERSION: string;
  WELCOME_FROM: string;
  ACCOUNT_ID: string;
}

/**
 * Retries 10 + 20 + 40 + 80 + 160 + 320 minutes: far past create's 30-minute
 * lease. An attempt may run past the lease (it renews it) but not past 45.
 */
const CREATE_STEP = {
  retries: { limit: 6, delay: "10 minutes", backoff: "exponential" },
  timeout: "45 minutes",
} as const;

/** A stable release (no prerelease or build suffix). */
const STABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

// Fixed categories and the signup id only.
const log = (signupId: string, step: string, outcome: string) =>
  console.log(JSON.stringify({ event: "provision", signupId, step, outcome }));

const SECRET_EMAIL =
  "SELECT owner_email AS email FROM signup_secret WHERE signup_id = ?";

/** A config or state error no retry fixes. */
const internal = () => new NonRetryableError("internal");

/** A D1 or Secrets Store binding failed: retried, as `internal`. */
class Transient extends Error {}
const transient = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch {
    throw new Transient("internal");
  }
};

export class ProvisionInstall extends WorkflowEntrypoint<
  WorkflowEnv,
  ProvisionParams
> {
  // The runtime's network and clock; the tests' subclass runs on fake-cf's.
  protected fetch: typeof fetch = (input, init) => fetch(input, init);
  protected now: () => number = () => Date.now();
  protected sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  async run(
    event: Readonly<WorkflowEvent<ProvisionParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    const { signupId } = event.payload;
    const label = `ss-${signupId}`;
    try {
      const { installId, slug } = await step.do("reserve", () =>
        this.guard(signupId, "reserve", () => this.reserve(signupId)),
      );
      const { appHost } = await step.do("create", CREATE_STEP, () =>
        this.create(signupId, slug, installId, label),
      );
      await step.do("notify", () =>
        this.guard(signupId, "notify", () => this.notify(signupId, appHost)),
      );
      await step.do("done", () =>
        this.guard(signupId, "done", () =>
          this.done(signupId, installId, label),
        ),
      );
      log(signupId, "run", "ready");
    } catch (e) {
      // e is the engine's error (a NonRetryableError arrives without its
      // message): the category is the one the failing attempt stored.
      await step.do("fail", async () => {
        try {
          return await this.fail(signupId, label);
        } catch (f) {
          // Retried; never overwrites the stored category.
          throw new Error(classify(f).category);
        }
      });
      log(signupId, "run", "failed");
      throw e;
    }
  }

  private get db(): D1Database {
    return this.env.PLATFORM_DB;
  }

  /** The owner's email (SS4 wrote it); null once done has deleted it. */
  private async ownerEmail(signupId: string): Promise<string | null> {
    const r = await this.db
      .prepare(SECRET_EMAIL)
      .bind(signupId)
      .first<{ email: string }>();
    return r?.email ?? null;
  }

  /**
   * A step other than create: its error leaves as its category only.
   * Terminal refusals and config errors stay terminal; anything else (a D1,
   * Cloudflare or email binding error) is retried.
   */
  private async guard<T>(
    signupId: string,
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NonRetryableError)
        throw await this.failed(signupId, name, e);
      const { category } = classify(e);
      throw await this.failed(
        signupId,
        name,
        category === "slug_taken" || category === "refused"
          ? new NonRetryableError(category)
          : new Error(category),
      );
    }
  }

  /**
   * Logs a step's error (already only a category) and stores it on the row,
   * status unchanged, so the fail step reads it. Best effort: a D1 that
   * fails here fails the fail step too, which retries.
   */
  private async failed(
    signupId: string,
    name: string,
    err: Error,
  ): Promise<Error> {
    const category = categoryOf(err);
    log(signupId, name, category);
    await this.db
      .prepare(
        "UPDATE signups SET error = ?1, updated_at = ?2 WHERE signup_id = ?3 AND status <> 'ready'",
      )
      .bind(category, this.now(), signupId)
      .run()
      .catch(() => {});
    return err;
  }

  /**
   * The end of a failed run: the signup is failed with the error its last
   * attempt stored (internal if none was), then its ss- tokens are swept.
   */
  private async fail(
    signupId: string,
    label: string,
  ): Promise<{ failed: boolean }> {
    const r = await this.db
      .prepare(
        "UPDATE signups SET status = 'failed', error = COALESCE(error, 'internal'), updated_at = ?1 WHERE signup_id = ?2 AND status <> 'ready' RETURNING install_id",
      )
      .bind(this.now(), signupId)
      .first<{ install_id: string | null }>();
    if (r?.install_id) {
      // A bad env var means no install was ever made under it.
      let ok = true;
      try {
        this.config();
      } catch {
        ok = false;
      }
      if (ok) await this.sweep(r.install_id, label);
    }
    return { failed: r !== null };
  }

  /** The env and release, from vars; never guessed. */
  private config(): { env: DeployEnv; version: string } {
    const env = this.env.OA_ENV;
    if (env !== "staging" && env !== "prod") throw internal();
    const version = this.env.RELEASE_VERSION;
    if (
      typeof version !== "string" ||
      !STABLE_VERSION.test(version) ||
      !isReleaseVersion(version)
    )
      throw internal();
    return { env, version };
  }

  private async provisioner(
    env: DeployEnv,
    label: string,
  ): Promise<WfpProvisioner> {
    const token = await transient(this.env.PROVISION_TOKEN.get());
    return new WfpProvisioner({
      cf: cfClient({
        accountId: this.env.ACCOUNT_ID,
        token,
        fetch: this.fetch,
        sleep: this.sleep,
      }),
      env,
      target: { kind: "namespace", ns: NAMESPACES[env] },
      domains: HOSTED_DOMAINS[env],
      release: r2BindingReleaseReader(this.env.RELEASES, env),
      ciOwnerToken: { label },
      requireInstallId: true,
      fetch: this.fetch,
      now: this.now,
      sleep: this.sleep,
    });
  }

  /**
   * The row's install id, set once (only while NULL), and its stored slug
   * (never the event's); status creating.
   */
  private async reserve(
    signupId: string,
  ): Promise<{ installId: string; slug: string }> {
    this.config();
    const r = await this.db
      .prepare(
        `UPDATE signups SET install_id = COALESCE(install_id, ?1),
           status = CASE status WHEN 'ready' THEN 'ready' ELSE 'creating' END,
           error = NULL, updated_at = ?2
         WHERE signup_id = ?3 AND status IN ('queued', 'creating', 'failed', 'ready')
         RETURNING install_id, slug`,
      )
      .bind(newInstallId(), this.now(), signupId)
      .first<{ install_id: string; slug: string }>();
    // No row, or one never admitted: the consumer starts neither.
    if (!r) throw internal();
    return { installId: r.install_id, slug: r.slug };
  }

  /** Revokes the install's active ss-<signupId> tokens; none before it exists. */
  private async sweep(
    installId: string,
    label: string,
  ): Promise<{ revoked: number }> {
    const { env } = this.config();
    const row = await transient(
      this.db
        .prepare("SELECT 1 AS x FROM installs WHERE id = ?")
        .bind(installId)
        .first(),
    );
    if (!row) return { revoked: 0 };
    const p = await this.provisioner(env, label);
    const { revoked } = await p.ciTokenSweep(installId, label);
    return { revoked };
  }

  private async create(
    signupId: string,
    slug: string,
    installId: string,
    label: string,
  ): Promise<{ appHost: string }> {
    let email: string | null = null;
    try {
      const { env, version } = this.config();
      // A crashed attempt's token goes first, even if this attempt then
      // fails for good.
      await this.sweep(installId, label);
      // A rerun after create finished: the install is already this signup's.
      const have = await transient(
        this.db
          .prepare(
            "SELECT app_host FROM installs WHERE id = ?1 AND slug = ?2 AND state = 'active'",
          )
          .bind(installId, slug)
          .first<{ app_host: string }>(),
      );
      if (have) return { appHost: have.app_host };
      email = await transient(this.ownerEmail(signupId));
      if (email === null) throw internal();
      const p = await this.provisioner(env, label);
      const inst = await p.create({
        slug,
        ownerEmail: email,
        plan: "paid",
        vars: {},
        bundle: "release",
        version,
        installId,
      });
      return { appHost: inst.appHost };
    } catch (e) {
      throw await this.failed(
        signupId,
        "create",
        e instanceof NonRetryableError
          ? e
          : e instanceof Transient
            ? new Error("internal")
            : stepError(e, email),
      );
    }
  }

  /** At most one welcome: only the run whose claim changed the row sends. */
  private async notify(
    signupId: string,
    appHost: string,
  ): Promise<{ sent: boolean }> {
    const claim = await this.db
      .prepare(
        "UPDATE signups SET welcome_claimed_at = ? WHERE signup_id = ? AND welcome_claimed_at IS NULL",
      )
      .bind(this.now(), signupId)
      .run();
    if (claim.meta.changes !== 1) return { sent: false };
    const to = await this.ownerEmail(signupId);
    // Claimed, never sent: the scheduler's "welcome unsent" alert says so.
    if (to === null) throw internal();
    await this.env.WELCOME_EMAIL.send(
      welcomeEmail({ from: this.env.WELCOME_FROM, to, appHost }),
    );
    await this.db
      .prepare(
        "UPDATE signups SET welcome_sent_at = ?1, updated_at = ?1 WHERE signup_id = ?2",
      )
      .bind(this.now(), signupId)
      .run();
    return { sent: true };
  }

  private async done(
    signupId: string,
    installId: string,
    label: string,
  ): Promise<{ ready: true }> {
    await this.sweep(installId, label);
    await this.db.batch([
      this.db
        .prepare("DELETE FROM signup_secret WHERE signup_id = ?")
        .bind(signupId),
      this.db
        .prepare(
          "UPDATE signups SET status = 'ready', error = NULL, updated_at = ? WHERE signup_id = ?",
        )
        .bind(this.now(), signupId),
    ]);
    return { ready: true };
  }
}
