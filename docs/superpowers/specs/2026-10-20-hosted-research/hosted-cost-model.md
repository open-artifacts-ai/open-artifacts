# Hosted Open Artifacts: Cloudflare cost model

Date: 2026-10-20. Inputs: design spec `openartifacts-hosted-design/docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md`, code at `origin/main` (62ee196), Cloudflare docs fetched today. Calculator: `scratchpad/model.py` (same folder as this file).

## Bottom line

1. **Cloudflare usage per install costs cents to low dollars a month**: Small about $0.25, Medium about $1.30, Large about $15 (heavy live data). That is at list overage rates, ignoring the per-account free allowances that absorb most of it.
2. **Zero Trust seats break the plan.** Access bills a seat for **every user who signs in**, viewers included, at $7 per user per month on Pay-as-you-go. The 50 free users are **per Zero Trust organization**, and the design puts every customer in one organization, so the free 50 cover everyone across all customers combined (the design partner alone may use them up). With Access in the sign-in path, seats cost 20 to 70 times all other costs combined (Small: $140 against about $7), and the gross margin on Team goes negative for every profile.
3. **Recommendation:** take Access out of the per-viewer path. The Worker is already a generic OIDC client (`apps/server/src/auth/oidc.ts`, pointed at the Access team domain). Have each install talk OIDC directly to the customer's IdP (Okta, Google, Entra), and send one-time codes for invited outsiders with Email Sending. Then the gross margin is about 95% or more at the draft prices, and the 50-IdP-per-organization ceiling and the shared-organization risk to the isolation anti-goal both go away.
4. **The draft storage pool (10 GB plus 5 GB per creator) is already above the p95 level** and costs at most about $8 a month even when full (Large). Live data should be metered as **data writes**: 250k a month plus 50k per creator (Team), doubled for Business. Suggested overage: **$0.10 per GB-month** and **$10 per million writes**.

## 1. Billable resources one install uses (from code)

From `apps/server/wrangler.template.jsonc` and `apps/server/src`:

| Resource | Binding / use | Per install or shared |
|---|---|---|
| Workers (one Worker, app host plus content host, `run_worker_first: true` so static asset hits also invoke it) | requests, CPU | Worker per install; request and CPU allowances shared per account |
| D1 `DB` | metadata, shares, users, FTS5 search index (`artifact_search`), counters | DB per install; allowance per account |
| R2 `FILES` | every version's files (`files/<id>/<newId>`: **no dedupe across versions**), thumbnails `thumbs/<id>.webp` (≤200 KB) | bucket per install |
| KV `OAUTH_KV` | MCP OAuth state and tokens (reads per OAuth MCP call, writes only on grants and refresh) | namespace per install (1,000 per account limit) |
| Durable Objects `ArtifactRuntime` (SQLite) | one per artifact: live data docs, per-viewer storage, hibernatable WebSockets (≤200 per DO), the index and thumbnail job alarm | per install |
| Browser Run `BROWSER` | server thumbnails (`SERVER_THUMBNAILS: "on"`), up to 15 s per capture | shared per account |
| Email Sending `EMAIL` | invite and share emails | 3,000 a month included **per account** |
| Rate limiting `RL_ANON` | anonymous writes | free |
| Workers Logs (`observability.enabled`) | about 1 event per invocation | allowance per account |
| Cron, daily | purge, sweeps, reindex | negligible |
| Access (Zero Trust) | sign-in today (Access for SaaS OIDC) | **seats per organization** |

### Operations per action

Counts come from the code paths and the deterministic binding-count tests (`apps/server/test/cpu-budget/structural.test.ts`). CPU uses staging `cpuTime`, which includes 8–15 ms of runtime overhead per request (`docs/ops/cpu-budget.md`); I use about 5 ms per request.

| Action | Worker req | D1 | R2 | DO | Other |
|---|---|---|---|---|---|
| **Page view** (viewer shell, metadata API, content frame, one subresource) | ~6 | ~5 queries (getUser, accessLevel join, content `load`), ~12 rows read | 2 Class B GET | 0 (1 more if the page subscribes) | session is a stateless signed cookie, no KV |
| **Library browse** (list 25 plus thumbnails) | ~27 | list ≤3 queries (tested) plus one per thumbnail | 25 Class B | 0 | |
| **Publish, inline** (tested: ≤16 D1+R2 calls, 1 R2 put per file, 1 DO enqueue) | 1, plus ~3 for the thumbnail capture loading content | ~25 rows written (artifact, version, FTS insert-or-replace, which bills its index rows), ~60 read | 1–2 Class A (files), 1 Class A (thumbnail) plus HEAD | 3 requests (enqueue, index alarm, thumbnail alarm), ~6 rows written (jobs plus `setAlarm`, each bills 1 row), ~1.3 GB-s (capture I/O keeps the DO in memory) | ~8 s of Browser Run |
| **Publish, upload path** | +2 (create_upload, PUT) | +2 | +1 Class A per file | same | |
| **MCP call** (non-publish tool) | 1 | ≤3 queries (PAT or token, user) | 0 | 0 unless a data tool | 1 KV read (OAuth bearer); PATs use D1 |
| **Live-data write** (`db.set` and similar, tested: exactly 1 DO call) | 1 | ≤3 queries (gate) | 0 | 1 request, ≤3 rows written (`docs` upsert, `totals`; LIMITS docs say "≤3 DO rows each") | broadcasts to sockets are outgoing, so free |
| **WebSocket subscriber, per connected hour** | ~12 (reconnect every 10 min: signed URL TTL 600 s, plus resync fetch) | ~18 queries | 0 | ~18 requests (connect, resync, TTL alarm), ~12 rows written (`setAlarm`), hibernated so ~0.1 GB-s | incoming client messages close the socket (subscribe-only) |

Unit cost at overage list price: page view $6.7 per million; MCP call $1.5 per million; live write **$4.8 per million** (60% of it is DO rows written at $1/M); subscriber-hour $39 per million; publish **$264 per million** (Browser Run plus DO duration plus D1 writes).

## 2. Cloudflare pricing (docs, 2026-10-20)

| Product | Included (monthly) | Overage | Scope |
|---|---|---|---|
| Workers Paid | $5 base; 10M requests; 30M CPU ms | $0.30/M req; $0.02/M CPU ms | per account |
| Durable Objects | 1M requests; 400k GB-s; 25B rows read; 50M rows written; 5 GB SQLite | $0.15/M; $12.50/M GB-s; $0.001/M; $1.00/M; $0.20/GB-mo | per account. Alarms and WS connects are requests; incoming WS messages bill 20:1; outgoing free; hibernation-eligible idle time not billed |
| D1 | 25B rows read; 50M written; 5 GB | $0.001/M; $1.00/M; $0.75/GB-mo | per account (storage summed over all DBs). Limits: 50,000 DBs, **10 GB per DB (cannot be raised)**, 1 TB per account |
| R2 Standard | 10 GB-mo; 1M Class A; 10M Class B | $0.015/GB-mo; $4.50/M A; $0.36/M B; egress free | per account. 1,000,000 buckets |
| KV | 10M reads; 1M writes; 1 GB | $0.50/M; $5.00/M; $0.50/GB-mo | per account |
| Email Sending | 3,000 emails | $0.35 per 1,000 | per account |
| Browser Run | 10 browser-hours; 10 concurrent | $0.09/h; $2 per extra concurrent | per account |
| Workers Logs | 20M events (until Nov 30 2026) | $0.60/M; from **Dec 1 2026**: 50 GB ingest included, $0.25/GB | per account |
| Workers for Platforms | $25 base; 20M req; 60M CPU ms; 1,000 scripts | $0.30/M; $0.02/M ms; $0.02 per script | per account (optional) |
| Cloudflare for SaaS | 100 custom hostnames (Free/Pro/Business zone) | $0.10 per hostname-month | per zone |
| **Zero Trust / Access** | **Free: 50 users per organization, hard cap** (user 51 is blocked) | **Pay-as-you-go $7 per user per month, every seat billable** once off Free; Contract custom | **per Zero Trust organization** |

Sources: developers.cloudflare.com/workers/platform/pricing, /durable-objects/platform/pricing, /r2/pricing, /d1/platform/limits, /r2/platform/limits, /email-service/platform/pricing, /browser-run/pricing, /observability/pricing, /cloudflare-for-platforms/workers-for-platforms/platform/pricing, /cloudflare-for-platforms/cloudflare-for-saas/plans, /cloudflare-one/team-and-resources/users/seat-management; cloudflare.com/plans/zero-trust-services (Free 50, $7 PAYG).

### Zero Trust seats: do viewers count?

**Yes, per the docs.** Seat management: "A user consumes a seat when they perform an authentication event", including "any Cloudflare Access authentication event, such as a login to the App Launcher or an application". An Access for SaaS app is an Access application, so every employee who opens an artifact (and every outside guest who signs in with an Access one-time PIN) takes a seat. A user keeps one seat no matter how many apps they open, and holds it **until removed**. Seat expiry can be set to remove users after **1 month to 1 year** of inactivity, which doesn't help with weekly-active viewers. Revoking sessions doesn't free a seat. Service tokens and Bypass policies don't use seats, but neither identifies a human viewer.

Consequences under the design's single shared organization:
- The free 50 users are **shared across all customers**. Small alone uses 20, Medium alone uses 100.
- On Pay-as-you-go, **every** user is billable, not just users past 50: Small $140, Medium $700, Large $3,500 a month.
- The docs don't separately exempt SaaS-type apps. Confirm with Cloudflare sales, and ask about a Contract or Externa package (Externa includes 50 Interna Essentials seats; anything more is a custom price).

## 3. Profiles and assumptions

Common: 22 workdays a month; ~0.3 MB average version (inline cap 128 KB, plus some uploads); 0.1 MB thumbnail per artifact; every version kept (no pruning in code); storage measured at **month 12**; one-time import counted as the artifacts' base storage; overage list prices with **no** free allowance credited (worst case once the account allowance is used up by many installs).

| | Small | Medium | Large |
|---|---|---|---|
| People / creators | 20 / 5 | 100 / 25 | 500 / 100 |
| Artifacts per creator | 50 | 60 | 80 |
| Page views per person per workday | 10 | 10 | 12 |
| Library browses per person per workday | 2 | 2 | 3 |
| Publishes per creator per month | 40 | 40 | 60 |
| MCP calls per creator per workday | 20 | 20 | 40 |
| Live writes per day | 200 (light) | 3,000 | 60,000, 30 days (agent-fed dashboards) |
| Concurrent subscribers × hours per day | 3 × 8 | 15 × 8 | 100 × 10, 30 days |
| Emails per month | 40 | 200 | 1,000 |

## 4. Results

### Cloudflare usage per install, per month (worst case, no allowance)

| | Small | Medium | Large |
|---|---|---|---|
| Worker requests | 64k | 363k | 3.96M |
| R2 stored at month 12 | 0.8 GB | 4.1 GB | 24 GB |
| DO rows written | 21k | 236k | 5.8M |
| **Usage cost** | **$0.24** | **$1.27** | **$14.89** |
| Biggest lines | D1 storage, logs, Browser Run | logs, DO rows, Browser Run | **DO rows written $5.80**, logs $3.79, Browser Run $1.20, requests $1.19 |

All three fit inside one account's included allowances (10M requests, 50M DO rows, 10 GB R2…) until there are roughly 3 Large or 30 Medium installs, so the real marginal cost of the first ~10 customers is close to $0.

### Fixed per-account costs (shared by all installs)

| Item | Monthly |
|---|---|
| Workers Paid | $5 |
| Workers for Platforms (optional; lifts the 500-Workers limit; 1,000 scripts) | $25 |
| Zone plan (Free works; Pro for WAF rules) | $0–20 |
| Custom hostnames for Business custom domains (2 per install, app and content; 100 free) | $0 until 50 custom-domain customers, then $0.20 per install |
| Hosted domain | ~$1 |
| Control-plane Worker, D1 | within the allowances |
| **Zero Trust** | **$0 up to 50 users in total; then $7 × every user across all customers** |
| **Total without ZT seats** | **about $6–51** (≈ $1–5 per customer at 10 customers) |

Not Cloudflare, but bigger than all usage: Stripe card fees (about 2.9% + $0.30 per invoice, US list; verify).

### Gross margin at the draft prices

Revenue: Team $10 and Business $25 per creator. Cost = usage + $5 fixed share (10 customers) + Stripe.

| | Small (5 creators) | Medium (25) | Large (100) |
|---|---|---|---|
| Revenue Team / Business | $50 / $125 | $250 / $625 | $1,000 / $2,500 |
| Cost, **no Access seats** | ~$7 / ~$9 | ~$14 / ~$25 | ~$49 / ~$93 |
| **Margin, no seats** | **86% / 93%** | **94% / 96%** | **95% / 96%** |
| Cost **with Access seats** ($7 × people) | $147 / $149 | $714 / $725 | $3,549 / $3,593 |
| **Margin with seats** | **−194% / −19%** | **−186% / −16%** | **−255% / −44%** |

On Team, seats cost $7 against $10 even when only creators sign in. Viewer seats sink both tiers.

### What dominates

1. **Zero Trust seats**, if Access stays in the viewer path: 20 to 70 times all other costs combined.
2. Without seats: **fixed overhead and Stripe fees** for small customers; for heavy live-data customers, **DO rows written** ($1/M, 3 rows per data write plus 1 per `setAlarm`), then logs and Browser Run thumbnails. Storage is never material: 500 GB of R2 is $7.50.

## 5. Allowances and overage

Sizing method: per-creator usage taken as lognormal (σ = 1.5, a heavy tail; p95 is about 12× the median), pooled per company, Monte Carlo for the 95th percentile of the pool (`model.py`).

**Storage** (R2 plus DO data, pooled; median 0.25 GB per creator per year):

| Creators | p95 pool | Draft pool (10 GB + 5 GB/creator) | Our cost if full |
|---|---|---|---|
| 5 | 11 GB | 35 GB | $0.53 |
| 25 | 37 GB | 135 GB | $2.03 |
| 100 | 115 GB | 510 GB | $7.65 |

Keep the draft pool for Team (it covers well over 95%). Business: 25 GB + 10 GB per creator. Overage **$0.10 per GB-month** (about 6× R2 list; the extra margin covers DO storage at $0.20 and D1 at $0.75).

**Live data**, metered as data and storage writes (each ≈ 3 DO rows plus a Worker request, ≈ $4.80 per million; subscribers aren't metered, already capped at 200 per artifact):

| Creators | p95 pool (median 5k writes per creator per month) | Team: 250k + 50k/creator | Business: 500k + 100k/creator | Our cost at Business full |
|---|---|---|---|---|
| 5 | 216k | 500k | 1.0M | $4.80 |
| 25 | 752k | 1.5M | 3.0M | $14.40 |
| 100 | 2.3M | 5.25M | 10.5M | $50 |

Overage **$10 per million writes** (about 2× cost). Alert at 80% and let the customer set a cap, as in the spec. The per-artifact daily cap `DATA_DAILY_WRITES` (default 10,000; Paid ceiling 1,000,000) bounds any single runaway artifact at $0.05 a day at default, or ~$3–5 a day at the ceiling. The Large profile (1.8M writes a month) fits both tiers without overage.

## 6. Biggest uncertainties

1. **Access seat treatment of Access for SaaS logins and OTP guests.** The docs say any Access authentication uses a seat. Get written confirmation and a quote from Cloudflare (Contract or Externa). This decides whether "viewers free" can survive with Access in the path.
2. **Moving off Access**: direct OIDC per install needs per-customer client registration, group-claim mapping (Okta, Google and Entra differ; Google Workspace groups need the Directory API or SCIM), our own OTP flow, and the security review that comes with it. The alternative, a third-party broker, has per-connection pricing I did not verify.
3. **Usage assumptions are guesses, not telemetry.** Instrument the self-hosted fleet or the design partner (the existing Usage page reads Account Analytics) before final pricing. The live-write distribution (σ) matters most.
4. **Runtime CPU overhead** of 8–15 ms per request on staging makes real CPU 2–5× code CPU. Even at 15 ms, CPU stays under $1 for Large.
5. **D1's 10 GB per-database hard limit** (FTS index 64 KB per artifact plus manifests): roughly 100k+ artifacts per install, fine for the profiles, but "unlimited artifacts" has a ceiling.
6. **Version retention**: R2 keeps every version with no dedupe. Agents republishing large files on a schedule is the most likely storage outlier. Cheap, but count it against the pool.
7. **Workers Logs moves to per-GB pricing on Dec 1 2026** (50 GB included, $0.25/GB). Likely cheaper than today's per-event price.
8. **Per-account allowances and limits are shared across installs**: Browser Run's 10 concurrent browsers and the per-account launch rate (`THUMB.launchGapMs` serializes launches per account) could throttle thumbnails across customers, and Email Sending's 3,000 a month is shared.
