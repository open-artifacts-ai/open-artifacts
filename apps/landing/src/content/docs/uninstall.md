---
title: Uninstall
description: Remove a self-hosted instance, piece by piece, without leaving anything dangling.
order: 7
---

Setup has no delete command yet. To see exactly what your instance has, run the dry run from the directory setup cloned into. It reads only the saved state and changes nothing:

```sh
pnpm --reporter=silent oa:setup --uninstall --check
```

Add `--json` for a machine-readable list. With no saved state, pass `--name`. Then remove the pieces in this order, so nothing points at something already gone.

## Before you start

Deleting the D1 database and the R2 bucket destroys every artifact, version, share, and live-page data value. It cannot be undone. Save what you want first. A one-step export is on the way; until then, ask any AI agent: "Save the latest version of every artifact I own into a folder on this computer." Check the folder before you go on.

## Order

1. **The Access app.** Zero Trust dashboard, Access, Applications, the app named like your install, Delete. Its policy, "Open Artifacts - everyone", can go too if nothing else uses it. Do this first so no login page is left guarding a host with nothing behind it.
2. **The email domain, if you turned on email.** Dashboard, Email Service, Email Sending, remove the sending domain. Then delete the `cf-bounce`, `_domainkey` and `_dmarc` records it added in the zone's DNS page.
3. **The custom domains.** The app host and the content host are attached to the Worker. Deleting the Worker releases them. To free them first: Workers & Pages, the Worker, Settings, Domains & Routes, delete each.
4. **The Worker.** `pnpm --dir apps/server exec wrangler delete --name <name>`. This also removes its Durable Objects, which hold live-page and agent bus state.
5. **The KV namespace** (`<name>-oauth`). `pnpm --dir apps/server exec wrangler kv namespace delete --namespace-id <id>`.
6. **The D1 database** (`<name>`). `pnpm --dir apps/server exec wrangler d1 delete <name>`. This destroys data.
7. **The R2 bucket** (`<name>`). Empty it in the dashboard first (R2, the bucket, Objects, select all, Delete), then `pnpm --dir apps/server exec wrangler r2 bucket delete <name>`. This destroys data.
8. **Local files, last.** Delete `.openartifacts/state.json` in the clone and `~/.open-artifacts/<name>-*-token` (plus `<host>-pat-token`). Revoke the Cloudflare API tokens you made for setup in the dashboard (My Profile, API Tokens).

The dry run prints the ids and names for your instance, so you can paste the commands as they are.
