// The audit action names and the verbs the admin log shows for them (#1353).
// No imports on purpose: the root suite's audit-actions.test.ts checks these
// against the code that writes them, and a module that pulls in React or the
// UI kit cannot be typechecked by the root tsconfig.

/**
 * Design's sentence verb for each action the API and the provisioner write,
 * past tense (it's a log). The Action filter offers AUDIT_ACTIONS, a subset;
 * audit-actions.test.ts checks those against the code that writes them, so
 * an option can't return nothing.
 */
const VERB: Record<string, string> = {
  "job.accepted": "started a job",
  "job.replayed": "replayed a job",
  "job.refused": "had a job refused",
  "job.canceled": "canceled a job",
  "job.done": "finished a job",
  "job.failed": "had a job fail",
  "authz.refused": "was refused",
  "signin.ok": "signed in",
  "signin.refused": "couldn't sign in",
  "session.logout": "signed out",
  "token.mint": "minted a token",
  "token.used": "used a token",
  "token.revoke": "revoked a token",
  "token.revoke_all": "revoked every token",
  "oauth.grant": "approved an agent",
  "oauth.denied": "denied an agent",
  "oauth.refresh_refused": "had a token refresh refused",
  "oauth.client_expired": "had an agent client expire",
  "test_admin.session": "started a test admin session",
  // The provisioner's step rows (#1136); job.done and job.failed sum them up.
  "create.start": "started creating the install",
  "create.resume": "resumed creating the install",
  "create.upload": "uploaded the app",
  "create.broker": "registered the sign-in key",
  "create.active": "made the install live",
  "upgrade.start": "started an upgrade",
  "upgrade.held": "held an upgrade",
  "upgrade.restore_point": "saved a restore point",
  "upgrade.done": "finished an upgrade",
  "upgrade.failed": "had an upgrade fail",
  "upgrade.incomplete": "left an upgrade unfinished",
  "upgrade.forward_fix": "flagged an upgrade for a forward fix",
  "rollback.start": "started a rollback",
  "rollback.selftest_skipped": "skipped the rollback self-test",
  "rollback.done": "finished a rollback",
  "rollback.incomplete": "left a rollback unfinished",
  "rollback.unhealthy": "rolled back to an unhealthy version",
  "vars.start": "started changing settings",
  "vars.done": "changed settings",
  "vars.failed": "couldn't change settings",
  "vars.session_cut": "signed everyone out",
  "vars.session_cut_failed": "couldn't sign everyone out",
  "vars.session_cut_dropped": "skipped a sign-out it no longer needed",
  "verify_clean.refused": "failed the clean check",
  "verify_clean.retry":
    "waited for Cloudflare to show the install's settings, then checked again",
  "verify_clean.binding_ids":
    "checked that its bindings point at its own resources",
  "prod_dirty.snapshot":
    "recorded what the install was running when it failed the clean check",
  "delete.start": "started deleting the install",
  "delete.unmap_stale": "removed stale hosts",
  "delete.revoke_pending": "waited to revoke Google access",
  "delete.revoke_skipped": "skipped revoking Google access",
  "delete.revoke_unsupported": "couldn't revoke Google access",
  "delete.done": "deleted the install",
  "lease.release": "released the lock",
  "lease.force_release": "forced the lock open",
  "lease.release_refused": "couldn't release the lock",
  "ci_token.mint": "minted a deploy token",
  "ci_token.revoke": "revoked a deploy token",
  "ci_token.sweep": "cleared old deploy tokens",
  "owner_token.reissue": "reissued the owner's token",
  "turnstile.rotate": "rotated the bot-check keys",
  "oauth_store.mode_live": "switched where agent sign-ins are stored",
  "oauth_copy.counts": "counted agent sign-ins to move",
  "oauth_copy.key_gone": "removed the key for moving agent sign-ins",
  "fleet.halted": "halted the fleet rollout",
  // Anonymous refusals, counted per bucket (audit_refusals); signin.refused is above.
  rate_limited: "were rate limited",
};
/**
 * The operations a held lock names (`<op>.lost_lease`, `<op>.aborted`).
 * owner_token is the writer's spelling; owner-token stays for older rows.
 */
const LOCK_OPS = [
  "create",
  "upgrade",
  "rollback",
  "vars",
  "turnstile",
  "delete",
  "suspend",
  "resume",
  "restore",
  "owner-token",
  "owner_token",
];
/**
 * The job kinds that call setMode, whose HOSTS row is `<kind>.hosts` with
 * {mode}: the row reads by its mode (hostsPhrase), the filter by this.
 */
const HOST_KINDS = ["suspend", "resume", "delete", "restore"];
export const HOSTS_CHANGED = "changed the install's hosts";
for (const kind of HOST_KINDS) VERB[`${kind}.hosts`] = HOSTS_CHANGED;
export const HOSTS_BY_MODE: Record<string, string> = {
  serving: "brought the install back online",
  paused: "took the install offline",
  closed: "closed the install",
};
for (const op of LOCK_OPS) {
  VERB[`${op}.lost_lease`] = "lost its lock";
  VERB[`${op}.aborted`] = "stopped partway";
}
/** Why an anonymous call was refused, by audit_refusals bucket (refuse.ts' callers). */
export const REFUSAL_REASON: Record<string, string> = {
  pre: "too many requests",
  auth: "not signed in",
  csrf: "failed cross-site check",
  oauth: "at agent sign-in",
  oauth_register: "at agent registration",
};
for (const [bucket, why] of Object.entries(REFUSAL_REASON))
  VERB[`${bucket}.refused`] = `were refused (${why})`;
/** A refusal row with a bucket nobody mapped: the outcome, no raw name. */
export const REFUSED = "were refused";

/**
 * Each action the Action filter offers, as written by the API, the
 * provisioner and the scheduler (audit-actions.test.ts checks it).
 */
export const AUDIT_ACTIONS = [
  "job.accepted",
  "job.replayed",
  "job.refused",
  "job.canceled",
  "job.done",
  "job.failed",
  "authz.refused",
  "signin.ok",
  "signin.refused",
  "session.logout",
  "token.mint",
  "token.used",
  "token.revoke",
  "token.revoke_all",
  "oauth.grant",
  "oauth.denied",
  "oauth.refresh_refused",
  "oauth.client_expired",
  "test_admin.session",
  "upgrade.held",
  "upgrade.forward_fix",
  "rollback.unhealthy",
  "lease.force_release",
  "fleet.halted",
  "prod_dirty.snapshot",
  "delete.revoke_unsupported",
  "vars.session_cut_failed",
  ...Object.keys(REFUSAL_REASON).map((b) => `${b}.refused`),
  "rate_limited",
];

/** Design's sentence verb for a known action; the raw action name otherwise. */
export const actionPhrase = (action: string) =>
  Object.hasOwn(VERB, action) ? VERB[action] : action;
