# Directory broker (hosted directory sync transport)

Stateless Worker that runs Google directory-sync consent and token exchange
for hosted installs (P3 Task 12). It is separate from the sign-in broker
(`apps/auth-broker`) so that a compromise of either never yields both Google
client secrets. It lives on its own host, `directory.<app domain>`, never a
path on `auth.*`.

It holds the Directory client secret and nothing that can sign for an
install. Its registry, `DIRECTORY_REGISTRY`, is its own KV, written by
Platform and read here with `get` only (never `put` or `delete`; a test pins
it). It never binds `BROKER_REGISTRY`, so it can't plant sign-in trust
anchors.

## Routes

- `GET /google/directory/start?install&state&code_challenge`
  Looks up the install, charges the per-IP and per-install rate limits, then
  redirects to Google with `GOOGLE_DIRECTORY_CLIENT_ID`, the scopes `openid
  email` plus `admin.directory.user.readonly`, `admin.directory.group.readonly`,
  `admin.directory.domain.readonly` and `admin.reports.audit.readonly`,
  `access_type=offline`, `prompt=consent` and `hd` from the registry. The
  redirect URI is exactly `${DIRECTORY_ORIGIN}/google/directory/callback`,
  never built from the request `Host`. The signed state names the install,
  binds the PKCE challenge, expires in 10 minutes and is MACed under the
  `oa-dir-v1` domain.
- `GET /google/directory/callback?code&state`
  Verifies the state and redirects to the install's registered origin only,
  at `/api/v1/directory/callback?code&state&bstate`.
- `POST /google/directory/token` (headers `X-OA-Kid`, `X-OA-Sig`)
  The install assertion: the key id belongs to the install and derives from
  its public key, and the Ed25519 signature covers
  `oa-redeem-v1\nPOST\n/google/directory/token\n<kid>\n<body>` (path-bound,
  so a sign-in redeem signature never verifies here), with `|now - ts| ≤ 60 s`.
  Every body carries `epk`, a fresh X25519 public key.
  - `{ install, ts, epk, grant: "code", code, verifier, bstate }`: the state
    must be this install's and unexpired, with `S256(verifier)` equal to its
    challenge. Returns `{ scope, box }`, the box holding Google's
    `refresh_token`, `access_token` and `id_token`.
  - `{ install, ts, epk, grant: "refresh", refresh_token }`: returns `{ box }`
    holding `access_token` and `expires_in`, or 400 `invalid_grant` when Google
    revoked the grant.

  The box is sealed to `epk` only (`@oa/auth-core` `box.ts`: X25519, HKDF,
  AES-256-GCM, AD bound to the install id and key id). Tokens never leave
  the broker raw. The install opens the box in the same request and seals the
  refresh token at rest with its own `DIRECTORY_TOKEN_KEY`.

Failures are generic (`unauthorized`, `exchange_failed`, `invalid_grant`,
`rate_limited`, `unavailable`, `server_error`). Logs contain route and outcome
only: never a code, verifier, token, email, state or key. Observability is
off, since the callback URL carries the code and state.

## Bindings and vars

| Name | Type | Notes |
| --- | --- | --- |
| `DIRECTORY_REGISTRY` | KV | Its own namespace (`oa-s-directory-registry`, `oa-p-directory-registry`); read only |
| `RL_DIRECTORY_IP` | RateLimit | Per client IP (staging 1121, prod 1131) |
| `RL_DIRECTORY_INSTALL` | RateLimit | Per install (staging 1122, prod 1132) |
| `GOOGLE_DIRECTORY_CLIENT_ID` | var | The Directory client; a `{{...}}` placeholder or empty turns every route off (404) |
| `DIRECTORY_ORIGIN` | var | Fixed public origin, `https://directory.<app domain>` |
| `GOOGLE_DIRECTORY_CLIENT_SECRET` | secret | Never leaves the broker |
| `DIRECTORY_STATE_KEY` | secret | HMAC key for the directory state (32+ chars) |

Registry entries have the sign-in registry's shape
(`{ installId, origin, keys: [{ kid, x }], domains }`) and are cached per
isolate for 60 seconds, as in the sign-in broker.

## Shared code

`packages/broker-core` holds what both brokers share: the registry lookup,
responses and outcome logging, the signed state, the fail-closed rate
limits and the install assertion check.
