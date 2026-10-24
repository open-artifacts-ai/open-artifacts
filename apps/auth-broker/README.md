# Auth broker (hosted Google transport)

Stateless Worker that performs the Google code exchange for hosted installs.
Every install shares one Google client and one redirect URI; the broker holds
the client secret and nothing that can sign for an install. Invariants, from
the P2 security review:

## Routes

- `GET /google/authorize?install&state&nonce&code_challenge`
  Looks up the install in `BROKER_REGISTRY` (KV), charges the per-IP and
  per-install rate limits, then redirects to Google. `redirect_uri` is built
  from `BROKER_ORIGIN`, never from the request `Host`. The PKCE challenge must
  match `^[A-Za-z0-9_-]{43}$`. `state` is the signed broker state; Google's
  `nonce` is derived, not forwarded:
  `base64url(SHA-256("oa-broker-v1|" + installId + "|" + clientNonce))`.
  The signed state also binds `H(client nonce || code challenge)` and names the
  install; it expires in 10 minutes.
- `GET /google/callback?code&state`
  Verifies the broker state and redirects to the install's registered origin
  only, with the install's own state.
- `POST /google/redeem` (headers `X-OA-Kid`, `X-OA-Sig`)
  Verifies the install exists and is enabled, the key id belongs to it and
  derives from the stored public key, the Ed25519 signature over
  `oa-redeem-v1\nPOST\n/google/redeem\n<kid>\n<body>`, and `|now - ts| ≤ 60 s`.
  Then exchanges the code and returns Google's raw `id_token` unmodified. The
  install verifies the token itself (signature, `aud`, its derived nonce, `hd`).

Failures are generic (`unauthorized`, `exchange_failed`, `rate_limited`,
`unavailable`, `server_error`). Logs contain route and outcome only: never a
code, verifier, token, email, nonce, state or key.

## Bindings and vars

| Name | Type | Notes |
| --- | --- | --- |
| `BROKER_REGISTRY` | KV | Written by P1 provisioning; public keys only |
| `RL_BROKER_IP` | RateLimit | Per client IP on authorize and redeem |
| `RL_BROKER_INSTALL` | RateLimit | Per install on authorize and redeem |
| `GOOGLE_CLIENT_ID` | var | The multi-tenant client |
| `BROKER_ORIGIN` | var | Fixed public origin, e.g. `https://auth.<hosted>` |
| `GOOGLE_CLIENT_SECRET` | secret | Never leaves the broker |
| `BROKER_STATE_KEY` | secret | HMAC key for the broker state (32+ chars) |

Config is per env (`wrangler.jsonc` has `env.staging` and `env.prod`, no
top-level name): deploy with `--env`, see `docs/ops/hosted.md`. Workers Logs
stays off, because it records the full URL, and the callback URL carries the
OAuth code and state.

If either rate-limit binding is missing the broker fails closed with 503. A
bucket denial is 429.

## Revocation and rotation

`BROKER_REGISTRY` lookups are cached per isolate for **60 seconds**. Disabling
an install, removing a key, or swapping a key during rotation takes effect
within that window, not instantly. Treat a compromised install's broker access
as live for up to 60 seconds; if the broker itself is suspect, rotate
`GOOGLE_CLIENT_SECRET`.

Rotation: add the new public key (at most two), swap the install's
`BROKER_SIGNING_KEY`, then remove the old key. Key ids are derived
(`keyId(x)` = first 16 chars of `base64url(SHA-256(x))`), never configured, so
they cannot drift.

## Follow-up

Alert on abnormal redeem volume, per install and globally. The broker does not
yet emit a per-install redeem counter; Google authorization codes are single
use, so a captured redeem cannot be replayed after a successful exchange. An
optional `jti` cache is not implemented.
