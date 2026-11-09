// The install slug rule (design v7 section 3), moved here from
// @oa/provision/names so the API, the admin panel and provision share one
// copy. Dependency-free: @oa/provision/names imports it inside workerd.

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const RESERVED_SLUGS: readonly string[] = [
  "www",
  "api",
  "admin",
  "app",
  "mail",
  "status",
  "docs",
  "staging",
  "content",
  // Platform hosts on the tenant domains (P2 auth broker at auth.<app-domain>,
  // P3 directory broker at directory.<app-domain>).
  "auth",
  "broker",
  "login",
  "sso",
  "directory",
  // Provisioning API hosts and names (design v7 2.2).
  "signup",
  "billing",
  "provisioning",
  "provisioner",
  // Look-alike and role names (issue #1011): no phishing hosts such as
  // support.<app-domain>. Existing installs (leo, rl-a, rl-b) are not here.
  // "demo" is deliberately left out: it may already be a prod install (#1011).
  "admins",
  "administrator",
  "root",
  "superuser",
  "sysadmin",
  "owner",
  "team",
  "staff",
  "official",
  "support",
  "help",
  "helpdesk",
  "contact",
  "security",
  "abuse",
  "trust",
  "safety",
  "legal",
  "privacy",
  "compliance",
  "postmaster",
  "hostmaster",
  "webmaster",
  "noreply",
  "no-reply",
  "info",
  "smtp",
  "imap",
  "pop",
  "mx",
  "account",
  "accounts",
  "signin",
  "sign-in",
  "register",
  "password",
  "verify",
  "oauth",
  "id",
  "identity",
  "open-artifacts",
  "openartifacts",
  "artifacts",
  "dashboard",
  "console",
  "cdn",
  "assets",
  "static",
  "files",
  "health",
  "test",
  "dev",
  "internal",
  "ns1",
  "ns2",
];

/**
 * "ok", "invalid" (the regex, or "--" at positions 3-4: IDNA-reserved, so
 * "xn--" punycode could render as another name) or "reserved".
 */
export function slugRule(slug: string): "ok" | "invalid" | "reserved" {
  if (!SLUG_RE.test(slug) || slug.slice(2, 4) === "--") return "invalid";
  return RESERVED_SLUGS.includes(slug) ? "reserved" : "ok";
}

export const isValidSlug = (slug: string): boolean => slugRule(slug) === "ok";

/**
 * The 3.5 code for a slug that fails the rule, or null. Schemas take any
 * short string so these codes come from policy, not invalid_input.
 */
export function slugError(
  slug: string,
): "slug_invalid" | "slug_reserved" | null {
  const r = slugRule(slug);
  return r === "ok" ? null : r === "invalid" ? "slug_invalid" : "slug_reserved";
}
