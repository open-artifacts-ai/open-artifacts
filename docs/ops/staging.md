# Staging

Public (no Access gate). Worker `open-artifacts-staging`; hosts `staging.open-artifacts.com`, `staging-content.open-artifacts.com`. `ENVIRONMENT=production` (never dev mode).

## Resources (no secrets)

| Resource | Name | Id |
|---|---|---|
| Account | | 26ac346086d4405f7a976d48747a2a75 |
| D1 | open-artifacts-staging | 5155e2d4-d9bf-4900-b4ab-1febd480377a |
| R2 | open-artifacts-staging | (by name) |
| KV (binding `OAUTH_KV`) | open-artifacts-staging-oauth | 886a49c875024e8ab5262928d75f85b7 |

Zero Trust team: `leourbina`; team domain: `leourbina.cloudflareaccess.com`.

Config: `apps/server/wrangler.staging.jsonc` (`env.staging`).

## Recreate

```sh
cd apps/server
pnpm exec wrangler d1 create open-artifacts-staging
pnpm exec wrangler r2 bucket create open-artifacts-staging
pnpm exec wrangler kv namespace create open-artifacts-staging-oauth
```

Put the new ids into `wrangler.staging.jsonc`, then deploy once.

## GitHub secrets

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OA_OWNER_EMAIL` (required; the owner's address, trimmed and lowercase, or the deploy refuses); `STAGING_OWNER_PAT` (optional, smoke tests).

## Deploy

`deploy-staging.yml` on push to `main`: build, migrate, deploy, smoke. Manual:
`pnpm --filter @oa/server exec wrangler deploy -c wrangler.staging.jsonc --env staging --var "OWNER_EMAIL:$OA_OWNER_EMAIL"`.
The address isn't committed, so without `--var` the deploy removes `OWNER_EMAIL`.

## Repo settings

Enable Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" (needed by release-please). Release PRs made with `GITHUB_TOKEN` don't trigger CI, so `release-please.yml` dispatches `ci.yml` on the release branch via `workflow_dispatch`.

## Releases

`release-please.yml` keeps a release PR open and dispatches `ci.yml` on its branch after every push to main (GITHUB_TOKEN pushes don't trigger CI on their own).

1. Merge the release PR when it is green and up to date.
2. If it is behind, run `gh pr update-branch <n>`; a user push triggers CI normally.
3. The landing deploy runs after the release and is gated by `check-landing-dist`.
4. To redeploy the landing site: `gh workflow run release-please.yml -f tag=vX.Y.Z`.

## B4 Access setup

`ops-staging-access.yml` (manual only, main only) shares the `staging` concurrency group with `deploy-staging.yml`, so the two never race on Worker secrets. It runs `scripts/ops/staging-access.ts`. It is idempotent: a re-run creates and changes nothing that already exists.

```sh
gh workflow run ops-staging-access.yml                       # defaults: team_name=leourbina, force_rotate=false
gh workflow run ops-staging-access.yml -f force_rotate=true  # regenerate SESSION_SECRET + CONTENT_SIGNING_KEY
```

It reads the team domain from the Access organization, falling back to `<team_name>.cloudflareaccess.com`. It ensures the Access for SaaS OIDC app `open-artifacts-staging`: redirect `https://staging.open-artifacts.com/auth/callback`, scopes openid/email/profile, grant `authorization_code_with_pkce` with `allow_pkce_without_client_secret: false`. Then it sets any missing Worker secrets: `ACCESS_CLIENT_SECRET`, `SESSION_SECRET`, `CONTENT_SIGNING_KEY`. `CF_ACCOUNT_ID` is a plain var in `wrangler.staging.jsonc` (not sensitive, never a secret); a var and a secret with the same name make `wrangler deploy` fail, so `deploy-staging.yml` deletes any Worker secret that shares a name with a staging var (`scripts/ops/conflicting-secrets.ts`) right before deploying.

Policy: the reusable allow policy `Open Artifacts – everyone` uses `include: [{ everyone: {} }]` with no exclude or require (spec 6.5). Access authenticates everyone, and the app does authorization. The script reconciles this policy in place with `PUT /accounts/{id}/access/policies/{policy_id}`:
- A legacy `open-artifacts-staging-owner` policy is renamed. Its id stays the same, so the app's link still works.
- A policy that has drifted is put back to the spec: decision, include, exclude or require, or any of approval_required, isolation_required or purpose_justification_required set. `session_duration` is carried over.
- The policy is created only if neither name exists.

The log prints `policy …: reconciled|unchanged|created`. The app itself is never PUT.

The OIDC client secret is only returned when the app is created, and there's no API to rotate it. If the app exists but `ACCESS_CLIENT_SECRET` is missing on the Worker, the run fails. To recover, delete the Access app and re-run. If the app exists but isn't linked to `Open Artifacts – everyone`, the run also fails: attach the policy in the dashboard, or delete the app and re-run. Everything is preflighted (secret list, policy, generated values) before the app is created. If any Worker secret write fails after creation, the new app is deleted so a re-run starts clean.

**Afterwards:** copy `ACCESS_CLIENT_ID` from the job summary into `env.staging.vars.ACCESS_CLIENT_ID` in `apps/server/wrangler.staging.jsonc` and commit it. Deploys overwrite vars, so it has to live in the config.

### Access app (created 2026-10-18)

| Item | Value |
|---|---|
| Access app name | open-artifacts-staging |
| Access app id | bbdd007c-886a-46db-8c9a-15b0d2f5cc3c |
| Policy | Open Artifacts – everyone (`fc52c743-e814-448e-97c8-43a6037e5486`, formerly open-artifacts-staging-owner) |
| OIDC client id (`ACCESS_CLIENT_ID`) | e332570b66c35883120a21ccfe376f6394aa4089c08cb73c6224b96fab1da7e2 |

The client id is public and is committed in `wrangler.staging.jsonc`. The client secret is a Worker secret and is not recorded here.

## Production token

Production (`artifacts.leourbina.com`, zone `leourbina.com`) uses its own repo secret, **`PROD_CLOUDFLARE_API_TOKEN`**. Staging keeps `CLOUDFLARE_API_TOKEN`. They must never cross: only workflows with `prod` in the filename may reference the PROD secret, and they must not reference `CLOUDFLARE_API_TOKEN` (enforced in `scripts/check-ci.test.ts`). The account id still comes from `CLOUDFLARE_ACCOUNT_ID`.

Scopes (account-scoped, zone `leourbina.com` only):

- Workers Scripts, KV, R2 and D1: Edit
- Access Apps: Edit
- Access Organizations: Read
- Account Analytics: Read
- Workers Routes and DNS on the zone: Edit

Check the token (read-only API calls, prints pass/fail per check and names any missing permission):

```
gh workflow run ops-prod-token-check.yml
```

It runs only on `main`, in the `prod` concurrency group, via `scripts/ops/check-prod-token.sh`.

## Analytics token

The Usage page reads Cloudflare analytics with its own token, repo secret **`ANALYTICS_TOKEN`** (Account Analytics: Read, nothing else). It is never the deploy token. `deploy-staging.yml` puts it on the staging Worker after each deploy and before the smoke job (`scripts/ci/staging-analytics-token.sh`, stdin only; skipped when the secret is empty). If the put fails, smoke still runs and its last step fails the run, so both outcomes show. Setup refuses an `ANALYTICS_TOKEN` that verifies to the deploy token's id. Prod gets it through the setup `secrets` step: `ops-prod-install.yml` (install) and the `deploy-prod` upgrade step pass it step-scoped, and setup stores it on every run, so rotating the repo secret rotates the Worker on the next release.

## First production install

One-time install of the production instance with `@oa/setup --ci`. Runs only on `main`, in the `prod` concurrency group and `production` environment, and only for the latest stable (non-pre-release) tag:

```
gh workflow run ops-prod-install.yml -f tag=vX.Y.Z
```

The workflow checks out the tag and runs `scripts/ci/prod-setup.sh install`, which logs each JSON line from setup and writes a step/status table to the job summary. It fails on any `error` or `action_required` line.

The owner PAT is never printed: `--ci` uses it only for the selftest and revokes it at the end, and the script aborts if any output line matches the token pattern. After the install, create your own tokens in the dashboard.

## Production deploys

Every **stable** release upgrades prod (`deploy-prod` in `release-please.yml`). Pushes to `main` never touch prod, and pre-releases are skipped by a guard (`gh release view --json isPrerelease`). The job is in the `prod` concurrency group and independent of `deploy-landing`. Requires the first install above.

Manual redeploy, only for the latest stable tag:

```
gh workflow run release-please.yml -f tag=vX.Y.Z
```

(The same `tag` input also redeploys the landing site.) The job checks out the tag and runs `scripts/ci/prod-setup.sh` in three steps, each with the PROD token scoped to that step:

1. `preflight`: `oa:setup --check --strict --upgrade`. Read-only; fails if the instance is not installed (missing D1/R2/KV, Worker secrets, Access app, Worker never deployed) or has drifted (Worker vars differ from the flags, Access app not linked to its policy). Deploy and selftest always run, so they never count as drift.
2. `upgrade`: `oa:setup --ci --upgrade`. Deploys and runs selftest with a CI token. `--upgrade` never creates resources, secrets or Access config, and keeps the owner token.
3. `cleanup` (`always()`): `oa:setup --ci --revoke-ci-tokens`. Revokes any leaked setup-ci token.

A failed preflight skips the upgrade; cleanup still runs.

## Browser Run binding (`BROWSER`)

Server-side thumbnails use the Workers `browser` binding (Browser Run) plus `vars.SERVER_THUMBNAILS = "on"`. They are Workers Paid only: setup renders both only when prereqs reads the plan as `paid`; free or unknown gets neither. Staging (Paid) declares both, asserted by `scripts/check-staging-config.test.ts`.

- No extra API token permission: Workers edit is enough to deploy.
- Workers Free limits: 10 browser-minutes/day, 3 concurrent sessions, 1 new browser per 20 s, Quick Actions 1 req per 10 s. Over the limit Cloudflare returns 429 until the next UTC day. Not billed on Free.
- Precedence: `--browser` (forces both on; warns `browser-free` when the plan isn't paid) or `--no-browser` (forces both off), then the plan (`paid` on, `free` off), then saved state only when the plan is `unknown`. Stateless CI reads the plan as unknown, so `scripts/ci/prod-setup.sh` passes `--browser`. `--check` and `--json` report `browser`.
- A deploy never drops a live `BROWSER` binding or `SERVER_THUMBNAILS` var (read from the Worker settings GET) without `--no-browser`; it refuses with an error naming the flag. A failed read only warns.
- `.quickAction()` needs `compatibility_date` >= 2026-03-24. The template's is 2026-01-01 (unchanged); staging's is 2026-10-01.

## Team email: Email Sending domain and `send_email` binding

Setup asks "Just you, or a team?" (`--solo` / `--team`). `--json` never guesses: `--json`, `--yes` and `--ci` runs with neither flag and no saved choice stop with `action_required` on prereqs ("Pass --solo or --team"); `--check` only reports. Product split: Free = Individual, Paid = Team.

- **Solo:** no email. The template's `send_email` line and `EMAIL_FROM` var are dropped from the rendered config.
- **Team:** the `email` step runs (after `secrets`, before `deploy`). `--no-email` turns it off. The question is asked in `prereqs`, after the plan is read.
- State: `plan`, `team`, `email`, `emailDomain`, `browser` in `.openartifacts/state.json`, kept by `--upgrade`, reported by `--check` and by the final `state` line of every successful `--json` run.
- A deploy never drops a live `EMAIL` (`send_email`) binding without `--no-email` (refuses with an error), so a stateless team `--upgrade` must pass `--team` (and `--yes-paid` unless the plan reads paid).

**Plan (prereqs).** Prereqs reads `GET /accounts/{id}/subscriptions` (read-only, via the cf client). The plan is `paid` when an item has `rate_plan.id` in `WORKERS_PAID` / `PARTNERS_WORKERS_SS` / `PARTNERS_WORKERS_ENT` (case-insensitive; the documented Workers rate plan ids) and `state` is `Paid`, `Provisioned` or `Trial`; such an item with no `state` is `unknown`. Every page is read. It is `free` when the list parses with no such item, and `unknown` on any error (403 without Billing Read, which the `wrangler login` token lacks) or an unexpected shape. `rate_plan.id` is the machine id the billing API sets; `public_name` is display text, so it is not used. The prereqs line reports `ok` (message "prerequisites ok") and carries `data.plan`, `data.warnings` (`[{code, plan, message}]`: `cpu-limit`, `kv-writes`, `no-email`, `individual-use`, plus `plan-unknown`; `[]` on paid) and `data.notes` (for example "Workers Paid detected"); nothing is added to the message. `--check` prints the same data. `--check` reports `plan` in its state line. Free or unknown: team only with confirmation (the prompt, or `--team`), and email off unless `--yes-paid`; a saved `email: true` stands in only when the plan is `unknown`, never for a detected `free`. Email Sending to arbitrary recipients needs Workers Paid; Free can only send to verified destination addresses. Plans: https://dash.cloudflare.com/?to=/:account/workers/plans

**Sending domain.** Default `mail.<app host>` (e.g. `mail.artifacts.example.com`), override with `--email-domain`. Use a subdomain: each subdomain is its own sending domain, and onboarding adds `_dmarc.<domain>` with `p=reject`, which at a zone apex can break the mail an existing provider (e.g. Google Workspace) sends. Before onboarding, setup checks the domain: MX or SPF for another provider (at the apex, any MX) needs confirmation (prompt, or `--yes-email-domain`; else `action_required`), with a strong warning when the apex has such MX and no `_dmarc`. The apex is never reused from saved state: each run needs `--email-domain <apex>` again, and the conflict check (and its confirmation) runs on every run, onboarded or not.

**Onboarding is a human step** (no API): https://dash.cloudflare.com/?to=/:account/email-service/sending, Onboard Domain, pick the domain. It adds:

| Type | Name | Content |
|---|---|---|
| MX | `cf-bounce.<domain>` | `route1.mx.cloudflare.net`, `route2…`, `route3…` |
| TXT | `cf-bounce.<domain>` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT | `cf-bounce._domainkey.<domain>` | `v=DKIM1; …` (Cloudflare-generated key) |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=reject;` |

Until all four resolve, the step is `action_required` (with the link and the records) and setup stops before `deploy`. Re-running re-checks. DNS is read with the zone `dns_records` API, or DNS over HTTPS (`cloudflare-dns.com`) when the token has no DNS Read (the `wrangler login` token).

**Config.** With email on, the rendered config has `"send_email": [{ "name": "EMAIL" }]` and `vars.EMAIL_FROM = "noreply@<domain>"`. The template stays strict JSON; `EMAIL_FROM` is never the last var, so dropping its line keeps valid JSON. Selftest checks the deployed Worker's settings for the `EMAIL` `send_email` binding.

**Staging.** Staging sends from `mail.open-artifacts.com` (onboarded; not the default `mail.<app host>`): `wrangler.staging.jsonc` has `"send_email": [{ "name": "EMAIL" }]` and `vars.EMAIL_FROM = "noreply@mail.open-artifacts.com"`, asserted by `scripts/check-staging-config.test.ts`.

**Prod.** `prod-setup.sh` passes `--team --yes-paid --email-domain mail.leourbina.com` to install, preflight and upgrade (`EMAIL_SWITCH` in the script; the demo modes stay `--solo --no-email`). `mail.leourbina.com` is onboarded (MX, SPF, DKIM and DMARC all resolve). The first release after that change deploys the `EMAIL` binding and `EMAIL_FROM=noreply@mail.leourbina.com`; until it lands the Worker has no `EMAIL`, which the deploy step treats as a planned addition, so `--check --strict` (preflight) passes. If the onboarding records ever disappear, the `email` step reports `todo` and preflight fails (exit 2): that is drift, not a planned change. Sending a real invite is a separate, human-approved step.
