# SS4: the hosted sign-up service (self-serve step 4)

Status: design for review (Manager), 2026-10-29. Post-M1: branches only, nothing
merges until the freeze lifts and M1 ships. Stacked on SS3 (#859), whose
`signups`, `signup_secret` and `oa-<p>-signups` it writes to.

## Intent

Anyone with a Google account can get a free hosted install by themselves: sign
in with Google, pick a name, pass Turnstile, wait a minute, and land in their
own dashboard already signed in. One free install per Google account.

## Goals

- `oa-<p>-signup` (public, `signup.<app domain>`): Google sign-in, the name
  check, Turnstile, the one-per-account claim, the pending rows, the enqueue,
  and the "setting up" status page.
- It holds no Cloudflare token: it writes platform D1 and sends to one queue,
  through bindings only.
- The person lands in their new dashboard signed in, usually without a click,
  through the install's normal Google sign-in (no new trust path).

## Non-goals

- The screens' visual design (Frontend, after Design's Oct 30 options). SS4
  ships plain, functional pages the screens replace.
- Paid plans at sign-up (everyone starts free; upgrade is #857's checkout).
- Deleting or transferring installs; changing the slug later.

## Anti-goals

- Two free installs for one Google account, through any race or retry.
- A name that looks like another install's, or a platform name.
- An account whose email Google hasn't verified.
- The owner's email in a log, a URL, a queue message, or any row other than
  `signup_secret` (and, after create, `installs.owner_email`).
- Any way to read or steer another person's signup.

## What exists

- The auth broker (`apps/auth-broker`) serves any entry in its registry
  (`installId`, `origin`, Ed25519 `keys`, `domains`). The caller signs its
  redeem; the broker returns Google's raw ID token and never vouches. The
  caller verifies the token itself.
- Turnstile: one widget per env (`oa-<p>-turnstile`), keys in the hosted-ops
  secrets (`TURNSTILE_KEYS`).
- Slug rules: `SLUG_RE`, `RESERVED_SLUGS`, and no `--` at positions 3-4
  (packages/provision/src/names.ts). No lookalike check today.
- SS3: `signups` (`pending` ... `ready`/`failed`), `signup_secret`, the
  consumer, the `SIGNUPS_ENABLED` switch, the cap, the scheduler sweep of stale
  `pending` rows.

## Approaches

- **A. Reuse the broker as one more registry entry (chosen).** The sign-up
  Worker gets a registry entry (origin `https://signup.<app domain>`, its own
  keypair) and runs the same authorize, callback, redeem and verify flow an
  install runs. No new Google client, no broker trust change.
- **B. A separate Google OAuth client for sign-up.** Simpler code, but a new
  client per env in Google Cloud (user setup), a second secret, and a second
  consent screen. Dropped.
- **Handoff (Manager, user's ask):** no login grant. When the install is ready
  the status page sends the browser to the install's own Google sign-in with
  `login_hint=<email>`; Google has a session and the broker client already has
  consent, so it passes through and they land signed in. If Google prompts,
  it's one click on their own account.

## Design

### The flow

1. `GET /` (sign-up page). `POST /auth/start`: a broker authorize URL with
   this Worker's nonce, PKCE challenge and a signed state, exactly as an
   install builds it; no `hd` (consumer accounts allowed).
2. Broker callback lands on `https://signup.<app domain>/auth/callback/google`
   (the broker's existing callback path).
   The Worker redeems through the broker (Ed25519-signed, within 60 s) and
   verifies the ID token itself: signature (Google JWKS), `iss`, `aud` (the
   env's broker client), `exp`, its nonce, and **`email_verified === true`**
   (refused otherwise). The session is a signed, HttpOnly, Secure,
   SameSite=Lax cookie (`__Host-oa-signup`, 30 min) holding `sub` and the email,
   signed with a Worker secret.
3. `POST /names/check {slug}` (session required, rate-limited per session and
   IP): `ok`, or `invalid`, `reserved`, `taken` or `lookalike` (never which
   install it resembles).
4. `POST /submit {slug, turnstile}` (session required): Turnstile siteverify
   (secret, the client IP, hostname must be `signup.<app domain>`, action
   `signup`), the name check again, then **one D1 batch**:
   - claim the account: `INSERT INTO signup_accounts (owner_sub, signup_id,
     created_at) VALUES (?, ?, ?) ON CONFLICT (owner_sub) DO UPDATE SET
     signup_id = excluded.signup_id WHERE (SELECT status FROM signups WHERE
     signup_id = signup_accounts.signup_id) = 'failed'` (a failed signup frees
     the claim; anything else keeps it), then only if that row now names this
     signupId:
   - `INSERT INTO signups (... status 'pending', slug, skeleton, owner_sub)`;
   - `INSERT INTO signup_secret (signup_id, owner_email)`.
   The claim and inserts are one batch: the signup and secret inserts are
   `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM signup_accounts WHERE
   owner_sub = ? AND signup_id = ?)`, so they land only if this submit holds
   the claim. Outcomes: the claim is held by a live signup -> 409
   `already_signed_up` (the page shows that signup's status); a unique-index
   failure on `slug` -> 409 `taken`, on `skeleton` -> 409 `lookalike` (told
   apart by re-running the name check after the failure); otherwise 200.
   Then `SIGNUPS.send({ signupId })`. A send failure is fine: the rows exist
   and SS3's sweep re-sends a stale `pending` row after 15 minutes. Reply
   `{ signupId }`.
   With `SIGNUPS_ENABLED` not `"true"`, `/submit` answers 503 `closed` before
   any write, and the page says sign-ups are paused.
5. `GET /status` (session required; the session's own signup only, looked up
   by `sub`, never by an id in the URL): `pending`/`queued`/`waiting_cap`/
   `creating` (with a plain-language note; `waiting_cap` says "tomorrow"),
   `failed` (with "try again", which frees the claim per step 4), or `ready`
   with the install's app host.
6. Handoff: on `ready`, the page sends the browser to
   `https://<appHost>/auth/google/start?login_hint=<email>`. The email sits in
   the browser's address bar for that one hop only, never in a log of ours (the
   install logs no query strings). See "Small changes elsewhere".

### One free install per Google account

`signup_accounts(owner_sub TEXT NOT NULL PRIMARY KEY, signup_id TEXT NOT NULL,
created_at INTEGER NOT NULL)` in platform D1 (migration `0008`, additive). The
claim is keyed by `sub`, never by email (an email can change hands). **One live
free install per Google account at a time** (Manager, 2026-10-29). The claim
frees when its signup is `failed`, or when its install is `deleted` and that
was at least 7 days ago (`installs.state = 'deleted' AND installs.updated_at
<= now - 7 days`): the cooldown stops churn without punishing an honest
restart. The claim's conditional upsert tests exactly these. An operator can
release one early with a CLI command (`signup-release --sub`).

### The name check

One shared function in `packages/provision/src/names.ts`,
`checkSlug(slug, existing: Iterable<string>)` returning `ok | invalid |
reserved | lookalike`, used by sign-up (and available to the CLI):

- `invalid`: not `SLUG_RE`, or `--` at positions 3-4.
- `reserved`: in `RESERVED_SLUGS`, or its skeleton equals a reserved name's.
- `lookalike`: its skeleton equals the skeleton of an existing install slug, a
  live signup's slug, or a platform name.
- **Skeleton:** lowercase; Unicode NFKC, then Unicode confusables folded to
  ASCII (a small table: Cyrillic and Greek lookalikes of a-z, fullwidth forms);
  then `0`->`o`, `1`->`l`, `i`->`l`, `5`->`s`, `rn`->`m`, `nn`->`m`,
  `cl`->`d`, `vv`->`w`, and `-` removed. `SLUG_RE` is ASCII-only, which
  already rules out mixed-script homographs; this table is enough (Manager).
  Slugs are ASCII-only by `SLUG_RE`, so Unicode can't reach an install name;
  folding it first only lets the page say "lookalike" rather than "invalid"
  for a pasted homograph.
- "Taken" vs "lookalike": an exact match is `taken`.
- Source of truth: `installs.slug` (platform D1, every non-deleted install)
  plus live `signups.slug`, plus `RESERVED_SLUGS` and the platform names.
- Race: two concurrent submits. `signups` gains a `skeleton` column (in 0008)
  with unique indexes over live rows (`WHERE status != 'failed'`) on both
  `slug` and `skeleton`, so the second insert fails and is answered `taken`
  or `lookalike`. The unique indexes cover in-flight signups (`pending`,
  `queued`, `waiting_cap`, `creating`); a `ready` signup's name is held by its
  `installs` row instead, which keeps the slug (deleted included) until the
  explicit purge after the existing wait (#526). The check therefore reads
  every `installs` row, whatever its state. Installs made by the CLI are checked at submit time (rare,
  operator-made).

### Abuse

- Turnstile on submit; rate limits on every route (per IP and per session,
  Workers rate-limiting binding); the SS3 daily cap and its alert.
- The session cookie is the only identity; `/status` and `/submit` never take
  an id from the client.

### Small changes elsewhere

- **Broker (Platform):** `GET /google/authorize` accepts an optional
  `login_hint` from any registered caller (a syntactically valid email, at
  most 254 chars) and passes it to Google; when it is present and `reauth` is
  not, the broker sends no `prompt` (today it always sends `select_account`,
  which forces a click). `reauth=1` keeps `max_age=0` and the prompt.
  The install still verifies the token's email, so a wrong hint signs no one
  in as someone else.
- **Server (Backend):** `/auth/google/start` forwards a `login_hint` query
  parameter to the broker's authorize, and never logs it.
- **Server (Backend, the Gmail owner path; Manager, 2026-10-29):** today an
  install's Google sign-in admits only Workspace domains (`AUTH_DOMAINS`
  required, `hd` checked), so a personal Gmail owner could never sign in to
  their own install. The user wants personal Gmail, so the server gains a
  per-person path, never a domain one:
  1. a token with no `hd` is admitted only when `email_verified` is true, the
     email exactly matches an invited or member user, and the email's domain
     is not one of the install's `AUTH_DOMAINS` (a Workspace domain always
     arrives with a matching `hd`);
  2. the `sub` is pinned on first sign-in; a different `sub` for the same
     email is refused and flagged to admins;
  3. no wildcard and no join-by-domain on this path.
  A sign-up install therefore needs no `AUTH_DOMAINS`; its config check
  accepts an empty list when this path is on. Red-line: hd-less on an
  `AUTH_DOMAINS` email, hd-less unverified, a `sub` mismatch, an uninvited
  Gmail address, and another install's invited Gmail address are all refused.
  SS4's handoff depends on this landing first.
- **Provisioner (SS3):** nothing; it already reads the pending rows SS4 writes.

### Deploy

A `signup` target in #847 after `provisioner`: the Worker, its route
`signup.<app domain>/*`, its registry entry (keypair generated in CI, public
key written to the broker registry, check-first like the install keys), its
session secret, a reserved registry id (`SIGNUP_REGISTRY_ID`, a fixed id in
the install-id shape that `newInstallId` refuses to return), and the
Turnstile keys from the env's hosted-ops secrets.
`SIGNUPS_ENABLED` gates it the same way as SS3.

## Tests

- The flow end to end against a fake broker and fake Google JWKS.
- ID token: wrong `aud`, wrong `iss`, expired, wrong nonce, and
  **`email_verified` false or missing**: all refused, no row written.
- One per account: the same `sub` twice (and concurrently) gives one claim;
  after `failed`, a retry claims again; after `ready`, a retry is refused.
- Names: every `checkSlug` class; the confusable table, `cl`/`d` and
  `nn`/`m` included; the check runs against every reserved name too (a
  lookalike of `admin`, `auth` or `login` is `reserved`); the concurrent
  lookalike race.
- Claims: a deleted install frees its claim only after 7 days (6 days 23 h
  refused, 7 days allowed); a failed signup frees it at once.
- Turnstile: missing, invalid, wrong hostname, wrong action: refused, no write.
- `/status` never shows another person's signup.
- No email in any log line, URL we build (except the one handoff hop), queue
  message or non-secret row.
- Config: no Cloudflare token or token binding on `oa-<p>-signup`.

### Red-line cases (live, staging; added only when they can pass)

- An ID token with `email_verified` false is refused at callback.
- A second signup for the same Google account is refused.
- A lookalike of an existing install's name is refused.
- A signup's status can't be read with another account's session.

## Left to the builder

- Page markup (plain, accessible, replaced by Frontend's screens), module
  layout, the exact rate-limit numbers within the binding's limits.

## Decided (Manager, 2026-10-29)

- Personal Gmail is in: the server's per-person path above (Backend).
- Handoff by `login_hint`, no login grant.
- Calls: broker callback path; `login_hint` rules; reserved registry id;
  exact `slug` index next to `skeleton`; 409 `already_signed_up`.

Design approved (Manager, 2026-10-29). The build waits for Backend's Gmail
owner path (A) to land first.
