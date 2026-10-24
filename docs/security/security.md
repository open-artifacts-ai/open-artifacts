# Security model notes

## Links and navigation from artifacts

The content host sends `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`, and the viewer iframe sets the same `sandbox` tokens. `allow-same-origin` and every `allow-top-navigation*` token are never set.

- **New tabs: allowed.** An artifact may open links in a new tab (`target="_blank"`, ideally with `rel="noopener"`). With `allow-popups-to-escape-sandbox` that tab is a normal, unsandboxed page on the link's own origin. A popup to an external site carries none of our credentials (the artifact runs in an opaque origin and the content host never sets cookies). A popup to the app host is a top-level GET, so it sends the Lax session cookie like any link and lands on our own pages, which `Cross-Origin-Opener-Policy: same-origin` isolates from the opener.
- **The viewer page: never.** Without `allow-top-navigation*`, an artifact cannot navigate the viewer (top) page.
- **Top-level loads of content URLs:** a content URL opened directly as a top-level page redirects to the viewer (#294), so an artifact never renders outside its sandboxed frame.
- **`window.opener` renavigation:** a page opened from an artifact could try to drive its opener. The per-load bridge nonce (#306) means a renavigated or foreign frame cannot speak to the viewer's bridge.

## Live sockets and access revocation

Open live sockets (data subscribe and the `R.events` version feed) are authorized when they connect. The policy gate stamps `authzAt` before it reads the session, and the route passes it to the artifact's DO. A revocation closes open sockets, and a guard on accept refuses any socket whose access check ran at or before the revocation (plus a 2 second clock-skew margin), so a socket can't slip in between the access change and the close. Closed sockets get 4403 (`gone` first on `R.events`); clients reconnect through the shell, which checks access again.

Two guards, by the scope of the change:

- **One person, every artifact (`UserPresence`, one DO per user).** Every signed-in socket accept awaits `touch(artifactId, authzAt)`, which records the artifact; if `touch` fails, the socket is closed. `revokeUserLive` calls `closeAll`, which writes `revokedAt` first, then closes that person's sockets (tag `a:u:{id}`) on each artifact they touched in the last 10 minutes.
  - Closes **within about a second**: removing or suspending a member (team artifacts included), changing a member's role, deactivating a guest when their last share is removed, and resetting a member's Google link.
  - A failed close is queued in the DO and retried by alarm with backoff (1 s up to 60 s) until it is 11 minutes old.
  - If `closeAll` itself fails after 3 retries, `presence_revoke_failed` is logged at alert level, and `revokedAt` alone is written when the DO is reachable. New accepts are then refused, but open sockets wait for the TTL.
- **One artifact, every actor (`closeRuntimeSockets`).** The artifact's DO records the change time, then closes every socket on it, anonymous ones included. Accepts authorized before the change are refused.
  - Closes **at once**: delete, visibility and capability changes (in a patch or a publish), removing a share, and changing a share from editor to viewer.
  - A share removal doesn't revoke the person's presence: that would close their sockets on unrelated artifacts, and the artifact guard already covers this one.

Still bounded only by the socket TTL (`LIMITS.signedUrlTtlSec`, 10 minutes, then 4408 and a re-checked reconnect):

- An install without the `USER_PRESENCE` binding (logged as `presence_unbound`).
- A `closeAll` that keeps failing (above).
- Clock skew over 2 seconds between the Worker and a DO, for a socket that races a revocation.
- A rolling deploy. For a short time a new Worker can reach a DO still running the old code, which neither calls `touch` nor checks the access-change time. A socket accepted there is not recorded, so a revocation in that window misses it. (An old Worker reaching a new DO sends no `authzAt`: signed-in sockets are refused with 400, and anonymous ones skip the guard.)
- Changes that don't call `revokeUserLive` yet: space role and group mapping narrowing, directory sync, transfers and a customer mismatch land with later P3 tasks. A test (`test/node/revocation-lint.test.ts`) fails any access-shrinking function or class method (nested functions count toward the one that contains them; comments are ignored) that is not listed with its guard.

`R.events` sockets have their own per-DO budgets, apart from data sockets: 200 for signed-in viewers, 100 for anonymous viewers, and 3 per anonymous actor (an IPv4 address or an IPv6 /56). Anonymous sockets can't starve live data or members.

Data-subscribe sockets split the same way: 200 per DO for signed-in viewers (20 per user), 100 for anonymous viewers (8 per anonymous actor, an IPv4 address or an IPv6 /56, also the `sub:ip:` RL_ANON key). Anonymous floods from many addresses fill only the anonymous pool, so members keep live data. A data socket with no actor is refused (400).

## Direct sign-in (hosted M1, P2)

Direct sign-in replaces Cloudflare Access with Google (one multi-tenant client) and emailed codes. The red line is that no one signs in to another customer's install.

| Threat | Mitigation | Residual |
|---|---|---|
| Broker compromise (hosted) | The broker returns Google's raw ID token. Each install verifies the signature, `aud`, its own nonce and `hd` itself. The registry holds Ed25519 public keys only. | The broker holds the client secret and the callback, so it can obtain tokens only for victims who click a crafted link, for a flow whose state cookie the attacker controls. |
| Token for another tenant | `hd` must be exactly one of the install's `AUTH_DOMAINS`. The email domain is never consulted. | None known. |
| Provider mix-up | The state cookie names its provider; a callback for another provider is refused before any token call. | None known. |
| Recycled or spoofed identity | Users are keyed by `identities (google, sub)`. Email links an unlinked active row at most once; another `sub` gets `identity_conflict`; removed and suspended rows are never linked. | An admin resets the link. |
| Code guessing | 8 digits, 5 atomic tries per request, a per-IP failure cap (30 an hour), per-address request caps, a 10 minute TTL. | At most 150 guesses per address per hour, each emailing the victim. |
| Victim lockout | Rows are per request and failures per request and per IP, so another person's requests can't cancel a pending code. | A distributed attacker can reach the per-address request ceiling (alerted). |
| Address enumeration | The same 202 for every address. Delivery runs after the response. Verify runs the same statements with or without a code, and its wording comes from the browser's own cookie. | None known. |
| Email quota exhaustion | The code pool is separate from invites and is spent only on real sends. There is a per-IP daily cap and Turnstile. | Requests for guests count against the per-IP quota. |
| Login CSRF | `__Host-` Lax cookies, `X-OA-Request`, and `Sec-Fetch-Site: same-origin` or an exact `Origin`. | None known. |
| Guests writing | A capped caller (a guest under direct sign-in, or any code session outside the domains) is read-only on the whole API, refused before any route. | None known. |
| Test hooks in production | Hooks require a build flag release builds never set, plus `TEST_HOOKS=1` and a 32+ character key. Otherwise every path is a 404. | Operator error on a staging install. |
| Stale sessions | Sessions carry the user's epoch (a role change or link reset ends them) and their tenant. | Suspension in the Workspace takes effect with P3's directory sync. |

### Broker transport hardening

Every hosted install shares one Google client and one redirect URI, so the broker binds each flow to the install that started it:

- **Nonce binding.** Google's `nonce` is `base64url(SHA-256("oa-broker-v1|" + installId + "|" + clientNonce))`, not the install's client nonce. The install keeps its client nonce in its state cookie and recomputes the derived value with its own `INSTALL_ID` before accepting Google's ID token. A token minted through install A can therefore never redeem at install B, even if the attacker chose B's client nonce when starting A's flow.
- **Broker state.** `bstate` is HMAC-signed over `{ install, client state, H(client nonce || code_challenge), exp }` and expires in 10 minutes. It names the only origin the callback may redirect to. The callback relays it to the install as `bstate`; the install sends it back at redeem with its own `H(client nonce || code_challenge)`, and the broker refuses the redeem unless the state is valid, names the same install, and the hashes match (constant time).
- **Fixed redirect URI.** `redirect_uri` comes from the broker's `BROKER_ORIGIN` var, never from the request `Host` header.
- **Redeem signing.** The install signs `oa-redeem-v1\nPOST\n/google/redeem\n<kid>\n<body>` with its Ed25519 key; the broker checks the key id (derived from the public key), the signature, and `|now - ts| ≤ 60 s` before the exchange. Google codes are single-use, so a captured redeem is not replayable after exchange; an optional `jti` cache is not implemented.
- **Rate limits.** The broker's `RL_BROKER_IP` and `RL_BROKER_INSTALL` bindings are charged on `/google/authorize` and `/google/redeem`. The IP bucket is charged first; the install bucket only after the install is found (authorize) or the redeem's signature verifies. Redeem is signed, so only the install can charge its own bucket there. Authorize is unauthenticated, so junk authorizes naming a real install can still drain that install's bucket and block its sign-in for the window; only the per-IP bucket bounds that. If either binding is missing the broker fails closed (503), and a denial is 429.
- **Revocation lag (60 s).** Registry entries are cached in the broker for 60 seconds. Disabling an install, removing a key, or rotating a key takes effect within 60 seconds, not instantly; treat a compromised install's broker access as live for that window and rotate the Google client secret if the broker itself is suspect.
- **Follow-up.** Alert on an abnormal redeem volume (per install and globally); the broker does not yet emit a per-install redeem counter.


The cross-tenant catalog (`apps/server/test/xt/signin-negative.ts`) runs locally in CI and live against two staging installs before every release (`pnpm --filter @oa/server xt:live`, which sets `XT_LIVE=1`). The live run refuses origins outside the staging allowlist (https, exactly one label under `open-artifacts-staging.app` or `open-artifacts-staging.page`) and requires `/healthz` `testHooks: true` and distinct `installId`s on both installs before it reads any credential file. Both installs run with `TEST_DOMAIN=xt-guest.example`, the only domain the catalog uses. Credential files must be regular files, owned by the runner, mode 0600 or stricter, and not symlinks. Broker and tenant cases: #423.
