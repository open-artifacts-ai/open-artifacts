import {
  AUTH,
  type AuthProviders,
  type FeatureFlag,
  type InstanceSignIn,
} from "@oa/shared";
import type { Env } from "../env.js";
import { type AuthConfig, authConfig } from "./config.js";

// What sign-in this install offers, for GET AUTH.providers and Me.instance.
// Config only: no D1, no session.

/** Starts Access sign-in from the SPA chooser in direct mode (AUTH.login otherwise goes to the chooser). */
export const ACCESS_START = `${AUTH.login}?via=access`;

export const signInMode = (cfg: AuthConfig): "access" | "direct" =>
  cfg.providers.has("google") || cfg.providers.has("email")
    ? "direct"
    : "access";

/**
 * Google is offered only on a complete transport: direct with its client
 * secret, or the broker with its URL, install id and signing key. (config.ts
 * already fails closed; this keeps a half-configured Google off the list.)
 */
export function googleOffered(cfg: AuthConfig): boolean {
  const t = cfg.google?.transport;
  if (!t) return false;
  if (t.kind === "direct") return t.secret.length > 0;
  return t.url.length > 0 && t.installId.length > 0 && t.signingKey.length > 0;
}

/** #359 AuthProvidersSchema: only enabled, fully configured providers. */
export function authProviders(env: Env): AuthProviders {
  const cfg = authConfig(env);
  const mode = signInMode(cfg);
  const providers: AuthProviders["providers"] = [];
  if (cfg.providers.has("access"))
    providers.push({
      id: "access",
      start: mode === "access" ? AUTH.login : ACCESS_START,
    });
  if (googleOffered(cfg))
    providers.push({
      id: "google",
      start: AUTH.loginGoogle,
      domains: [...cfg.domains],
    });
  // Only when codes can be sent (cfg.emailCodes): email on without email
  // sending is a problem the owner sees, not a code that never arrives.
  if (cfg.emailCodes)
    providers.push({
      id: "email",
      domainCodes: cfg.domainCodes,
      guests: true,
      ...(cfg.turnstile ? { turnstileSiteKey: cfg.turnstile.siteKey } : {}),
    });
  return { mode, providers };
}

/** Me.instance.signIn; with `owner`, also why configured sign-in is off (problems). */
export function instanceSignIn(env: Env, owner = false): InstanceSignIn {
  const p = authProviders(env);
  const out: InstanceSignIn = {
    mode: p.mode,
    providers: p.providers.map((x) => x.id),
  };
  if (owner) out.problems = [...authConfig(env).problems];
  return out;
}

/** Me.instance.features: FEATURES plus guests_read_only when the guest cap is on (reported only). */
export function instanceFeatures(env: Env): FeatureFlag[] {
  const cfg = authConfig(env);
  return cfg.guestsReadOnly
    ? [...cfg.features, "guests_read_only"]
    : [...cfg.features];
}

/** Hosted sign-in fields appear in Me only on hosted or direct-sign-in installs. */
export const showsSignInFields = (env: Env): boolean =>
  env.HOSTED === "1" || signInMode(authConfig(env)) === "direct";
