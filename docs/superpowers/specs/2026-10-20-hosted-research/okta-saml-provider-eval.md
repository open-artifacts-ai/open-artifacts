# Okta and generic SAML sign-in: Clerk vs WorkOS

Date: 2026-10-20. Scope: only the Okta (OIDC/SAML) and generic SAML customers of Hosted Open Artifacts. Google Workspace and Entra stay on our own multi-tenant apps.

Context read: hosted design spec (`openartifacts-hosted-design/docs/superpowers/specs/2026-10-20-hosted-open-artifacts-design.md`, lines 56-67, 129, 137-141) and `origin/main:apps/server/src/auth/{oidc,session}.ts`. Today's server runs OIDC + PKCE against Cloudflare Access for SaaS, keeps per-attempt `__Host-oa_oidc_<k>` HMAC state cookies, and issues its own HMAC-signed `__Host-oa_session`. Both vendors below can sit behind that flow without owning our session. WorkOS fits it with less work and more safety.

## Recommendation

**Use WorkOS, through its standalone SSO API (not AuthKit) plus Directory Sync. Run it through one central "auth broker" Worker in the control plane. Installs never hold the WorkOS API key.**

Why:
- **Explicit tenant binding.** Our server names the organization (`organization=org_…`) on every authorize call. The profile comes back with `organization_id` and `connection_id`, so we check them by exact equality. WorkOS also rejects emails outside the org's verified domains by default.
- **No shared upstream session.** WorkOS has no session cookie that could carry customer A's user into customer B's install.
- **IdP-initiated SAML becomes SP-initiated.** WorkOS sends the user to our sign-in endpoint with `connection_id`, so we never accept unsolicited assertions.
- **Self-serve setup links.** Admin Portal gives 30-day setup links we can email, or 5-minute API links. Nothing needs a vendor frontend SDK.
- **Better sync channel.** The Events API is ordered and replayable, on top of webhooks.

Clerk is cheaper per connection, but it is a poor fit for this model:
- **It is a full user and session system.** Used as a broker, it is "Clerk as OAuth/OIDC provider" sitting in front of Clerk's own sign-in UI and session.
- **We can't pick the connection or org on authorize.** `org_id` in the token is whichever org the user picks on the consent screen, or their last active org.
- **Self-serve SSO and SCIM setup lives only inside the `<OrganizationProfile />` React component.**
- **Every customer's users sit in one shared Clerk user pool.**

## 1. Pricing

### List prices

| | WorkOS | Clerk |
|---|---|---|
| Base fee | None for SSO/Directory Sync. Optional custom domain $99/mo. | Pro $25/mo ($20 annual) or Business $300/mo ($250 annual). The SOC 2 report is Business-only. The B2B ("Enhanced" Organizations) add-on is $100/mo ($85 annual). It is needed to link connections to orgs and for self-serve SSO and SCIM. |
| SSO connection | $125 (1-15), $100 (16-30), $80 (31-50), $65 (51-100), custom (101+) | 1 included per app. Then $75 (2-15), $60 (16-100), contact sales (101+). |
| SCIM directory | **Extra.** Separate connection with the same tiers as SSO. | **Extra.** Billed separately from SSO, with the same tiers. 1 included per app. **No charge until 2027-01-01.** |
| Users | Standalone SSO has no MAU fee. AuthKit is 1M MAU free if used. | 50k MRU per app included, then $0.02 and down. 100 MROs included, then $1 and down. |
| Free allowance | No free production connections. | 1 SSO + 1 SCIM per app (production needs Pro). |

Sources: https://workos.com/pricing, https://clerk.com/pricing, https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync

### Monthly cost estimate

Each customer has one SSO connection plus one SCIM directory. Tiers are assumed to be graduated (the pricing pages don't say). 500 customers is past the list tiers, so that row uses the last list rate as a ceiling.

| Customers | WorkOS (SSO + DSync) | Clerk, one shared app (Pro + B2B add-on) |
|---|---|---|
| 1 | $250 | $125 |
| 10 | $2,500 | $1,475 |
| 50 | $9,950 (or $8,000 if a flat volume rate) | $6,425 |
| 500 | ≤ ~$68,450 at list, custom in practice | ≤ ~$60,800 plus MRO/MRU overage, custom in practice |

Clerk is roughly 40% cheaper at small scale, and the gap closes at 500. Both vendors get negotiated above 100 connections.

A Clerk variant with one Clerk app per customer would cost $25/customer with dashboard-configured connections and no org features. With self-serve it would be $125/customer. It would also need a Clerk production domain (CNAMEs) per install, and I found no official API for creating apps. Not recommended.

## 2. Okta, generic SAML, and self-serve setup

- **WorkOS.** Supports SAML (Okta and generic) and OIDC connections.
  - Admin Portal intents: `sso`, `dsync`, `domain_verification`, `certificate_renewal`.
  - Dashboard setup links last 30 days or until setup completes, one active at a time, and can be emailed.
  - API portal links expire in 5 minutes, so our console redirects straight to them.
  - The portal includes per-IdP walkthroughs.
  - Source: https://workos.com/docs/admin-portal
- **Clerk.** Supports Okta Workforce, custom SAML and custom OIDC.
  - Self-serve SSO (GA 2026-06-26, OIDC added 2026-07-30) and self-serve Directory Sync (2026-09-30) are available.
  - Both run **only inside the Security tab of `<OrganizationProfile />`**. There is no hosted page or setup link. We would have to embed Clerk's frontend SDK in our console.
  - Production needs Pro/Business plus the B2B add-on.
  - Sources: https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/self-serve-sso.md, https://clerk.com/changelog/2026-09-30-self-serve-directory-sync

## 3. Directory sync

- **WorkOS.** Supports Okta SCIM and generic SCIM.
  - Events: `dsync.user.created/updated/deleted`, `dsync.group.created/updated/deleted`, `dsync.group.user_added/user_removed`, `dsync.activated/deleted`.
  - Suspension usually arrives as `dsync.user.updated` with `state: inactive`, not as a delete. Environments created after 2023-10-19 delete inactive users unless support changes this.
  - Deleting a whole directory sends only `dsync.deleted`, with no per-user deletes. The handler must treat that as "revoke everyone from this directory".
  - **Webhooks** are real time, unordered, retried with exponential back-off for up to 3 days, and signed.
  - **Events API** (`GET /events?events=…&organization_id=…&after=…`) is ordered and replayable. WorkOS recommends it for directory events.
  - Docs suggest a periodic State API reconciliation every 1-6 hours. Group-membership changes don't bump `updated_at`.
  - Sources: https://workos.com/docs/directory-sync/understanding-events, https://workos.com/docs/events/data-syncing, https://workos.com/docs/reference/events
- **Clerk.** Supports Okta, Entra and generic SCIM 2.0. Google is handled by Admin SDK polling about every 5 minutes.
  - On deprovision, Clerk sets `deprovisioned: true` and **revokes Clerk sessions**. SCIM DELETE means deactivate.
  - Groups map to Clerk roles, but only through **direct membership** (no nested groups), and the highest mapping wins.
  - Clerk doesn't document reading raw groups through an API. That matters because we map groups to spaces, not just to one org role.
  - Okta needs Push Groups turned on, and the connection must have JIT disabled.
  - Webhooks: `user.created/updated`, `organizationMembership.created/deleted`. Delivered through Svix: at-least-once, **no ordering**, fixed retry schedule (https://docs.svix.com/retries). There is no ordered events feed.
  - Sources: https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync.md, https://clerk.com/docs/guides/development/webhooks/overview

For our spaces-from-groups model, WorkOS is the better fit: it exposes groups and memberships as first-class data and has an ordered feed.

## 4. Fit with our architecture (plain OIDC/OAuth broker, Workers)

- **WorkOS** is a plain REST OAuth-style API that works with `fetch` from Workers.
  - Authorize: `GET https://api.workos.com/sso/authorize?client_id&redirect_uri&response_type=code&state&nonce&organization=org_…` (or `connection=conn_…`), plus `code_challenge`.
  - Token: `POST https://api.workos.com/sso/token` with `client_id`, `client_secret` and `code`, plus `code_verifier` when PKCE was used. It returns a `profile`: `id`, `idp_id`, `connection_id`, `connection_type`, `organization_id`, `email`, names, `groups`, `role`, `custom_attributes`, `raw_attributes`.
  - The token is not an OIDC id_token. The API response itself is trusted over TLS.
  - WorkOS keeps no session for us.
  - Source: https://workos.com/docs/reference/sso/get-authorization-url, https://workos.com/docs/reference/sso/profile
  - **Redirect URIs** must be pre-registered and use HTTPS. One subdomain wildcard is allowed, in the left-most label, single level, never a public suffix, and never the default (https://workos.com/docs/sso/redirect-uris). An older WorkOS page says wildcards are staging-only; the current docs allow them in production. Verify before relying on it.
  - `POST /user_management/redirect_uris` can register custom domains programmatically (https://workos.com/docs/reference/authkit/redirect-uri.md). Check that this covers SSO API redirects.
  - **Best option:** a single broker callback `https://auth.<hosted>/sso/callback`, which needs no wildcards and handles custom domains for free.
- **Clerk** works as an OIDC provider ("OAuth applications").
  - Endpoints on the Clerk Frontend API domain: `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, and discovery at `/.well-known/oauth-authorization-server`. PKCE is required by default. RS256 ID tokens.
  - The user signs in on Clerk's Account Portal, and **Clerk keeps its own session there** (access/ID tokens 1 day, refresh tokens never expire).
  - There is no `connection`/`organization` selector on authorize. `org_id` needs the `user:org:read` scope and is whatever org the user chose on consent, or last active.
  - The ID token has no enterprise connection id. We'd need a Backend API call (`GET /users/{id}`) and to check `enterprise_accounts[]`.
  - Redirect URIs are an array per OAuth app. Wildcard support is undocumented, so assume exact match and one URI per install, or the same broker pattern.
  - Clerk's backend SDK runs on edge runtimes, but we wouldn't need it.
  - Sources: https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on.md, https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth, https://clerk.com/changelog/2026-05-14-oauth-organizations.md

## 5. Tenant isolation

**WorkOS**
- **Binding.** The org id is chosen by our server from the install's config, never from user input.
- **Default domain policy.** WorkOS rejects profiles whose email domain is outside the org's verified domains (`profile_not_allowed_outside_organization`), so one org's IT admin can't mint users with another company's domain.
- **Don't relax that policy.** Relaxing it is environment-wide. Contractors already use our emailed one-time code, so we don't need it.
- Source: https://workos.com/docs/sso/domains
- **Callback checks** (all must pass):
  1. `state` matches the HMAC cookie (existing code).
  2. The PKCE verifier is sent.
  3. `profile.organization_id === install.workos_org_id`.
  4. `profile.connection_id` is in the install's allowed connection list.
  5. The email domain is in the install's verified domains.
  6. The user key is `(connection_id, profile.idp_id)` or `profile.id`, never email alone.
  7. The directory user is active, if DSync is on.
- **IdP-initiated.** WorkOS redirects to our sign-in endpoint with `?connection_id=`. We look that id up, accept it **only if it belongs to the install serving the request**, and start a fresh SP-initiated flow. RelayState only accepts `client_id` and `redirect_uri`, and the redirect must be pre-registered (https://workos.com/docs/sso/login-flows).
- **Key-scope pitfall.** The WorkOS secret key is environment-wide: it can read every customer's directory and redeem any code. If every install held it, one compromised install would break the red line. **Keep it only in the broker.**

**Clerk**
- **Binding** is by email domain: the SAML connection requires an exact email-domain match, with optional subdomains.
- **Org claim.** Org membership comes from the connection being linked to an org, but the token's `org_id` is user-selected, not proof of the connection used.
- **Shared session and pool.** All customers share one Clerk session and one user pool. A user signed in through customer A who lands on customer B's install gets a code for A's identity. Our server must reject it by checking org membership and the enterprise account through the Backend API.
- **Authentication method.** Clerk documents that users with a matching domain must authenticate through the IdP. But proving that *this* session used the connection depends on having no other sign-in methods enabled on the instance.
- **IdP-initiated SAML** is supported (SAML only) and lands in Clerk's session, not ours.
- **Domain collisions.** Clerk's domain verification (DNS TXT) protects against them, but routing by email domain is the binding mechanism itself.
- **EASIE.** Clerk itself flags that multi-tenant EASIE OIDC "increases the risk" of tenant crossover. It doesn't apply here, but it shows the model.
- Source: https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview

## 6. Lock-in and exit

- **WorkOS.** The Connections API returns connection config, but only public certificates; private keys and OIDC client secrets are never returned. WorkOS documents migration *into* WorkOS through a proxy or custom-domain cutover with `external_id`, which needs connection migration enabled by support.
  - I found no documented export *out*.
  - ACS URLs live on WorkOS's domain unless we buy a custom domain ($99/mo, Auth API/Admin Portal/email; ACS coverage unconfirmed). Without one, leaving means every customer reconfigures their IdP.
  - Source: https://workos.com/docs/migrate/other-services, https://workos.com/docs/custom-domains
- **Clerk.** ACS URLs sit on our `clerk.<domain>` CNAME, which is DNS-portable. `/enterprise_connections` is readable through the Backend API. Users are exportable. Leaving also means rebuilding the user/session model Clerk owned.
- **Mitigation for either.**
  - Own the ACS hostname (WorkOS custom domain).
  - Store `idp_id`, connection metadata and group mappings in our D1.
  - Keep the vendor behind the broker interface so a swap to another SAML broker (or our own SAML) touches one Worker.

## 7. Compliance

- **WorkOS.** SOC 2 Type 2. Documents are on its Trust Center. It says it stores only what the IdP sends (profile attributes, directory users and groups). No first-party data-residency statement found, so check the Trust Center or DPA. Source: https://workos.com/security
- **Clerk.** SOC 2 Type II since 2022-05-06. The report is available on Business and above. US-hosted, no regional residency, EU/UK/CH transfers under DPF. It stores full user records, sessions and org memberships. Source: https://clerk.com/security.md

## Integration sketch (WorkOS + broker)

Components:
- **Control-plane `auth-broker` Worker** at `auth.<hosted>`. It holds the WorkOS API key and the webhook secret, and keeps a map: `install_id → {workos_org_id, connection_ids[], directory_id, verified_domains[], origin}`.
- **Installs** reach the broker over a **service binding** (same Cloudflare account), so there's no public token endpoint between them.

Sign-in flow:
1. **User opens `acme.<hosted>/auth/login`.** The install generates `state`, `nonce` and a PKCE verifier, and sets the existing `__Host-oa_oidc_<k>` cookie. It calls `broker.start({install_id, state_hash, code_challenge, next})` over the service binding.
2. **Broker stores the attempt.** It saves `{install_id, state_hash, code_challenge, exp: 10 min}` in a DO or KV keyed by a fresh broker `bstate`. It returns `https://api.workos.com/sso/authorize?client_id=…&response_type=code&redirect_uri=https://auth.<hosted>/sso/callback&organization=<org for install_id>&state=<bstate>&nonce=…` (plus `code_challenge` to WorkOS from a broker-held verifier). The install redirects the user there.
3. **WorkOS sends the user back.** IdP → WorkOS → `auth.<hosted>/sso/callback?code&state=bstate`.
4. **Broker callback.** The broker loads and **deletes** the attempt (single use, unexpired). It POSTs `/sso/token` with `client_secret`, `code` and `code_verifier`. It then checks:
   - `organization_id == install.org`
   - `connection_id ∈ install.connection_ids`
   - the email domain is in `install.verified_domains`
   - for DSync installs, the directory user is `active`

   On any mismatch: 403, an audit event, and no redirect to the install.
5. **Broker mints a one-time install code.** It is a random 32-byte code bound to `{install_id, aud: install origin, sub: workos profile.id, idp_id, connection_id, email, groups, exp: 60 s}`, stored single-use. The broker 302s to `https://acme.<hosted>/auth/callback?code=…&state=<original install state>`.
6. **Install callback.** The install verifies `state` against its cookie (existing code). It calls `broker.redeem({install_id, code, code_verifier})` over the service binding. The broker checks that `install_id` and the PKCE challenge match.
7. **Install creates its session.** It upserts the user keyed by `(connection_id, idp_id)`, applies sign-in group claims, and issues its own `__Host-oa_session`. Unchanged code from there.

IdP-initiated sign-in:
- WorkOS hits `auth.<hosted>/sso/login?connection_id=…`.
- The broker maps the connection to exactly one install and redirects the user to that install's `/auth/login`, which restarts at step 1.
- Unknown connection: reject.

Sync:
- WorkOS webhooks go to `auth.<hosted>/workos/webhook`. The broker verifies the signature, maps `directory_id` / `organization_id` to the install, and enqueues the event to the install (Queue or service binding). It never forwards to an install that doesn't own the directory.
- A cron (about every 5 minutes) polls the Events API by cursor per org as the ordered source of truth. A State API reconciliation runs every 1-6 hours.
- On `state: inactive`, `dsync.user.deleted` or `dsync.group.user_removed`, the install revokes sessions and PATs immediately (not at the 7-day session expiry). On `dsync.deleted`, it revokes the whole directory.

## Risks

1. **The WorkOS key is a cross-tenant root secret.** Keep it only in the broker, restrict it to dashboard/API admins, rotate it, and add the broker to the cross-tenant release suite.
2. **The broker is a single point of failure for Okta/SAML sign-in across all such customers.** Mitigate with the stateless-ish design (DO/KV state only), health checks, and existing sessions surviving outages.
3. **Exit cost without a custom domain.** Buy the WorkOS custom domain early, before the first customer configures an IdP.
4. **Wildcard and redirect API ambiguity.** The broker-callback design avoids both.
5. **Cost at scale.** About $250/customer/month at list for SSO plus SCIM, which is above Clerk until volume. Price SSO+SCIM into Business ($25/creator); a 10-creator customer pays $250. Negotiate at 30+ connections.
6. **Soft-delete semantics vary by IdP.** Test Okta suspend, deactivate, group removal and app unassignment end to end. Treat `inactive` as revoke.
7. **`dsync.deleted` cascades with no per-user events.** The handler must revoke the whole directory.
8. **Choosing Clerk anyway** would mean embedding Clerk's React UI for self-serve, running a shared upstream session across tenants, and doing Backend-API connection checks on every login. That is a larger cross-tenant surface against the red line.
