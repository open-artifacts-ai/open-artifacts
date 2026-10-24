import { parseDomains } from "../../../packages/auth-core/src/domains.ts";

/**
 * Direct sign-in Worker vars (docs/self-hosting/direct-sign-in.md) and their
 * setup flags. The template has none: a deploy replaces the live vars, so
 * setup carries each one forward from the live Worker unless a flag sets it.
 */
export const SIGNIN = {
  AUTH_PROVIDERS: "auth-providers",
  AUTH_DOMAINS: "auth-domains",
  AUTH_DOMAIN_JOIN: "auth-domain-join",
  GOOGLE_CLIENT_ID: "google-client-id",
  TURNSTILE_SITE_KEY: "turnstile-site-key",
  EMAIL_CODE_DOMAIN: "email-code-domain",
  CODE_EMAILS_PER_DAY: "code-emails-per-day",
} as const;
export type SigninVar = keyof typeof SIGNIN;
export const SIGNIN_VARS = Object.keys(SIGNIN) as SigninVar[];
/** Values to render; "" is unset (not rendered: the server default). */
export type Signin = Record<SigninVar, string>;

/** apps/server/src/auth/config.ts PROVIDERS (test/signin.test.ts keeps them in sync). */
export const PROVIDERS = ["access", "google", "email"] as const;
const JOINS = ["invite", "member"];
const TOKEN = /^[!-~]+$/;

const parts = (v: string) =>
  v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

/** Why one value is invalid on its own (empty is always fine: it clears). */
function valueProblems(name: SigninVar, v: string): string[] {
  if (v === "") return [];
  switch (name) {
    case "AUTH_PROVIDERS": {
      const ps = parts(v);
      if (!ps.length)
        return [
          "AUTH_PROVIDERS lists no provider (pass access to keep Access only, or empty to clear)",
        ];
      return ps
        .filter((p) => !(PROVIDERS as readonly string[]).includes(p))
        .map(
          (p) =>
            `AUTH_PROVIDERS: unknown provider ${JSON.stringify(p)} (expected ${PROVIDERS.join(", ")})`,
        );
    }
    case "AUTH_DOMAINS": {
      const { domains, invalid } = parseDomains(v);
      return [
        ...invalid.map(
          (d) => `AUTH_DOMAINS: invalid domain ${JSON.stringify(d)}`,
        ),
        ...(domains.length || invalid.length
          ? []
          : ["AUTH_DOMAINS lists no domain (pass empty to clear)"]),
      ];
    }
    case "AUTH_DOMAIN_JOIN":
      return JOINS.includes(v)
        ? []
        : [
            `AUTH_DOMAIN_JOIN: ${JSON.stringify(v)} (expected invite or member)`,
          ];
    case "EMAIL_CODE_DOMAIN":
      return v === "on"
        ? []
        : [`EMAIL_CODE_DOMAIN: ${JSON.stringify(v)} (expected on)`];
    // config.ts CODE_EMAILS_MAX.
    case "CODE_EMAILS_PER_DAY":
      return /^[1-9]\d*$/.test(v) && Number(v) <= 10_000
        ? []
        : [
            `CODE_EMAILS_PER_DAY: ${JSON.stringify(v)} (expected an integer from 1 to 10000)`,
          ];
    default:
      return TOKEN.test(v)
        ? []
        : [`${name}: ${JSON.stringify(v)} has spaces or non-ASCII characters`];
  }
}

/** The canonical form of a valid value: trimmed, lists deduped and comma-joined. */
function normalize(name: SigninVar, v: string): string {
  if (name === "AUTH_PROVIDERS") return [...new Set(parts(v))].join(",");
  if (name === "AUTH_DOMAINS") return parseDomains(v).domains.join(",");
  return v.trim();
}

/** The provider list a value turns on; unset is Access only, as on the server. */
export const providersOf = (s: Signin) =>
  s.AUTH_PROVIDERS === "" ? ["access"] : parts(s.AUTH_PROVIDERS);

/** Every reason this combination would not serve the sign-in it asks for. */
export function signinProblems(s: Signin): string[] {
  const out = SIGNIN_VARS.flatMap((k) => valueProblems(k, s[k]));
  if (providersOf(s).includes("google")) {
    if (!s.GOOGLE_CLIENT_ID)
      out.push("google is in AUTH_PROVIDERS but GOOGLE_CLIENT_ID is empty");
    if (!parseDomains(s.AUTH_DOMAINS).domains.length)
      out.push("google is in AUTH_PROVIDERS but AUTH_DOMAINS is empty");
  }
  return out;
}

/** Flags whose values the server compares exactly in lowercase. */
const LOWER: SigninVar[] = [
  "AUTH_PROVIDERS",
  "AUTH_DOMAIN_JOIN",
  "EMAIL_CODE_DOMAIN",
];

/** The sign-in flags given this run (an empty value clears), trimmed and lowercased where that is safe; throws on a value invalid on its own. */
export function parseSigninFlags(v: Record<string, unknown>): Partial<Signin> {
  const out: Partial<Signin> = {};
  for (const name of SIGNIN_VARS) {
    const raw = v[SIGNIN[name]];
    if (typeof raw !== "string") continue;
    const t = LOWER.includes(name) ? raw.trim().toLowerCase() : raw.trim();
    const why = valueProblems(name, t);
    if (why.length)
      throw new Error(`invalid --${SIGNIN[name]}: ${why.join("; ")}`);
    out[name] = normalize(name, t);
  }
  return out;
}

type Binding = { type: string; name: string; text?: string };

/**
 * Why a live binding can't be carried forward as is: never trimmed or
 * rewritten, because the server reads it byte for byte (" member" is invite).
 * Only the canonical form of a valid value is carried.
 */
function liveProblem(name: SigninVar, b: Binding): string | undefined {
  const fix = `fix it with --${SIGNIN[name]} <value> (empty to remove it)`;
  if (b.type !== "plain_text")
    return `${name} is a ${b.type === "secret_text" ? "secret" : `${b.type} binding`} on the Worker, which setup can't check or keep; make it a plain var: ${fix}`;
  const t = b.text ?? "";
  // The server reads an empty AUTH_PROVIDERS as no provider at all; the others as unset.
  if (t === "" && name !== "AUTH_PROVIDERS") return undefined;
  const why = t === "" ? ["no sign-in at all"] : valueProblems(name, t);
  if (why.length || normalize(name, t) !== t)
    return `the deployed ${name} ${JSON.stringify(t)} is not exactly a value the server accepts (${why.length ? why.join("; ") : "padding, case or an empty list item"}); ${fix}`;
  return undefined;
}

/**
 * The sign-in vars to render: the flag, then the live Worker's plain-text
 * value exactly as deployed. `problems` lists live values that can't be
 * carried and, when there are none, combinations the server would not serve.
 */
export function resolveSignin(o: { flags: Partial<Signin>; live: Binding[] }): {
  values: Signin;
  /** Flags that change a live value: [name, live, flag]. */
  changed: [SigninVar, string, string][];
  /** Values carried forward from the live Worker: [name, value]. */
  kept: [SigninVar, string][];
  problems: string[];
} {
  const values = {} as Signin;
  const changed: [SigninVar, string, string][] = [];
  const kept: [SigninVar, string][] = [];
  const problems: string[] = [];
  for (const name of SIGNIN_VARS) {
    const flag = o.flags[name];
    const b = o.live.find((x) => x.name === name);
    const was = b?.type === "plain_text" ? (b.text ?? "") : "";
    if (flag !== undefined) {
      values[name] = flag;
      if (flag !== was) changed.push([name, was, flag]);
      continue;
    }
    const bad = b && liveProblem(name, b);
    if (bad) problems.push(bad);
    values[name] = bad ? "" : was;
    if (!bad && was) kept.push([name, was]);
  }
  if (!problems.length) problems.push(...signinProblems(values));
  return { values, changed, kept, problems };
}

/** Only the set values: what the rendered config and reports carry. */
export const setOnly = (s: Signin) =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== ""));
