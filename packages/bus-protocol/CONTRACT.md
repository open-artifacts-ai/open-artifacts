# Bus contract (v1)

Source of truth: `packages/bus-protocol/src/*.ts` (`@oa/bus-protocol`). This
is the summary. Ported from OpenBus `packages/shared` (open-bus main e6feab9,
0.63.0) per the collaboration suite design
(`docs/superpowers/specs/2026-11-03-collaboration-suite-design.md`, "Contracts").

What changed from OpenBus: no `org_id` or owner id (one `BusHub` per member
already isolates); the agent card, `card_request`, `card`, `card_refused`,
JWKS, `/link`, linked apps, roles (`role`, `to_name`, `role_vacant`) and the
dashboard REST and feed are dropped; version gates (`AGENT_CARD_MIN_CLIENT`,
`KIND_TOKEN_MIN_CLIENT`) are gone because no old client exists; the machine
token is `oa_machine_`; the routes live under `/bus/` on the instance origin.
`follow`, `unfollow`, `following` and the `notice` frame come with step 2 of
the design.

Anything both the instance (`apps/server/src/bus/`) and the local client
(`packages/bus-*`) must agree on lives here. Nothing server-only (D1, Workers
types) and nothing client-only.

## Values

| What | Value |
| --- | --- |
| Machine token | `oa_machine_` + 32 base58 (`newMachineToken`, `isMachineToken`). Bus-only. The instance stores a sha256 only. |
| Ids, msg ids | 16 base58 (no `0 O I l`) |
| Device secret (`device_code`) | 43 base58 |
| User code | 8 chars of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown `XXXX-XXXX`; valid 600 s; poll every 5 s |
| Inline body | <= 32768 bytes UTF-8; above it `deliver` carries a notice and the recipient `fetch`es |
| Max body | 1048576 bytes UTF-8 |
| Raw frame cap | `MAX_RAW_FRAME_CHARS` = 2 MB + 4 KB of JSON text |
| Mail TTL | 3600 s |
| Inbox cap | 50 undelivered per agent |
| Roster cap | 1000 (`maxRosterAgents`) |
| Close codes | revoke 4403 (`revokeCloseCode`), protocol violation 1008, rate limit 4429 then 10 s cooldown (HTTP 429 at `/bus/connect`) |
| Other | ack timeout 10 s, ping every 25 s, 1 socket per machine (a reconnect replaces it), 200 live agents per machine |

Keepalive is the bare string `ping` / `pong`, never a frame.

## Instance routes (`BUS_ROUTES`)

| Route | Auth | Body and answer |
| --- | --- | --- |
| `POST /bus/device` | none | `DeviceCodeRequestSchema {machine_label?}` -> `DeviceCodeResponseSchema {device_code, user_code, verification_uri, expires_in: 600, interval: 5}` |
| `POST /bus/device/token` | none | `DeviceTokenRequestSchema {device_code}` -> `DeviceTokenResponseSchema`: `{status: "pending"}`, `{status: "approved", machine_token}`, `{status: "denied"}` or `{status: "expired"}`. Consumed, expired and unknown codes all read `expired`. Polling faster than `interval` is HTTP 429 with `Retry-After`. |
| `GET/POST /bus/approve` | Open Artifacts session and `canConnect` | The approval page. The person types the code their terminal shows (RFC 8628 section 5.4); `ApprovalBodySchema {decision, label?}` |
| `GET /bus` | Open Artifacts session | The member's bus page: Machines (revoke) and share notices. The client prints `<instance>/bus` after sign-in. |
| `GET /bus/connect` | `Authorization: Bearer oa_machine_...` | WebSocket upgrade. A revoked token, an unknown one, a PAT or OAuth token, or a member who fails `canConnect`: 401. |

`verification_uri` is exactly `<instance origin>/bus/approve`: https (http only
on loopback), no userinfo, equal to its parsed `href`, no query or fragment, and
never the user code, in any form (RFC 8628 section 5.4: a link that carried the
code would be one click from approving an attacker's machine). There is no
`verification_uri_complete`. The client shows the code apart, for the person to
type, and checks `verificationUriMatches(uri, instanceUrl)` before printing or
opening the URI.

## Receipts and refusals

States: `pending | delivered | expired | refused`. Refusal reasons
(`REFUSAL_REASONS`): `unknown_agent`, `closed`, `inbox_full`, `too_large`,
`other_namespace`, `revoked`, `ambiguous`. `expired` may carry
`recipient_closed`. The `receipt` reply to `send` is only `pending` or
`refused`; `receipt_update` may carry any state.

## Wire (local client <-> BusHub)

One JSON object per WebSocket text message: a strict object
`{v: 1, id, type, ...}`, `id` matching `[A-Za-z0-9_-]{1,64}`; replies echo the
request id. `agent_ref`, `from_ref`, `to_ref` match `[A-Za-z0-9_.:-]{1,128}`,
never `__proto__`, `constructor` or `prototype`.

Client to hub (`CLIENT_FRAMES`):

- `hello {machine_label, client_version}`
- `agent_up {agent_ref, kind, proposed_name, namespace, global}`
- `agent_down {agent_ref}`
- `sessions {open[], closed[]}`
- `send {from_ref, to_name, to_namespace?, body}`
- `ack {msg_id}`
- `refuse {msg_id, reason: "closed", detail}`
- `list {from_ref}`
- `fetch {from_ref, msg_id}`
- `status {from_ref, state, label?}`: fire and forget.

Hub to client (`SERVER_FRAMES`):

- `hello_ok {machine_id, machine_label, server_version}`
- `agent_ok {agent_ref, bus_name}`
- `receipt {msg_id, state, reason?}`
- `roster {agents: [{bus_name, kind, namespace, global, state, machine_label?, status?, status_label?, status_at?}]}`; `kind` is any kind token.
- `body {msg_id, body}`
- `error {code, message}`; `code` is `bad_frame | not_registered | not_found | too_large | rate_limited | internal`. Cap refusals of `agent_up` use the exact `AGENT_CAP_MESSAGES` strings.
- `deliver {msg_id, to_ref, from_name, namespace, body | notice}`
- `receipt_update {msg_id, state, reason?}`
- `roster_changed {namespace}`

Targeting, idempotency (a send's `id` is unique per sender for at least 1 h;
a resend reuses it) and the decoder bounds are unchanged from OpenBus:
`decodeClientFrame` (hub) and `decodeServerFrame` (client) never throw; the
raw cap, a linear pre-scan (depth <= 4, bounded tokens), the body byte cap and
well-formed Unicode on free text are checked in that order.

## Names and namespaces

Bus names: 1..64 chars of letters, digits, space, `.`, `_`, `-`, no IPv4
shapes. Reserved (`RESERVED_BUS_NAMES`): `open-artifacts` (the instance's
notice sender), `openbus`, `open-bus`, with case, separators and `-N`
suffixes folded. Namespaces are canonical `[a-z0-9._~/-]{1,128}`, derived by
`namespaceFrom`.

`.oa-bus.json` (`CONFIG_FILE`): strict `{namespace?, global?}`, nearest file
wins per key. `global` grants nothing; global comes only from the user's
allowlist under the client's home folder.
