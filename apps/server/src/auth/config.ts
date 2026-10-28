import { parseDomains } from "@oa/auth-core";
import { type FeatureFlag, parseFeatures } from "@oa/shared";
import type { Env } from "../env.js";
import { b64urlDecode } from "../util/crypto.js";

/** Redirect (OIDC) sign-in providers. Codes ("email") aren't one. */
export type ProviderId = "access" | "google";
export type SignInProvider = ProviderId | "email";

export type GoogleTransport =
  | { kind: "direct"; secret: string }
  | { kind: "broker"; url: string; installId: string; signingKey: string };

export type AuthConfig = {
  /** Enabled sign-in methods. Unset AUTH_PROVIDERS: access only. */
  providers: ReadonlySet<SignInProvider>;
  /** Verified domains (lowercase): the Google `hd` allow-list and code domains. */
  domains: readonly string[];
  domainJoin: "member" | "invite";
  /** Domain members may use emailed codes (trial): needs email, no google, Turnstile, domains. */
  domainCodes: boolean;
  /**
   * Email sign-in codes are offered: email is in AUTH_PROVIDERS and the install
   * can send email (EMAIL and EMAIL_FROM). Email on without them is a problem,
   * never a code request that silently sends nothing.
   */
  emailCodes: boolean;
  /** Guests capped at viewer: whenever google or email is on. Not configurable. */
  guestsReadOnly: boolean;
  features: FeatureFlag[];
  /** Null unless google is enabled and fully configured (fail closed). */
  google: { clientId: string; transport: GoogleTransport } | null;
  turnstile: { siteKey: string; secret: string } | null;
  codeEmailsPerDay: number;
  /** INSTALL_ID, else APP_HOST: the install part of rate-limit keys. */
  installKey: string;
  /**
   * Why something configured is off: full sentences saying what to do (shown
   * verbatim to owners, Me.instance.signIn.problems). Never secret values.
   */
  problems: string[];
};

const PROVIDERS: readonly SignInProvider[] = ["access", "google", "email"];
const CODE_EMAILS_DEFAULT = 200;
const CODE_EMAILS_MAX = 10_000;
// DER prefix of a PKCS#8 Ed25519 private key (RFC 8410); 16 + 32 bytes.
const PKCS8_ED25519 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
];

const nonEmpty = (v: string | undefined): v is string =>
  typeof v === "string" && v.trim() !== "";

/** A PKCS#8 Ed25519 private key (base64url): the broker signing key's shape. */
export function isEd25519Pkcs8(v: string): boolean {
  const raw = b64urlDecode(v);
  return (
    raw !== null &&
    raw.length === PKCS8_ED25519.length + 32 &&
    PKCS8_ED25519.every((b, i) => raw[i] === b)
  );
}

function intIn(v: string | undefined, min: number, max: number): number | null {
  if (!v || !/^[1-9]\d*$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

function parseProviders(
  raw: string | undefined,
  problems: string[],
): Set<SignInProvider> {
  if (raw === undefined) return new Set(["access"]);
  const out = new Set<SignInProvider>();
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if ((PROVIDERS as readonly string[]).includes(p))
      out.add(p as SignInProvider);
    else
      problems.push(
        `AUTH_PROVIDERS lists "${p}", which isn't a sign-in method, so it's ignored. Use access, google or email.`,
      );
  }
  return out;
}

function googleConfig(
  env: Env,
  domains: readonly string[],
  problems: string[],
): AuthConfig["google"] {
  // "Google sign-in is on, but <why>, so Google isn't offered. <todo>."
  const fail = (why: string, todo: string) => {
    problems.push(
      `Google sign-in is on, but ${why}, so Google isn't offered. ${todo}.`,
    );
    return null;
  };
  if (!nonEmpty(env.GOOGLE_CLIENT_ID))
    return fail(
      "GOOGLE_CLIENT_ID isn't set",
      "Set it, or turn Google sign-in off",
    );
  if (domains.length === 0)
    return fail(
      "AUTH_DOMAINS is empty",
      "Set the Google Workspace domains that may sign in",
    );
  const clientId = env.GOOGLE_CLIENT_ID.trim();
  // Hosted installs never hold the shared Google client secret: the broker
  // alone does the code exchange. Fail closed, and never fall back to direct
  // or honour a tenant-supplied GOOGLE_CLIENT_SECRET.
  if (env.HOSTED === "1" && !nonEmpty(env.AUTH_BROKER_URL))
    return fail(
      "a hosted install needs the broker transport and AUTH_BROKER_URL isn't set",
      "Set AUTH_BROKER_URL to the sign-in broker",
    );
  if (nonEmpty(env.AUTH_BROKER_URL)) {
    let url: URL;
    try {
      url = new URL(env.AUTH_BROKER_URL);
    } catch {
      return fail(
        "AUTH_BROKER_URL isn't a URL",
        "Set it to the broker's https address",
      );
    }
    if (url.protocol !== "https:")
      return fail(
        "AUTH_BROKER_URL isn't https",
        "Use the broker's https address",
      );
    if (!nonEmpty(env.INSTALL_ID))
      return fail(
        "INSTALL_ID isn't set and the broker needs it",
        "Set INSTALL_ID to this install's id",
      );
    if (
      !nonEmpty(env.BROKER_SIGNING_KEY) ||
      !isEd25519Pkcs8(env.BROKER_SIGNING_KEY)
    )
      return fail(
        "BROKER_SIGNING_KEY isn't a PKCS#8 Ed25519 key",
        "Set the key the broker registered for this install",
      );
    return {
      clientId,
      transport: {
        kind: "broker",
        url: url.origin,
        installId: env.INSTALL_ID.trim(),
        signingKey: env.BROKER_SIGNING_KEY,
      },
    };
  }
  if (!nonEmpty(env.GOOGLE_CLIENT_SECRET))
    return fail(
      "GOOGLE_CLIENT_SECRET isn't set",
      "Set it, or turn Google sign-in off",
    );
  return {
    clientId,
    transport: { kind: "direct", secret: env.GOOGLE_CLIENT_SECRET },
  };
}

/** Hosted installs never admit by domain: their AUTH_DOMAINS aren't proven owned (M1). */
function domainJoin(env: Env, problems: string[]): AuthConfig["domainJoin"] {
  const join = env.AUTH_DOMAIN_JOIN === "member" ? "member" : "invite";
  if (env.HOSTED === "1" && join === "member") {
    problems.push(
      'AUTH_DOMAIN_JOIN is "member", but a hosted install admits people by invite only, so invites apply.',
    );
    return "invite";
  }
  return join;
}

function build(env: Env): AuthConfig {
  const problems: string[] = [];
  const providers = parseProviders(env.AUTH_PROVIDERS, problems);
  const parsed = parseDomains(env.AUTH_DOMAINS ?? "");
  for (const d of parsed.invalid)
    problems.push(
      `AUTH_DOMAINS has "${d}", which isn't a valid domain, so it's ignored. Fix or remove it.`,
    );
  const domains = parsed.domains;

  let turnstile: AuthConfig["turnstile"] = null;
  if (nonEmpty(env.TURNSTILE_SITE_KEY) && nonEmpty(env.TURNSTILE_SECRET))
    turnstile = {
      siteKey: env.TURNSTILE_SITE_KEY.trim(),
      secret: env.TURNSTILE_SECRET,
    };
  else if (nonEmpty(env.TURNSTILE_SITE_KEY) || nonEmpty(env.TURNSTILE_SECRET))
    problems.push(
      "Only one of TURNSTILE_SITE_KEY and TURNSTILE_SECRET is set, so the bot check is off. Set both, or neither.",
    );

  const google = providers.has("google")
    ? googleConfig(env, domains, problems)
    : null;
  const direct = providers.has("google") || providers.has("email");
  // Same rule as email/send.ts emailEnabled (not imported: it pulls in services).
  const canSend = !!env.EMAIL && !!env.EMAIL_FROM;
  if (providers.has("email") && !canSend)
    problems.push(
      "Email sign-in is on, but sending email isn't set up (EMAIL and EMAIL_FROM), so sign-in codes aren't offered. Set up email sending, or turn email sign-in off.",
    );

  return {
    providers,
    domains,
    domainJoin: domainJoin(env, problems),
    emailCodes: providers.has("email") && canSend,
    domainCodes:
      env.EMAIL_CODE_DOMAIN === "on" &&
      providers.has("email") &&
      canSend &&
      !providers.has("google") &&
      turnstile !== null &&
      domains.length > 0,
    guestsReadOnly: direct,
    features: parseFeatures(env.FEATURES),
    google,
    turnstile,
    codeEmailsPerDay:
      intIn(env.CODE_EMAILS_PER_DAY, 1, CODE_EMAILS_MAX) ?? CODE_EMAILS_DEFAULT,
    installKey: nonEmpty(env.INSTALL_ID) ? env.INSTALL_ID.trim() : env.APP_HOST,
    problems,
  };
}

const memo = new WeakMap<Env, AuthConfig>();

/** The sign-in configuration for this env, computed once per env object. */
export function authConfig(env: Env): AuthConfig {
  let c = memo.get(env);
  if (!c) {
    c = build(env);
    memo.set(env, c);
    // Once per env object (an isolate's): the operator sees why a configured
    // sign-in method is off without asking an owner to look.
    if (c.problems.length > 0)
      console.log(
        JSON.stringify({ evt: "auth_config_problems", problems: c.problems }),
      );
  }
  return c;
}
