// ProvisionInstall: one admitted signup becomes one hosted install and at
// most one welcome email. Instance id = signup id; params are the stored
// row's { signupId, slug, ownerSub }. The owner's email is read from
// signup_secret inside the steps that need it and never leaves them: no step
// output, error, log line or param carries it.
//
// 1. reserve: the install id, picked once and stored on the row (a rerun
//    reads it back); status creating.
// 2. sweep: revoke an ss-<signupId> owner token a crashed attempt left.
// 3. create: WfpProvisioner.create with the reserved install id (a rerun
//    resumes it; an install already active under it is done). A lease-held
//    refusal retries past LEASE_MS; every other refusal is terminal.
// 4. notify: claim the welcome (a conditional write); send only on the claim.
// 5. done: sweep again, delete signup_secret, status ready.
// A step that fails for good leaves the signup failed with its category.
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
import { type Category, categoryOf, classify, stepError } from "./errors.js";
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

/** 10 + 20 + 40 + 80 + 160 + 320 minutes: far past create's 30-minute lease. */
const CREATE_STEP = {
  retries: { limit: 6, delay: "10 minutes", backoff: "exponential" },
} as const;

// Fixed categories and the signup id only.
const log = (signupId: string, step: string, outcome: string) =>
  console.log(JSON.stringify({ event: "provision", signupId, step, outcome }));

const SECRET_EMAIL =
  "SELECT owner_email AS email FROM signup_secret WHERE signup_id = ?";

/** A config or state error no retry fixes. */
const internal = () => new NonRetryableError("internal");

export class ProvisionInstall extends WorkflowEntrypoint<
  WorkflowEnv,
  ProvisionParams
> {
  // The runtime's network and clock; the tests' subclass runs on fake-cf's.
  protected fetch: typeof fetch = (input, init) => fetch(input, init);
  protected now: () => number = () => Date.now();
  protected sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  /**
   * The category of this run's last step error: a NonRetryableError reaches
   * run() as the engine's own error, without its message.
   */
  private failure: Category | null = null;

  async run(
    event: Readonly<WorkflowEvent<ProvisionParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    const { signupId, slug } = event.payload;
    const label = `ss-${signupId}`;
    try {
      const { installId } = await step.do("reserve", () =>
        this.guard(signupId, "reserve", () => this.reserve(signupId)),
      );
      await step.do("sweep", () =>
        this.guard(signupId, "sweep", () => this.sweep(installId, label)),
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
      // Idempotent: a replay of run() after the failure writes the same.
      await this.db
        .prepare(
          "UPDATE signups SET status = 'failed', error = ?1, updated_at = ?2 WHERE signup_id = ?3 AND status <> 'ready'",
        )
        .bind(this.failure ?? categoryOf(e), this.now(), signupId)
        .run();
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
      if (e instanceof NonRetryableError) throw this.failed(signupId, name, e);
      const { category } = classify(e);
      throw this.failed(
        signupId,
        name,
        category === "slug_taken" || category === "refused"
          ? new NonRetryableError(category)
          : new Error(category),
      );
    }
  }

  /** Logs and records a step's error (already only a category). */
  private failed(signupId: string, name: string, err: Error): Error {
    this.failure = categoryOf(err);
    log(signupId, name, this.failure);
    return err;
  }

  /** The env and release, from vars; never guessed. */
  private config(): { env: DeployEnv; version: string } {
    const env = this.env.OA_ENV;
    if (env !== "staging" && env !== "prod") throw internal();
    const version = this.env.RELEASE_VERSION;
    if (typeof version !== "string" || !isReleaseVersion(version))
      throw internal();
    return { env, version };
  }

  private async provisioner(
    env: DeployEnv,
    label: string,
  ): Promise<WfpProvisioner> {
    const token = await this.env.PROVISION_TOKEN.get();
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

  /** The row's install id, set once (only while NULL); status creating. */
  private async reserve(signupId: string): Promise<{ installId: string }> {
    this.config();
    const r = await this.db
      .prepare(
        `UPDATE signups SET install_id = COALESCE(install_id, ?1),
           status = CASE status WHEN 'ready' THEN 'ready' ELSE 'creating' END,
           error = NULL, updated_at = ?2
         WHERE signup_id = ?3 AND status IN ('queued', 'creating', 'failed', 'ready')
         RETURNING install_id`,
      )
      .bind(newInstallId(), this.now(), signupId)
      .first<{ install_id: string }>();
    // No row, or one never admitted: the consumer starts neither.
    if (!r) throw internal();
    return { installId: r.install_id };
  }

  /** Revokes the install's active ss-<signupId> tokens; none before it exists. */
  private async sweep(
    installId: string,
    label: string,
  ): Promise<{ revoked: number }> {
    const { env } = this.config();
    const row = await this.db
      .prepare("SELECT 1 AS x FROM installs WHERE id = ?")
      .bind(installId)
      .first();
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
      // A rerun after create finished: the install is already this signup's.
      const have = await this.db
        .prepare(
          "SELECT app_host FROM installs WHERE id = ?1 AND slug = ?2 AND state = 'active'",
        )
        .bind(installId, slug)
        .first<{ app_host: string }>();
      if (have) return { appHost: have.app_host };
      email = await this.ownerEmail(signupId);
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
      throw this.failed(
        signupId,
        "create",
        e instanceof NonRetryableError ? e : stepError(e, email),
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
