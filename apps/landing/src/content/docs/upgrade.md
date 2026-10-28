---
title: Upgrade
description: Move an existing instance to the latest release without losing data.
order: 6
---

Upgrades keep all your artifacts, versions, shares, and live-page data. Database migrations add to the schema; they never rename or drop anything your data depends on. One migration, `0017_image_format`, rebuilds three tables to allow image artifacts; it runs guarded (see below).

## Steps

1. **Go to the existing install:** `cd` into the directory setup cloned into (by default `~/open-artifacts`). If it's gone, for example on a new machine or in CI, clone the latest release as in [setup](/docs/setup/) and continue from step 3. Without its saved state, add the install's `--name` (and `--account-id` if the login has several accounts); setup reads the hosts and owner email from the deployed Worker. It also re-verifies Access, so you may need the Access token again if the Cloudflare login can't read Access; save it as in [setup](/docs/setup/).
2. **Check out the latest release.** This is the latest stable GitHub release; pre-releases are skipped. Release tags look like `vX.Y.Z`:

   ```sh
   TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
   git fetch --depth 1 origin tag "$TAG"
   git checkout "$TAG"
   ```

   If `TAG` comes back empty or `curl` fails, stop and tell the user: "Open Artifacts has no stable release yet; check back later."
3. **Install dependencies:** `pnpm install`.
4. **Preview, if you like:** `pnpm -s oa:setup --upgrade --check --json` is read-only. It reports each step as `done` or `todo` without changing anything, so you can see what the upgrade would do. Steps that always run show `todo`; that isn't pending work.
5. **Run the upgrade:** `pnpm -s oa:setup --upgrade --json`. It reuses the hostnames and email saved by setup. Every step runs, but only `deploy` (new database migrations, then a redeploy), `healthcheck`, `selftest` and `agent-config` do work: `prereqs` reports `ok` (its `data.warnings` and `data.notes` hold plan warnings and notes) and `resources` verifies, and `access`, `secrets` and `owner-token` report `skipped` unless something is missing. It keeps the existing owner token and needs no `OA_ACCESS_TOKEN` when the state is saved. It never creates resources: if one is missing, it reports `action_required` and asks for a full setup. Go by the exit code, as in setup:
   - **0:** done.
   - **2:** relay the `action_required` line's `message` to the user verbatim, wait until they've done it, then run the same command again.
   - **1:** show the user the `error` line's `message`. If it says to rerun setup without `--upgrade`, run `pnpm -s oa:setup --json`, then the upgrade again. That run may need the Access token again. Get its save line from `pnpm -s oa:setup --token-links --json` (`saveCommand`) and have the user run it in their own terminal (in Claude Code, type `! ` then the line). Never paste a token into the chat. If `read` fails, the shell can't hide input, so use a real terminal. Setup then reads `~/.open-artifacts/<name>-access-token`.
6. **Tell the user** which version is now running: the `deploy` line's `data.deployedVersion`.

## The guarded migration (0017, image format)

Migration `0017_image_format` rebuilds the `artifacts`, `versions` and `shares` tables to widen their format check to `image`, keeping every row and rowid, index, trigger and the search index. Because it isn't purely additive, record a way back and check the result. From the release directory, with the deploy token in `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if the token reaches several accounts), and `<db>` your install name:

1. **Capture** the database before the upgrade. Exit 1 with "already applied" means the instance already has it: upgrade as usual. Any other exit 1, or exit 2: stop, and don't upgrade; the message says why.

   ```sh
   node --experimental-strip-types apps/server/scripts/verify-migration.ts capture --db <db> --out .openartifacts/migration-0017-before.json
   ```

2. **Record a D1 Time Travel bookmark** and keep its `bookmark` value:

   ```sh
   pnpm -s --filter @oa/server exec wrangler d1 time-travel info <db> --json
   ```

3. **Upgrade** (step 5 above).
4. **Verify.** Exit 0 means every row, index, trigger and the search index are as before, `foreign_key_check` is empty and the integrity check passes.

   ```sh
   node --experimental-strip-types apps/server/scripts/verify-migration.ts verify --db <db> --in .openartifacts/migration-0017-before.json
   ```

5. **If verify fails**, restore the database and roll the Worker back. A restore discards every write since the bookmark: anything published, shared or written to live data during the upgrade is lost.

   ```sh
   pnpm -s --filter @oa/server exec wrangler d1 time-travel restore <db> --bookmark=<bookmark>
   pnpm -s oa:setup --rollback --json
   ```

Verify reports rows added while the upgrade ran as notes, never as failures, and so are rows the app deleted meanwhile when their audit row or state explains them (an unshare, a transfer, a directory removal, an address change, the trash purge). A captured row that's gone otherwise, a change to the three rebuilt tables other than the widened check, a search row detached from its artifact, a foreign key violation or a failed integrity check fails it. Later migrations may add or change other objects.

## If the Cloudflare login has expired

The `prereqs` step fails with an error. Ask the user to run `npx wrangler login` again, then re-run the upgrade.
