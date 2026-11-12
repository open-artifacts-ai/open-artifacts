---
title: Self-hosting costs
description: What an instance costs on Cloudflare's free and paid plans.
order: 7
---

Every feature works on the Cloudflare Workers Free plan. For personal use, an instance usually costs nothing.

## What it uses

| Cloudflare product | Used for |
|---|---|
| Workers | The app, the MCP server, the API, and artifact serving |
| D1 | Metadata and the search index |
| R2 | Artifact files and thumbnails |
| KV | OAuth state for MCP clients |
| Durable Objects | Live-page data, one per artifact |
| Access (Zero Trust) | Login |

## Access login seats

Every person who logs in to your instance through Cloudflare Access, viewers included, uses a Zero Trust seat. A seat is held until you remove the user, however many times they log in.

- **Free plan:** up to 50 users at no cost. Once all 50 seats are used, new users can't log in.
- **Pay-as-you-go:** $7 per user per month, and every user is billable, not just those past 50.

To see or free seats, open **Zero Trust → Team & Resources → Users** in the Cloudflare dashboard. You can also turn on seat expiration there, so people who haven't logged in for a while stop using a seat. Sources: Cloudflare's [seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/) docs and [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).

A personal instance uses one seat. For a team, count everyone you'll share with. A login option that doesn't use Access is planned.

## Staying within the free plan

The free plan allows 100,000 Worker requests a day and 10 ms of CPU time per request. Open Artifacts is built to those limits:

- Markdown, code highlighting, PDFs, and diffs render in the viewer's browser, not the Worker.
- Large uploads stream straight to R2 instead of passing through the Worker.
- Every request path is tested against the CPU budget.

The dashboard's **Usage** page shows today's requests, database reads and writes, and KV writes, plus a CPU card with how many requests hit the CPU limit and how much CPU a typical busy request uses. It warns as you near the limits. It needs an optional `ANALYTICS_TOKEN` secret with Account Analytics read access; without it, the page explains how to add one.

## Free vs Paid limits

An instance applies the Workers Free limits unless its Worker variable `PLAN` is `paid`. Setup sets `PLAN` from your Cloudflare plan: `paid` when it reads Workers Paid or you pass `--yes-paid`, otherwise `free`. Pass `--plan paid` or `--plan free` to choose it yourself. `/healthz` reports the value as `plan`.

| Limit | Workers Free | Workers Paid |
|---|---|---|
| Live-page data document size | {LIMIT_DATA_DOC_FREE} | {LIMIT_DATA_DOC_PAID} |
| MCP request size | {LIMIT_MCP_BODY_FREE} | {LIMIT_MCP_BODY_PAID} |
| CPU time per request | 10 ms | 30 seconds |

## Hitting the CPU limit

On the Workers Free plan, each request gets 10 ms of CPU time. A request that needs more is stopped by Cloudflare. You might notice:

- A publish or a page load that fails, sometimes with Cloudflare's **Error 1102** ("Worker exceeded resource limits").
- An agent reporting a failed publish that works when it tries again.
- A note at the end of an agent's tool result saying your instance hit the free-plan CPU limit several times today. It appears once there are 3 or more hits in a day.
- A notice in the dashboard saying your instance hit the CPU limit today.

It usually comes from bursts of large publishes. A few hits a day are normal, and a retry generally succeeds.

To see how often it happens, open **Settings → Usage** in the dashboard. The CPU card shows how many requests hit the limit today and how much CPU a typical busy request uses compared with the 10 ms budget.

If it happens often, move the account to Workers Paid ($5 a month), which raises the limit to 30 seconds per request. In the Cloudflare dashboard, go to **Workers & Pages → Plans** and choose Paid. The CPU limit rises right away. To also get the Paid size limits above, run setup again with `--upgrade --plan paid`.

## When to upgrade

The free plan handles personal use; sustained bursts of large publishes can exceed the 10 ms CPU limit. Workers Paid ($5 a month) is recommended for heavy or team use.

Consider Workers Paid (from $5 a month) if you publish heavily, share public links that get a lot of traffic, or run busy live pages. Paid plans raise the request and CPU limits. After upgrading, run setup again with `--upgrade --plan paid` so the instance uses the Paid limits too.

Server-side thumbnails (Browser Run) are best-effort and work best on Workers Paid. On Free, previews fall back to the in-browser capture.

Cloudflare's free allowances change from time to time. Check Cloudflare's pricing pages for the current numbers.
