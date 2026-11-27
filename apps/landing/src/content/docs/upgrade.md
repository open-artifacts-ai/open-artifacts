---
title: Upgrade
description: Move an existing instance to the latest release without losing data.
order: 6
---

A release may contain a reviewed migration that removes data. Before upgrading, check the release changes and record a restore point before every upgrade.

## Steps

1. **Go to the existing install:** `cd` into the directory setup cloned into (by default `~/open-artifacts`). If it's gone, for example on a new machine or in CI, clone the latest release as in [setup](/docs/setup/) and continue from step 4. Without its saved state, add the install's `--name` (and `--account-id` if the login has several accounts); setup reads the hosts and owner email from the deployed Worker. It also re-verifies Access, so you may need the Access token again if the Cloudflare login can't read Access; save it as in [setup](/docs/setup/).
2. **Check the git remote for credentials.** Never print the remote URL or the git settings: a token in the URL would be exposed. This prints a line only if the URL has a login in it:

   ```sh
   if git remote get-url origin | grep -qE '^https?://[^/]*@'; then echo "origin has credentials"; fi
   ```

   If it prints that line, take the login out of the URL before you go on. The repository is public, so fetching needs no login. Then revoke that token where you made it, since it was stored in plain text.

   ```sh
   git remote set-url origin "$(git remote get-url origin | sed -E 's#^(https?://)[^/]*@#\1#')"
   ```

   To show the remote without the login: `git remote get-url origin | sed -E 's#^(https?://)[^/]*@#\1***@#'`.
3. **Check out the latest release.** This is the latest stable GitHub release; pre-releases are skipped. Release tags look like `vX.Y.Z`:

   ```sh
   TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
   git fetch --depth 1 origin tag "$TAG"
   git checkout "$TAG"
   ```

   If `TAG` comes back empty or `curl` fails, stop and tell the user: "Open Artifacts has no stable release yet; check back later."

   An instance below 0.109.0 upgrades to `v0.109.0` first, then to the latest: from 0.109.0 the agent bus's storage ships one release before the code that turns it on. Setup stops with `action_required` and says so.
4. **Install dependencies:** `pnpm install --frozen-lockfile`.
5. **Preview, if you like:** `pnpm --reporter=silent oa:setup --upgrade --check --json` is read-only. It reports each step as `done` or `todo` without changing anything, so you can see what the upgrade would do. Steps that always run show `todo`; that isn't pending work.
6. **Record a restore point before every upgrade.** Replace `<name>` with the install name. Save the version ID serving 100% of the current Worker deployment and the D1 Time Travel bookmark. Stop if either is unavailable.

   ```sh
   pnpm -s --filter @oa/server exec wrangler deployments list --name <name> --json
   pnpm -s --filter @oa/server exec wrangler d1 time-travel info <name> --json
   ```

7. **Run the upgrade:** `pnpm --reporter=silent oa:setup --upgrade --json`. It uses your `wrangler login`. In CI, or on a machine with no login, use a Cloudflare deploy token instead, as your instance's `/upgrade.md` does. `pnpm --reporter=silent oa:setup --token-links --json` prints the link that creates it (with the permissions it needs) and the line that saves it as `~/.open-artifacts/<name>-cloudflare-token`. Run that line in your own terminal, then put `CLOUDFLARE_API_TOKEN="$(cat ~/.open-artifacts/<name>-cloudflare-token)"` in front of the command. It reuses the hostnames and email saved by setup. Every step runs, but only `deploy` (new database migrations, then a redeploy), `healthcheck`, `selftest` and `agent-config` do work: `prereqs` reports `ok` (its `data.warnings` and `data.notes` hold plan warnings and notes) and `resources` verifies, and `access`, `secrets` and `owner-token` report `skipped` unless something is missing. It keeps the existing owner token and needs no `OA_ACCESS_TOKEN` when the state is saved. It never creates resources: if one is missing, it reports `action_required` and asks for a full setup. Go by the exit code, as in setup:
   - **0:** continue to verification.
   - **2:** relay the `action_required` line's `message` to the user verbatim, wait until they've done it, then run the same command again.
   - **1:** show the user the `error` line's `message`. If it says to rerun setup without `--upgrade`, run `pnpm --reporter=silent oa:setup --json`, then the upgrade again. That run may need the Access token again. Get its save line from `pnpm --reporter=silent oa:setup --token-links --json` (`saveCommand`) and have the user run it in their own terminal (in Claude Code, type `! ` then the line). Never paste a token into the chat. If `read` fails, the shell can't hide input, so use a real terminal. Setup then reads `~/.open-artifacts/<name>-access-token`.
8. **Verify the release.** Set `TAG` to the exact release tag you checked out, `NAME` to the install name and `ORIGIN` to the instance origin. Use the same Cloudflare credentials as setup. From the release checkout, compare the remote D1 ledger to the tag and check that the live instance is healthy on that version.

   ```sh
   PROD_NAME="$NAME" TAG="$TAG" bash scripts/ci/prod-migration-guard.sh verify &&
     health="$(curl -fsS "$ORIGIN/healthz")" &&
     printf '%s' "$health" | jq -es --arg version "${TAG#v}" 'length == 1 and (.[0] | .ok == true and .version == $version)'
   ```

   On either mismatch or command failure, stop and retain the recorded Worker version and bookmark. Restoring D1 discards writes made since the bookmark and requires a separate decision. Report success only when both checks pass.

## If the Cloudflare login has expired

The `prereqs` step fails with an error. Ask the user to run `npx wrangler login` again, then re-run the upgrade.
