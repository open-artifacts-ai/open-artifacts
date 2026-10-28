---
title: Set up Open Artifacts
description: Deploy your own instance to Cloudflare. Your agent does every step except the Cloudflare login.
order: 1
---

Open Artifacts runs on your own Cloudflare account and domain. The easiest way to install it is to tell your coding agent:

> install open-artifacts.com/llms.txt at artifacts.example.com

The agent follows the steps below. The only thing you do yourself is approve the Cloudflare login in your browser.

## What you need

- **Node.js 22 or later**, with pnpm (`corepack enable` provides it).
- **git**.
- **A Cloudflare account.** The free plan is enough.
- **A domain on Cloudflare.** Open Artifacts uses two hostnames on it: one for the app (for example `artifacts.example.com`) and one for artifact content (for example `artifacts-content.example.com`).

## Steps

1. **Check the prerequisites.** Run `node --version`, `pnpm --version`, and `git --version`. If anything is missing, or the user has no Cloudflare account or no domain on Cloudflare, explain what it is and how to get it, then wait.
2. **Clone the latest release.** Open Artifacts installs from the latest stable GitHub release, not `main` and not a pre-release. Release tags look like `vX.Y.Z`:

   ```sh
   REPO={REPO_URL}
   TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
   git clone --depth 1 --branch "$TAG" "$REPO" ~/open-artifacts
   cd ~/open-artifacts
   ```

   Clone outside any existing git repository (the command uses `~/open-artifacts`), and tell the user the path: upgrades run from there.

   If `TAG` comes back empty or `curl` fails, stop and tell the user: "Open Artifacts has no stable release yet; check back later."
3. **Install dependencies:** `pnpm install`. pnpm may print "Ignored build scripts: esbuild, workerd". That's expected, so don't run `pnpm approve-builds`.
4. **Check the Cloudflare login, then ask the user to log in if needed.** First run `npx wrangler whoami --json` with at least a 3-minute timeout (it can refresh a login). If it lists accounts, skip the login. Otherwise ask them to run `npx wrangler login` and approve access in the browser. On a remote machine or in a container, use `npx wrangler login --device` instead. This is the one step a person has to do.
5. **Run setup.** First ask the user: "Just you, or a team?" Don't guess. Pass `--solo` for just them, or `--team` for a team.
   - **Team:** in the same message, ask whether the account is on Workers Paid, and pass `--yes-paid` if so (invite email needs it). Tell them up front that they'll create a Cloudflare Access token and onboard the sending domain `mail.<app-host>`. Also tell them that everyone who signs in, viewers included, uses a Cloudflare Zero Trust seat: free up to 50 users, then $7 per user per month for every user (see [Self-hosting costs](/docs/self-hosting-costs/#access-sign-in-seats)).
   - **One hostname:** if they gave only one, it's `--app-host`. Propose `<first-label>-content.<zone>` as `--content-host` (for `artifacts.example.com`, that's `artifacts-content.example.com`) and the email from `wrangler whoami` as `--owner-email`, and confirm both.

   Then run it with the user's hostnames and email:

   ```sh
   pnpm -s oa:setup --json --app-host artifacts.example.com --content-host artifacts-content.example.com --owner-email you@example.com --name open-artifacts --solo
   ```

   `-s` keeps pnpm's own output off stdout, so every line is JSON. With `--json`, setup never prompts. Setup prints one JSON object per line, `{"step", "status", "message", "data"}`, where `status` is `ok`, `skipped`, `action_required`, or `error`. It stops at the first `action_required` or `error`. Then go by the exit code:

   - **0:** every step is done. Go on to step 6.
   - **2:** the last line is `action_required`. If its `message` asks you to pass a flag, such as `--account-id` when the login can reach several accounts, add that flag and run again; ask the user for the value if you don't know it. Otherwise relay the `message` to the user verbatim, with `data.url` if it has one, wait until they say it's done, and run the same command again. Setup saves its progress in `.openartifacts/state.json` and picks up where it stopped.
   - **1:** the last line is `error`. Show the user its `message` and stop. If the message names DNS, wait 2 minutes and rerun.

   If the `access` step asks for an Access API token, the user creates one at its `data.url`. Save it with this line in your own terminal (in Claude Code, type `! ` then the line). Never paste a token into the chat. The line works in bash and zsh. Setup never deletes the file; remove it when you no longer need it. If `read` fails, the shell can't hide input, so use a real terminal.

   ```sh
   bash -c 'set -e; umask 077; d="$HOME/.open-artifacts"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "Cloudflare Access token (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/open-artifacts-access-token"; printf "%s" "$T" > "$d/open-artifacts-access-token"; chmod 600 "$d/open-artifacts-access-token"; echo "saved to $d/open-artifacts-access-token"'
   ```

   Use your `--name` in place of `open-artifacts` in that line. `pnpm -s oa:setup --token-links --json` prints the exact line for every token as `saveCommand`. Then run the same setup command again. Setup reads the saved file, keeps the token only in memory, and never prints or saves it.

   The other tokens work the same way, each saved with its own line in your own terminal and never in the chat:

   - Deploy token: `~/.open-artifacts/<name>-cloudflare-token`, or `--token-file <path>`.
   - Access token: `~/.open-artifacts/<name>-access-token`, or `--access-token-file <path>`.
   - Analytics token (optional): `~/.open-artifacts/<name>-analytics-token`, or `--analytics-token-file <path>`.

   Once Access is set up, later runs skip re-checking it while the app host and Cloudflare account stay the same. You need the Access token again only to change the app host or account, or to re-check Access.

   If the `prereqs` line is `action_required` with "Pass --solo or --team", ask the user "Just you, or a team?" and run again with `--solo` or `--team`.

   **The Workers plan.** The `prereqs` line has `data.plan` (`free`, `paid`, or `unknown`) and `data.warnings`. If it stops because a hostname isn't in a zone on the account, the line carries only `data.missing`, with no plan or warnings; once the zone is added and setup runs again, the plan appears. Relay every `data.warnings[].message` to the user verbatim, and say nothing else about the plan: don't paraphrase the warnings or add free-plan notes of your own. Relay warnings once; on reruns, relay only new ones.

   - **`unknown`** is the common case. `wrangler login` has no billing access, so setup couldn't read the plan and relays the Workers Free notes to be safe. The first warning explains this.
   - **`paid`** (detected, or confirmed with `--yes-paid`), with no warnings: tell the user Workers Paid was detected. If they chose `--solo`, offer the team path: run setup again with `--team`. Invite emails need an email sending domain (below).
   - **A team on a plan that isn't `paid`:** invite email stays off, except on an `unknown` plan where an earlier run saved `email: true`; then it stays on. Otherwise, if the user confirms the account is on Workers Paid, run again with `--team --yes-paid`.

   **Invite email (teams only).** The `email` step checks the sending domain, `mail.<app-host>` unless you pass `--email-domain`. When it returns `action_required`, give the user its `message`, the dashboard link in `data.dashboard`, and the DNS records in `data.records`, verbatim. Wait until they've onboarded the domain in the dashboard, then run setup again; the records can take 5 to 15 minutes to appear. If the domain already has mail records from another provider, setup asks first: relay that `action_required` message, and pass `--yes-email-domain` only if the user agrees. Otherwise pick another `--email-domain`.
6. **Connect yourself.** Setup saves your agent token to `~/.open-artifacts/<host-slug>-pat-token` (mode 0600), where `<host-slug>` is the app host lowercased with every run of other characters turned into `-` (`artifacts.example.com` becomes `artifacts-example-com`). The `owner-token` line's `data.tokenFile` is its absolute path. Don't read or print the file; point your client config at it. Never ask for or paste a token in chat. The `agent-config` line's `data.url` is the MCP URL, and its `data.snippets` holds a config for `claudeCode`, `cursor`, `opencode`, `codex` and a generic `json`. Claude Code, Cursor and OpenCode sign in with OAuth: the snippet is only the MCP URL (`claude mcp add --transport http <name> <url>`, then `/mcp`; for OpenCode, `opencode mcp auth <name>`), with no token or header. Use a token only for a client without OAuth: OpenCode's `opencodeToken` snippet reads the file by absolute path (`{file:<abs file>}`), Codex is launched as `OA_TOKEN="$(cat <abs file>)" codex` (don't edit shell profiles), and `json` has a `<YOUR_TOKEN>` placeholder for the user to fill in themselves, in a file kept out of git. If the file is lost, run setup again with `--new-owner-token`: it saves a new token to the file first and revokes the old one only after that. If the revoke fails, setup stops with `action_required` and the file stays; rerun setup to retry it, or revoke the old token in the dashboard (Settings → Agents). Connect agents shows each client's config format.
7. **Open the Welcome page.** Setup publishes a Welcome artifact to test the connection. Give the user its link, `data.welcomeUrl` on the `selftest` and `agent-config` lines, so they can sign in and see it. A rerun tests with the saved agent token file, so it publishes (updates) the Welcome page too, only when its text changed, and unless that file is missing (a note) or its token is rejected (`action_required`, `data.tokenRejected`). When setup finishes, its last line is `{"step": "state", "status": "ok", "message": "final"}` with `data.plan` (the plan setup detected), `data.planVar` (the `PLAN` var the Worker serves), `data.team`, `data.email`, and `data.emailDomain`. Tell the user whether invite emails are on: with `email: true`, invites are sent from `noreply@<emailDomain>`; otherwise they share invite links themselves.

## Setup flags

Setup takes each value from its flag first, then from `.openartifacts/state.json` (saved by an earlier run), then by asking, unless `--json` or `--yes` is set. After the first run, the hostnames and email can be left out.

| Flag | Meaning |
|---|---|
| `--name` | Name of the Worker, its resources, and the Access app. It's also the server name in the MCP snippets. Without saved state, it's required with `--json`, `--yes`, `--upgrade`, or `--check`; only an interactive run defaults it to `open-artifacts`. |
| `--app-host` | The app hostname, for example `artifacts.example.com`. |
| `--content-host` | The artifact content hostname, for example `artifacts-content.example.com`. |
| `--owner-email` | The owner's email. That person becomes the owner and gets the owner token. |
| `--account-id` | The Cloudflare account to use. Defaults to `CLOUDFLARE_ACCOUNT_ID`, or the only account the login can reach. |
| `--yes` | Never prompt. Missing values are errors, and the optional `ANALYTICS_TOKEN` is skipped unless it is set in the environment. Optional with `--json`. |
| `--upgrade` | Upgrade an existing install: only `deploy`, `healthcheck`, `selftest` and `agent-config` do work. See [Upgrade](/docs/upgrade/). |
| `--new-owner-token` | Mint a new owner token, and revoke the one setup minted before. |
| `--allow-downgrade` | Deploy a checkout older than the deployed version (from `/healthz`, else saved state). Without it setup stops with `action_required` before the D1 migrations. D1 is not rolled back. `--check` reports `{repoVersion, liveVersion, downgrade}` on the deploy line. |
| `--print-token` | Also report the minted owner token as `data.token` (and print it in human output). Without it the token is only in its 0600 file, `data.tokenFile`. For a CI job or anyone who needs the value; not used with `--ci`, whose token is revoked at the end of the run. |
| `--check` | Read-only. Runs each step's check without doing the work, and reports it as `done` or `todo`. Without saved state, it rebuilds the state from Cloudflare by `--name` and reports it on a last `state` line. It changes nothing on Cloudflare and writes no files. |
| `--strict` | Only with `--check`: exit `2` when any step is `todo`, for example to gate CI. |
| `--json` | Print one JSON object per line instead of text, and never prompt: a missing value is an `action_required` line naming the flag to pass. The optional `ANALYTICS_TOKEN` is skipped unless it is set in the environment. |
| `--ci` | CI mode: implies `--json`; the owner token is used only for selftest, never printed, and revoked at the end of the run (also on SIGTERM or SIGINT). Requires `--name`; not with `--new-owner-token`. It keeps no `state.json`, so it reuses the welcome artifact by title instead of tracking its id. A SIGKILL or out-of-memory kill can leave a `setup-ci` token live; it is never printed. Find it by the label `setup-ci` in Settings → Agents. The next `--ci` run revokes it before minting, or run `--ci --revoke-ci-tokens` as an `if: always()` cleanup step. |
| `--revoke-ci-tokens` | Only with `--ci`: revoke every live `setup-ci` token of the owner and exit. Needs `--name` and the owner email, not the hosts. |
| `--browser` | Turn on server-side thumbnails (the `BROWSER` binding and `SERVER_THUMBNAILS`) even when setup doesn't read the plan as Workers Paid. Thumbnails need Workers Paid, so setup warns (`browser-free`) on free or unknown, unless Paid is confirmed with `--yes-paid`. Without either flag, thumbnails are on when the plan reads `paid` or you pass `--yes-paid` (add `--no-browser` to keep them off), off on `free`, and follow the saved choice when the plan is `unknown`. |
| `--no-browser` | Turn server-side thumbnails off. A deploy never removes a live `BROWSER` binding without this flag. `--check` and `--json` report `browser: true` or `false`. |
| `--solo` | Just you: no invite email, so no `send_email` binding. With `--json`, `--yes` or `--ci`, pass `--solo` or `--team` unless a choice is saved; setup never guesses. Saved in `state.json` as `team: false`. |
| `--team` | A team: turns on the `email` step, which sets up invite email with Cloudflare Email Sending (Workers Paid only) and renders the `send_email` binding `EMAIL` and the `EMAIL_FROM` var (`noreply@<sending domain>`). Saved in `state.json` as `team`, `email` and `emailDomain`, so `--upgrade` keeps it; `--check` and `--json` report them. Not with `--solo`. |
| `--no-email` | With `--team`: leave email off (no `send_email` binding). A deploy never removes a live `EMAIL` binding without this flag. |
| `--email-domain` | The Email Sending domain. Defaults to `mail.<app host>`, a subdomain, so your existing mail is untouched. Onboard it in the Cloudflare dashboard under Email Service, Email Sending, Onboard Domain; setup checks its `cf-bounce` MX, SPF and DKIM records and `_dmarc`, and re-checks on every run. |
| `--yes-email-domain` | Confirm a sending domain that already has MX or SPF records for another provider. Onboarding adds `_dmarc` with `p=reject`, which can break existing mail at a zone apex. Without it, setup asks interactively or returns `action_required`. |
| `--yes-paid` | Confirm the account is on Workers Paid when `prereqs` reads the plan as `free` or `unknown`. Setup reads the plan from the account subscriptions, which needs Billing Read; the `wrangler login` token doesn't have it, so the plan is usually `unknown`. Without this flag, a team install on a plan that isn't `paid` keeps email off. Saved as `email: true` once confirmed. |
| `--plan` | `paid` or `free` (anything else is an error): the `PLAN` var the Worker serves, which `/healthz` reports as `plan`. Default: `paid` when the plan reads `paid` or with `--yes-paid`, else `free`; an `unknown` plan on `--upgrade` keeps the saved value. A deploy never turns a live `paid` `PLAN` into `free` without `--plan free` (`action_required` otherwise). `prereqs` reports it as `data.planVar` next to the detected `data.plan`, and selftest fails when `/healthz` disagrees. |
| `--var` | `NAME=value`, repeatable: keep a tunable Worker var across deploys. Allowed names: `PUBLIC_HOME` (an artifact id), `EMBED_ORIGINS` (comma-separated `https://host[:port]` origins), `EMBED_ALLOW_SAME_SITE` (`EMBED_ALLOW_SAME_SITE=1` lets `EMBED_ORIGINS` list an origin on the same site as the app, for example open-artifacts.com embedding demo.open-artifacts.com; needs 0.12 or later; empty turns it off), `ANON_WRITES_PER_MIN` (1 to 600; values above 30 have no effect yet, because the instance-wide limit of 30 anonymous writes per IP applies first), `DATA_DOC_BYTES` and `DATA_DAILY_WRITES` (positive integers); `NAME=` clears one. An unknown name or invalid value is an error (exit 1). Setup renders the flag, then the saved `state.vars`, then the value already on the deployed Worker, then the template default. A value set with `--var` or saved in state therefore wins over a dashboard edit; the dashboard value survives `--upgrade` (noted as `kept live NAME=value`) only when setup has none. An invalid saved or live value is ignored with a note. `--check` and `--json` report the values as `data.vars` on the `deploy` line. |
| `--auth-providers` | Direct sign-in (`docs/self-hosting/direct-sign-in.md` in the repo): the `AUTH_PROVIDERS` Worker var, a comma list of `access`, `google` and `email`. Like every sign-in flag below: without the flag, a deploy (an `--upgrade` too) keeps the value already on the Worker; the flag replaces it, and an empty value (`--auth-providers ""`) removes it so the server default applies. `--auth-providers access` switches back to Access only. Setup refuses before deploying an unknown provider, a malformed domain, a join other than `invite` or `member`, or `google` without both a client id and domains. `--check` reports the values as `data.signin` on the `deploy` line. |
| `--auth-domains` | Direct sign-in: `AUTH_DOMAINS`, your verified domains, comma separated. |
| `--auth-domain-join` | Direct sign-in: `AUTH_DOMAIN_JOIN`, `invite` (the default) or `member`. |
| `--google-client-id` | Direct sign-in: `GOOGLE_CLIENT_ID`. Put `GOOGLE_CLIENT_SECRET` on the Worker with `wrangler secret put`; without it setup warns and Google sign-in stays off. |
| `--turnstile-site-key` | Direct sign-in: `TURNSTILE_SITE_KEY` (the `TURNSTILE_SECRET` secret goes on the Worker with `wrangler secret put`). |
| `--email-code-domain` | Direct sign-in: `EMAIL_CODE_DOMAIN`, `on` or empty. |
| `--code-emails-per-day` | Direct sign-in: `CODE_EMAILS_PER_DAY`, 1 to 10000. |
| `--token-links` | Print each Cloudflare API token setup needs (deploy, access, and the optional analytics token), with its permissions, where to store it, and a link that opens the Cloudflare token form already filled in. The account and zone come from `--account-id` and `--app-host`, or saved state. With `--json`, one `token-links` line whose `data.tokens` lists each token and its `url`. A token with zone permissions also has `zoneScope`, the zones of both hosts by name: the Cloudflare form starts at All zones, so under Zone Resources pick Specific zone and choose each one. Billing: Read is optional (it lets setup detect your plan). The `prereqs` line also lists a token that is missing or lacks a permission, with its link, in `data.tokens`. Reads nothing secret and writes nothing. |
| `--token-page` | Open a local page with the same token links and steps, served on `127.0.0.1` only (a random port). Setup prints its URL (`data.tokenPage.url` with `--json`) and stops on Ctrl-C or after 30 minutes idle. The page has no input fields: you create each token in Cloudflare and store it yourself, so it never passes through your agent. |
| `--no-open` | With `--token-page`: print the URL without opening a browser. |
| `--repo` | Only with `--token-links` or `--token-page` (otherwise an error, like `--no-open`): store each token as a GitHub secret in this `owner/name` repo (`gh secret set`) instead of an environment variable. |
| `--token-file` | Read the deploy token (`CLOUDFLARE_API_TOKEN`) from this file. Order: the env var, this file, `~/.open-artifacts/<name>-cloudflare-token`, then `wrangler login`. The file must be mode 0600: a group- or world-readable one is `action_required` (`chmod 600 <path>`), a missing one is an error, an empty one is `action_required`. Never printed or saved. A symlink, or a file you don't own, is refused. Token files need a POSIX system: on Windows, use WSL. |
| `--access-token-file` | Read the Access token (`OA_ACCESS_TOKEN`) from this file, else `~/.open-artifacts/<name>-access-token`. Same rules as `--token-file`. |
| `--analytics-token-file` | Read the optional analytics token (`ANALYTICS_TOKEN`) from this file, else `~/.open-artifacts/<name>-analytics-token`. Same rules as `--token-file`. |
| `--help` | Print usage and exit (`-h` also works). |

| Environment variable | Meaning |
|---|---|
| `OA_ACCESS_TOKEN` | A Cloudflare API token for Access (or save it to a file, see `--access-token-file`), needed on the first run when the `wrangler login` token can't manage Access, and again to change the app host or account. |
| `ANALYTICS_TOKEN` | A read-only token (Account Analytics: Read) for the dashboard's Usage page. When set, the `secrets` step stores it as the Worker secret on every run. Never your deploy token. |
| `CLOUDFLARE_ACCOUNT_ID` | The default for `--account-id`. |
| `OA_TEAM_DOMAIN` | The Zero Trust team domain (`<team>.cloudflareaccess.com`), used when rebuilding state if the token can't read the Access organization. Setup verifies it before use. |

Exit codes: `0` when every step is done, `2` when a step needs the user or a missing flag (`action_required`), and `1` on an error. With `--check`, `0` means the checks ran; `--strict` makes a `todo` step exit `2`.

## What setup does

`oa:setup` is idempotent: each step checks first and skips work that's already done. The steps, in order:

1. **`prereqs`:** checks Node 22 or later, pnpm, the Cloudflare login and account, and that both hostnames are in a zone on that account. It reports `ok` (message "prerequisites ok"); the plan warnings are in `data.warnings`, other notes in `data.notes`, and token links in `data.tokens`. Nothing is added to the message. The optional analytics token link is a note only on the first run.
2. **`resources`:** creates or reuses the D1 database, the R2 bucket, and the KV namespace, and writes `apps/server/wrangler.jsonc`.
3. **`access`:** creates the Cloudflare Access for SaaS application and its sign-in policy.
4. **`secrets`:** stores the Worker secrets. When `ANALYTICS_TOKEN` is set in the environment (a dedicated read-only token with Account Analytics: Read, never your deploy token), it stores it on every run. Otherwise, without `--json` or `--yes`, it offers to store one for the Usage page, with a link that pre-fills the token form.
5. **`deploy`:** builds the server, applies database migrations, and deploys the Worker. If the live version is the one setup last deployed and a dry-run build of the Worker (its .js and .wasm output, built twice to check it is deterministic) plus the rendered config, wrangler version and repo version hash the same as last time (`state.deployHash`), it skips `wrangler deploy` and the line is `skipped` ("already deployed <version>"); migrations still run. An unknown hash (a failed dry run, a non-deterministic build) never skips, and a rollback clears the hash.
6. **`healthcheck`:** before any token is minted, checks `/healthz` (and that its `plan` matches the `PLAN` var setup rendered), the OIDC discovery document and, for email, the `EMAIL` binding. It retries for about a minute while certificates and the deploy propagate, and for up to 5 minutes while the app or content host doesn't resolve. After about a minute it asks public DNS (over DoH; A, AAAA and CNAME all count): a live record means your machine's DNS cache has a stale miss (`action_required`, with the flush command for your OS); if the record isn't live it keeps waiting, then fails naming the missing record. If DoH can't answer, it says so and to wait 2 minutes and rerun. Under `--ci` there is no extra wait and no DoH: about a minute, then an error with the cause code.
7. **`owner-token`:** mints a personal access token for the owner, unless setup already minted one that's still valid, and saves it to `~/.open-artifacts/<host-slug>-pat-token` (mode 0600) without printing it.
8. **`selftest`:** publishes the Welcome artifact over MCP with this run's token (or, on a rerun, the saved token file) and checks that its content is served. The page is published only when its text changed since the last publish. A missing file is a note, not a failure; a saved token the server rejects (401 or 403) is `action_required` (exit 2) with `data.tokenRejected: true`: rerun with `--new-owner-token` and update the client.
9. **`agent-config`:** prints the MCP URL and config snippets. It always runs, even when `healthcheck` or `selftest` fails (then with the OAuth snippets only; the token-file fallbacks appear once the token exists).

## Plan warnings

The `prereqs` line's `data.warnings` holds one `{ code, plan, message }` per note below, and agents relay each `message` verbatim. With `data.plan` `unknown`, setup sends the first five; with `free`, the same minus `plan-unknown`. `browser-free` appears only with `--browser` on a plan that isn't `paid`. Once Paid is confirmed (`--yes-paid`, `--plan paid`, or a saved plan), none of these warnings are sent, and the `prereqs` message says how it was confirmed.

{PLAN_WARNINGS_TABLE}

On Workers Paid (`data.plan` `paid`), `data.warnings` is empty and the `prereqs` line says so in `data.notes` ("Workers Paid detected"). When `prereqs` stops because a hostname isn't in a zone, its `action_required` line carries only `data.missing`: no plan, no warnings, and no "Workers Paid detected".

## Cloudflare Access permissions

The token from `wrangler login` may not be able to manage Zero Trust (Access). If it can't, the `access` step asks for an API token with Access: Apps and Policies Edit and Access: Organizations Read, and links to a pre-filled form for creating one. Save it with the line from `--token-links` (setup reads `~/.open-artifacts/<name>-access-token`); in an interactive run, you can paste it at the prompt instead. Setup doesn't keep it. Later runs skip re-checking Access without it, unless the app host or account changes. If the account has no Zero Trust organization yet, setup links to the Zero Trust dashboard to turn it on. Zero Trust's free plan is enough.
