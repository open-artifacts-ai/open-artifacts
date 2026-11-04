# Bus contract (v1)

Source of truth: `packages/bus-protocol/src/*.ts` (`@oa/bus-protocol`). This
is the summary. Ported from OpenBus `packages/shared` (open-bus main e6feab9,
0.63.0) per the collaboration suite design
(`docs/superpowers/specs/2026-11-03-collaboration-suite-design.md`, "Contracts").

What changed from OpenBus: no `org_id` or owner id (one `BusHub` per member
already isolates); the agent card, `card_request`, `card`, `card_refused`,
JWKS, `/link`, linked apps, card roles (`role`) and the
dashboard REST and feed are dropped (receipt `to_name` came back with
renames and role addresses; `role_vacant` came back with role addresses, see
Role addresses); version gates (`AGENT_CARD_MIN_CLIENT`,
`KIND_TOKEN_MIN_CLIENT`) are gone because no old client exists; the machine
token is `oa_machine_`; the routes live under `/bus/` on the instance origin.
`follow`, `unfollow`, `following` and the `notice` frame come with step 2 of
the design. Renames (OpenBus R393a, #1325) are gated on a `hello` capability,
not a version (see Renames).

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
`other_namespace`, `revoked`, `ambiguous`, `role_vacant` (only to a
`roles`-cap socket, see Role addresses). `expired` may carry
`recipient_closed`. The `receipt` reply to `send` is only `pending` or
`refused`; `receipt_update` may carry any state.

## Wire (local client <-> BusHub)

One JSON object per WebSocket text message: a strict object
`{v: 1, id, type, ...}`, `id` matching `[A-Za-z0-9_-]{1,64}`; replies echo the
request id. `agent_ref`, `from_ref`, `to_ref` match `[A-Za-z0-9_.:-]{1,128}`,
never `__proto__`, `constructor` or `prototype`.

Client to hub (`CLIENT_FRAMES`):

- `hello {machine_label, client_version, caps?}`; `caps` (see Renames)
- `agent_up {agent_ref, kind, proposed_name, namespace, global, name_kind?}`
- `agent_down {agent_ref}`
- `sessions {open[], closed[]}`
- `send {from_ref, to_name, to_namespace?, body}`
- `ack {msg_id}`
- `refuse {msg_id, reason: "closed", detail}`
- `list {from_ref}`
- `fetch {from_ref, msg_id}`
- `status {from_ref, state, label?}`: fire and forget.
- `rename {agent_ref, proposed_name, name_kind?}`: rename a live agent; `proposed_name` 1..256 chars. Answered by `renamed` or `error`.

Hub to client (`SERVER_FRAMES`):

- `hello_ok {machine_id, machine_label, server_version}`
- `agent_ok {agent_ref, bus_name}`
- `receipt {msg_id, state, reason?, to_name?}`; `to_name` is the recipient's current name, only on a former-name hit to a `rename`-cap socket, or on a role hit to a `roles`-cap socket
- `roster {agents: [{bus_name, kind, namespace, global, state, machine_label?, status?, status_label?, status_at?, former_names?}]}`; `kind` is any kind token.
- `body {msg_id, body}`
- `error {code, message}`; `code` is `bad_frame | not_registered | not_found | too_large | rate_limited | internal`. Cap refusals of `agent_up` use the exact `AGENT_CAP_MESSAGES` strings.
- `deliver {msg_id, to_ref, from_name, namespace, body | notice}`
- `receipt_update {msg_id, state, reason?}`: the schema shares `to_name?` with `receipt`, but the hub sets it only on `receipt`.
- `roster_changed {namespace}`
- `renamed {agent_ref, bus_name, former?}`: reply to `rename`. `former` is the name left, absent on a no-op. Names compare case-insensitively.

Targeting, idempotency (a send's `id` is unique per sender for at least 1 h;
a resend reuses it) and the decoder bounds are unchanged from OpenBus:
`decodeClientFrame` (hub) and `decodeServerFrame` (client) never throw; the
raw cap, a linear pre-scan, the body byte cap and well-formed Unicode on free
text are checked in that order. The pre-scan is per direction: client frames
depth <= 4, `:` plus `,` <= 16384, structural characters <= 65536; server
frames depth <= 5, 65536 and 131072, so a full roster of rows with status
fields and 5 `former_names` fits. Either way at most 64 `:` plus `,` directly
in one object.

## Renames (#393)

Ported from OpenBus R393a; schemas in `rename.ts` and `caps.ts`. The hub side
is OpenBus R393b (BusHub, `apps/server/src/bus/hub.ts`). Former-name
reservations are per member (one hub per member); there is no cross-member
addressing.

- Gate: a capability, not a version (the client reports 0.0.0 until #1308).
  `hello.caps` is up to `MAX_CAPS` (16) distinct tokens matching
  `[a-z][a-z0-9_-]{0,31}`; consumers ignore unknown ones. `BUS_CAPS.rename`
  (`rename`): the hub sends roster `former_names` and a former-name receipt
  `to_name` only to a socket whose hello listed it (`hasCap`). A decoder
  older than these fields refuses them, failing the whole frame.
- Client frames are strict, so a hub decoder older than this change refuses a
  `hello` with `caps`, an `agent_up` with `name_kind` and any `rename`. A
  client sends them only to hubs that accept them.
- Roster rows gain `former_names?: [{name, expires_at}]`
  (`FormerNamesSchema`): 1..`LIMITS.maxFormerNames` (5); absent when none. The
  hub guarantees newest first, distinct, and never the row's `bus_name`, all
  case-insensitive; the decoder doesn't enforce them, so one bad row can't
  fail a roster.
- A former name reaches its agent for `LIMITS.formerNameGraceMs` (1 h, the
  mail TTL). Name changes per agent are capped at `LIMITS.renamesPerHour` (10)
  per rolling hour; past it `rename` gets `error rate_limited` with message
  `RENAME_MESSAGES.rate` = `"Too many renames"`. A chosen former name stays
  reserved for its grace and is never dropped early, so with
  `LIMITS.maxFormerNames` (5) chosen former names in grace a `rename` that
  would leave another gets `error rate_limited` with message
  `RENAME_MESSAGES.room` = `"Too many recent names"` (OpenBus #451). A no-op
  doesn't count. A `rename` for an agent that isn't live is
  `error not_registered`.
- `name_kind` on `agent_up` and `rename` (`NAME_KINDS`: `default | chosen`):
  only the client knows whether a name is the harness's fallback or chosen.
  The hub mints a `default` name as `<base>-<4 hex>`, never reuses it and
  doesn't reserve it after a rename; a `chosen` former name is reserved for
  the grace. Absent means `chosen`.
- Resolution is the same for every client: the sender's own namespace first
  (current names, then former names), then other namespaces as before. A
  former name held by two agents in one scope is `ambiguous`. A global
  sender without `to_namespace`, past its own namespace: a live name in one
  namespace and another agent's former name in its grace (a chosen one left
  behind by a move or flip included) count as two, `ambiguous` (OpenBus
  #452); so does a role in one namespace and such a former name outside it.
  The sender's own former names never count, and a name held after its
  agent left the scope counts too (below).
- A namespace move or global flip (`agent_up` with a new `namespace` or
  `global`) keeps the agent's chosen former names reserved in the scope they
  were left in, until their grace ends, roles included (a role can't take
  one there); there they resolve to no one, so a send to one answers
  `unknown_agent` and never reaches the moved agent. Default former names go
  on a move. A move that also changes the name, a `-2` suffix included,
  leaves the old one the same way (OpenBus #451). A global agent moving its
  home namespace while staying global has not changed scope: its former
  names keep resolving. A repeat `agent_up` that changes a live agent's name
  in its scope is a rename and leaves a former name as `rename` does.
- A session leaving a scope holds its current name there for
  `LIMITS.formerNameGraceMs` (1 h), with no forwarding (OpenBus #451).
  Leaving is a close (`agent_down`, `sessions` closed, the 24 h offline reap
  of a machine, a machine revoke) or a namespace move or global flip, whether
  the name stays, changes or gets a `-2` in the new scope (a `rename_kept`
  move included). Within the hour another agent proposing the name there
  gets a `-N` suffix and a role can't take it; a send to it from there
  reaches no one: `closed` (or `revoked`) for a closed agent,
  `unknown_agent` for a moved one, never revealing where it went. A held name
  counts as a reservation for a global sender's ambiguity (for a role too),
  not toward the `RENAME_MESSAGES.room` cap, never appears in
  `former_names`, and is never dropped before its hour. The agent itself
  takes it back by reopening or moving back under it. A close also keeps the
  agent's chosen former names reserved for their grace; they resolve to no
  one until the agent reopens in their scope, when they resolve to it again.
  Default former names go on a close, as on a move. A role whose holder
  closes reads vacant (`role_vacant`), as before.
- Every scope change (a namespace move or global flip, same name or not,
  live or on a reopen) counts in the `LIMITS.renamesPerHour` limit, which
  bounds holds. Past the limit the `agent_up` still succeeds but keeps the
  agent in its current scope under its current name (the hub logs
  `move_kept`). Known limitation: `agent_ok` carries no namespace, so a
  client cannot see that a move was kept (open-bus #455 adds a signal).

## Role addresses (#1296)

A role address is a member-set alias in one namespace (`backend-lead`)
pointing at one agent, by its id, so it follows a rename. It lives in the
member's BusHub. Only the member sets, re-points, vacates or removes one, in
the dashboard (Open Artifacts REST, a browser session); no frame sets or
claims one, so no AI agent can.

- Resolution: a send to a role resolves at send time to its holder, scoped as
  names are (a non-global sender reaches its own namespace's roles; a global
  sender its own namespace's first, then a `to_namespace`'s, else a role in
  one namespace only, `ambiguous` otherwise). Re-pointing changes later mail
  only; mail already sent stays with the agent it resolved to.
- Vacant: no holder set, or the holder is closed, gone, or no longer in the
  namespace (a global holder is in every one). Refused `role_vacant`. A
  reopened session of the holder holds it again. A revoked holder's machine
  never reconnects, and a new machine's sessions are new agents, so a role
  whose holder was revoked stays vacant until the member re-points it.
- Gate: `BUS_CAPS.roles` (`roles`). The hub sends `role_vacant`, and a role
  hit's receipt `to_name` (the holder's current name), only to a socket whose
  hello listed it. Any other socket gets `unknown_agent` for a vacant role and
  no `to_name`; resolution is the same for every client.
- Names: a role's name is a bus name in the agent-name space of its
  namespace, case-insensitively. A role can't take a live agent's name there
  (in the namespace, or a global's), a chosen former name reserved there, or
  a name held there (OpenBus #451); an agent
  (`agent_up`, `rename`) proposing a role's name gets a `-N` suffix, and a
  global agent can't take any namespace's role name.

## Names and namespaces

Bus names: 1..64 chars of letters, digits, space, `.`, `_`, `-`, no IPv4
shapes. Reserved (`RESERVED_BUS_NAMES`): `open-artifacts` (the instance's
notice sender), `openbus`, `open-bus`, with case, separators and `-N`
suffixes folded. Namespaces are canonical `[a-z0-9._~/-]{1,128}`, derived by
`namespaceFrom`.

`.oa-bus.json` (`CONFIG_FILE`): strict `{namespace?, global?}`, nearest file
wins per key. `global` grants nothing; global comes only from the user's
allowlist under the client's home folder.
