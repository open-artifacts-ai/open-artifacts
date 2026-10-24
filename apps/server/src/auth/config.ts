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
  /** Guests capped at viewer: whenever google or email is on. Not configurable. */
  guestsReadOnly: boolean;
  features: FeatureFlag[];
  /** Null unless google is enabled and fully configured (fail closed). */
  google: { clientId: string; transport: GoogleTransport } | null;
  turnstile: { siteKey: string; secret: string } | null;
  codeEmailsPerDay: number;
  /** INSTALL_ID, else APP_HOST: the install part of rate-limit keys. */
  installKey: string;
  /** Why something configured is off. Never contains secret values. */
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

function isEd25519Pkcs8(v: string): boolean {
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
    else problems.push(`AUTH_PROVIDERS: unknown provider ${p}`);
  }
  return out;
}

function googleConfig(
  env: Env,
  domains: readonly string[],
  problems: string[],
): AuthConfig["google"] {
  const fail = (why: string) => {
    problems.push(`google: ${why}`);
    return null;
  };
  if (!nonEmpty(env.GOOGLE_CLIENT_ID)) return fail("GOOGLE_CLIENT_ID is empty");
  if (domains.length === 0) return fail("AUTH_DOMAINS is empty");
  const clientId = env.GOOGLE_CLIENT_ID.trim();
  // Hosted installs never hold the shared Google client secret: the broker
  // alone does the code exchange. Fail closed, and never fall back to direct
  // or honour a tenant-supplied GOOGLE_CLIENT_SECRET.
  if (env.HOSTED === "1" && !nonEmpty(env.AUTH_BROKER_URL))
    return fail("HOSTED=1 requires the broker transport (AUTH_BROKER_URL)");
  if (nonEmpty(env.AUTH_BROKER_URL)) {
    let url: URL;
    try {
      url = new URL(env.AUTH_BROKER_URL);
    } catch {
      return fail("AUTH_BROKER_URL is not a URL");
    }
    if (url.protocol !== "https:") return fail("AUTH_BROKER_URL must be https");
    if (!nonEmpty(env.INSTALL_ID)) return fail("INSTALL_ID is empty");
    if (
      !nonEmpty(env.BROKER_SIGNING_KEY) ||
      !isEd25519Pkcs8(env.BROKER_SIGNING_KEY)
    )
      return fail("BROKER_SIGNING_KEY is not a PKCS#8 Ed25519 key");
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
    return fail("GOOGLE_CLIENT_SECRET is empty");
  return {
    clientId,
    transport: { kind: "direct", secret: env.GOOGLE_CLIENT_SECRET },
  };
}

/** Hosted installs never admit by domain: their AUTH_DOMAINS aren't proven owned (M1). */
function domainJoin(env: Env, problems: string[]): AuthConfig["domainJoin"] {
  const join = env.AUTH_DOMAIN_JOIN === "member" ? "member" : "invite";
  if (env.HOSTED === "1" && join === "member") {
    problems.push("AUTH_DOMAIN_JOIN: HOSTED=1 allows invite only");
    return "invite";
  }
  return join;
}

function build(env: Env): AuthConfig {
  const problems: string[] = [];
  const providers = parseProviders(env.AUTH_PROVIDERS, problems);
  const parsed = parseDomains(env.AUTH_DOMAINS ?? "");
  for (const d of parsed.invalid)
    problems.push(`AUTH_DOMAINS: invalid domain ${d}`);
  const domains = parsed.domains;

  let turnstile: AuthConfig["turnstile"] = null;
  if (nonEmpty(env.TURNSTILE_SITE_KEY) && nonEmpty(env.TURNSTILE_SECRET))
    turnstile = {
      siteKey: env.TURNSTILE_SITE_KEY.trim(),
      secret: env.TURNSTILE_SECRET,
    };
  else if (nonEmpty(env.TURNSTILE_SITE_KEY) || nonEmpty(env.TURNSTILE_SECRET))
    problems.push(
      "turnstile: TURNSTILE_SITE_KEY and TURNSTILE_SECRET are both required",
    );

  const google = providers.has("google")
    ? googleConfig(env, domains, problems)
    : null;
  const direct = providers.has("google") || providers.has("email");

  return {
    providers,
    domains,
    domainJoin: domainJoin(env, problems),
    domainCodes:
      env.EMAIL_CODE_DOMAIN === "on" &&
      providers.has("email") &&
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
  }
  return c;
}
