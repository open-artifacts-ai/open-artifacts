---
title: Uninstall
description: Remove a self-hosted instance, piece by piece, without leaving anything dangling.
order: 7
---

Setup has no delete command yet. To see exactly what your instance has, run the dry run from the directory setup cloned into. It reads only the saved state and changes nothing:

```sh
pnpm --reporter=silent oa:setup --uninstall --check
```

Add `--json` for a machine-readable list. With no saved state, pass `--name`; it lists the resources by name (`<name>`, `<name>-oauth`), and the KV step shows how to find its id. A `--name` that differs from the saved one is refused. Then remove the pieces in this order, so nothing points at something already gone.

## Before you start: back up

Deleting the D1 database and the R2 bucket destroys every artifact, version, share, and live-page data value. It cannot be undone. Back up first, from `apps/server`'s wrangler (`pnpm --dir apps/server exec wrangler ...`):

- **Database:** a whole-database `wrangler d1 export` fails here, because the search index is a virtual table. Export table by table. First list the tables: `wrangler d1 execute <name> --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'artifact_search%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"`. Then for each table `<t>`: `wrangler d1 export <name> --remote --table <t> --output <t>.sql`. The search index is not exported; it is rebuilt from the artifacts. An export locks the database while it runs.
- **Files in R2:** `rclone sync r2:<name> ./backup-r2` copies the whole bucket. It needs R2 S3 credentials (dashboard, R2, Manage API Tokens). To fetch single keys, list them in the dashboard or with `rclone lsf r2:<name>`, then `wrangler r2 object get <name>/<key> --remote --file <path>`. Without `--remote`, wrangler reads a local store, not your bucket.
- **Not exported:** live-page and agent bus state lives in Durable Objects, which deleting the Worker destroys. No export covers it.
- **Lighter option:** ask any AI agent: "Save the latest version of every artifact I own into a folder on this computer." This saves only the latest versions, not history, shares or data.

Check the backup before you go on.

## Order

1. **The Access app** (and any orphaned one: `state.json` `pendingAccessAppId` is an app a stopped setup run left behind). Zero Trust dashboard, Access, Applications, the app named like your install, Delete. Its policy, "Open Artifacts – everyone", can go too if nothing else uses it. Do this first so no login page is left guarding a host with nothing behind it.
2. **The email domain, if you turned on email.** Dashboard, Email Service, Email Sending, remove the sending domain (`<domain>` is `mail.<app host>` unless you passed `--email-domain`). Then in the zone's DNS page delete what onboarding added: MX `cf-bounce.<domain>`, TXT `cf-bounce.<domain>` (SPF), and TXT `cf-bounce._domainkey.<domain>` (DKIM). Delete TXT `_dmarc.<domain>` only if onboarding created it; on an apex sending domain it may be your own policy.
3. **The custom domains.** The app host and the content host are attached to the Worker. Deleting the Worker releases them. To free them first: Workers & Pages, the Worker, Settings, Domains & Routes, delete each.
4. **The Worker.** `pnpm --dir apps/server exec wrangler delete --name <name>`. This destroys its Durable Objects (`ArtifactRuntime`, `BusHub`, `DirectorySync`, `UserPresence`), which hold live-page and agent bus state. That state is not exported and is lost.
5. **The KV namespace** (`<name>-oauth`). `pnpm --dir apps/server exec wrangler kv namespace delete --namespace-id <id>`.
6. **The D1 database** (`<name>`). `pnpm --dir apps/server exec wrangler d1 delete <name>`. This destroys data. Cloudflare can undelete a D1 database only within 7 days.
7. **The R2 bucket** (`<name>`). Empty it first. The dashboard's select all clears only the listed page, so for a bulk path add a lifecycle rule that expires all objects (R2, the bucket, Settings, Object lifecycle rules) and wait for it to run, or run `rclone purge r2:<name>`. Then `pnpm --dir apps/server exec wrangler r2 bucket delete <name>`. This destroys data.
8. **Local files, last.** Delete `.openartifacts/state.json` and the rendered `apps/server/wrangler.jsonc` in the clone and `~/.open-artifacts/<name>-*-token` (plus `<host>-pat-token`). Revoke the Cloudflare API tokens you made for setup in the dashboard (My Profile, API Tokens).

The dry run prints the ids and names for your instance, so you can paste the commands as they are.
