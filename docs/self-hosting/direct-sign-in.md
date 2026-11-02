# Direct sign-in (without Cloudflare Access)

Open Artifacts signs people in through Cloudflare Access by default. Direct sign-in is the alternative: **Sign in with Google**, locked to your Google Workspace domain, and **emailed one-time codes** for people you share artifacts with. Every Access sign-in uses a Zero Trust seat, so direct sign-in avoids that cost.

## What you get

- **Google:** anyone whose Google account belongs to your verified Workspace domain can sign in. The `hd` claim in the ID token decides, never the email address. With `AUTH_DOMAIN_JOIN=member` they join as members on their first sign-in; with `invite` (the default) only people you invited can.
- **Emailed codes:** only for people outside your domain who were invited or have a share. They sign in as guests and are read-only: they can view what is shared with them, never edit, share or write live data. Their sessions last 24 hours.
- **A trial without Google** (optional): domain members can also use codes while Google is off. This needs Turnstile.

## Configuration

| Variable | Kind | Setup flag | Meaning |
|---|---|---|---|
| `AUTH_PROVIDERS` | var | `--auth-providers` | `google,email` (or `google`, or `email`), optionally with `access`. Unset means Access only. |
| `AUTH_DOMAINS` | var | `--auth-domains` | Your verified domains, comma separated, e.g. `example.com`. |
| `AUTH_DOMAIN_JOIN` | var | `--auth-domain-join` | `member` (anyone in the domain joins) or `invite` (default). |
| `GOOGLE_CLIENT_ID` | var | `--google-client-id` | Your Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | secret | none | Its secret. |
| `EMAIL_CODE_DOMAIN` | var | `--email-code-domain` | `on` lets domain members use codes, only while Google is off. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | var, secret | `--turnstile-site-key` (the key only) | When set, every code request needs a Turnstile token. Required for domain codes. |
| `CODE_EMAILS_PER_DAY` | var | `--code-emails-per-day` | Daily cap on code emails (default 200, at most 10000), separate from invites (`EMAIL_DAILY_CAP`, default 100). |
| `SESSION_SECRET` | secret | none | At least 32 characters of random data (setup generates one). See below. |

Codes need email sending set up (`EMAIL` binding and `EMAIL_FROM`). Code requests are rate limited per IP by the `RL_AUTH` binding.

## Setting it with setup

Pass the vars to setup as flags, and put the secrets on the Worker yourself (they never go through setup):

```sh
pnpm oa:setup --upgrade --name <name> \
  --auth-providers access,google,email \
  --auth-domains example.com \
  --auth-domain-join invite \
  --google-client-id <id>.apps.googleusercontent.com
pnpm -C apps/server exec wrangler secret put GOOGLE_CLIENT_SECRET --name <name>
```

- **Upgrades keep them.** Every setup run deploys the Worker, and a deploy replaces its vars with the rendered config. Without a flag, setup reads the value already on the deployed Worker and deploys it again, so a later `--upgrade` (stateless CI included) keeps your sign-in settings. A flag replaces the value, with a note naming the old one. Values set in the Cloudflare dashboard are kept the same way.
- **Clearing one:** pass it empty, e.g. `--auth-domains ""` or `--auth-domain-join=`. The var is removed and the server default applies.
- **Setup refuses before deploying** an unknown provider, a malformed domain, an `AUTH_DOMAIN_JOIN` other than `invite` or `member`, and `google` without both `GOOGLE_CLIENT_ID` and `AUTH_DOMAINS`. Flags are trimmed, and provider names, the join mode and `EMAIL_CODE_DOMAIN` lowercased. A value already on the Worker is carried exactly as it is; one the server would read differently (padded like `"member "`, wrong case like `Google`, an empty list item, an empty `AUTH_PROVIDERS`, or the var held as a secret or JSON binding) is refused instead: fix it with its flag. A missing `GOOGLE_CLIENT_SECRET` (or `TURNSTILE_SECRET` with a site key) is only a warning on the `deploy` line; that sign-in method stays off until you set it.
- **If setup can't read the Worker's settings** (or they come back with no bindings), it never deploys an existing Worker, with or without `--upgrade`: the deploy step stops with `action_required`. Rerun once they are readable (the token needs Workers Scripts Read). A first install, with no Worker yet, is not affected.
- `--check` reports the values it would deploy as `data.signin` on the `deploy` line.

### This repository's production

`artifacts.leourbina.com` is deployed by the release workflow (`deploy-prod` in `.github/workflows/release-please.yml`, through `scripts/ci/prod-setup.sh`). It and the manual install workflow (`ops-prod-install.yml`) read four repository variables, `PROD_AUTH_PROVIDERS`, `PROD_AUTH_DOMAINS`, `PROD_AUTH_DOMAIN_JOIN` and `PROD_GOOGLE_CLIENT_ID`, and passes each one that is set as its setup flag. An unset variable passes no flag, so the live value carries forward. Turning Google on is a variable change plus a re-run of the deploy, with no PR; `GOOGLE_CLIENT_SECRET` goes on the Worker with `wrangler secret put` first. To switch back, set `PROD_AUTH_PROVIDERS` to `access` and re-run the deploy.

## SESSION_SECRET

Direct sign-in keys everything it signs from `SESSION_SECRET`: one key per purpose (session cookies, sign-in state, code hashes, pending-code cookies), each derived with HKDF.

- **Use at least 32 characters.** Setup generates a random one. To make your own: `openssl rand -base64 32`.
- **Emailed codes need it.** With a shorter secret, code requests answer 503 `code_unavailable`.
- **Shorter, older secrets (legacy).** Session and sign-in cookies keep working, signed with the raw secret as before, so nobody is signed out. Emailed codes stay off (503 `code_unavailable`) until you rotate it, so rotate it soon. `/healthz` never reports this: it is public, and naming a weak secret there would help an attacker.
- **Cookies from before the per-purpose keys** (signed with the raw secret) are still accepted until 1 December 2026. After that date they are refused, and anyone still holding one signs in again once.
- **Rotating it** signs everyone out and invalidates every pending code.

## Setting up Google

1. In Google Cloud, create an OAuth client of type **Web application**. If your users are all in one Workspace, set the consent screen's user type to **Internal**: then no other Google account can use it at all.
2. Add the redirect URI `https://<your app host>/auth/callback/google`.
3. Use only the `openid`, `email` and `profile` scopes.
4. Put the client id and secret in the variables above.

## Switching an existing install

Existing members keep their accounts and artifacts. On their first Google sign-in, the account with the same email address is linked to their Google account. Existing sessions keep working. To switch back, run setup with `--auth-providers access` (or set `AUTH_PROVIDERS` to `access` and keep it there: setup carries it forward); nothing else changes.

## Security notes

- Each install verifies Google's ID token itself: signature, issuer, audience, expiry, its own nonce, a verified email, and `hd` exactly in `AUTH_DOMAINS`.
- Codes are 8 digits and expire after 10 minutes. Each code request allows 5 tries, there is a per-IP failure cap, and codes are stored only as keyed hashes.
- Asking for a code answers the same way whether or not the address can sign in.
- Code sends are capped per address and network (3 an hour, 5 a day), so someone on other networks can't stop a person getting codes. Those caps can't stop an attacker spread across many networks; Turnstile does. **Without Turnstile, emailed codes are weaker**: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` if you turn codes on. Until you do, the owner sees "Sign-in codes are on without a bot check. Add a Turnstile key so bots can't use your email quota." under sign-in problems. Hosted installs refuse code sign-in without Turnstile.
- See `docs/security/security.md` for the threat model.
