# @oa/bus-daemon

The per-machine Open Artifacts bus daemon. It holds the machine's one WebSocket to the hub,
serves adapters on a local socket (`<OA_BUS_HOME>/daemon.sock`), attests each
adapter's session, and delivers hub messages through the harness transports
(Claude Code over its own UDS socket).

## Old adapters

An adapter process can outlive an upgrade: a Claude session's MCP server, Pi
or OpenCode started on 0.44.x keeps its strict three-kind decoder. Adapters
from 0.45.0 say hello with `client_version` (the IPC marker); a hello without
it gets every `kind` in `list`, `self` and `status` replies mapped to
`claude-code`, `opencode` or `pi`, so an `omp` agent shows as `pi` and stays
reachable by name. See `packages/shared/CONTRACT.md`, Version-gating.

## Security assumptions

- **The threat model is same-uid.** The daemon protects one user's agents from
  each other's mistakes. It does not protect them from other processes running
  as that user.
- **Socket permissions.** The local socket is 0600 in a 0700 directory, and so
  are Claude return sockets. No other user can connect.
- **Unverified `hello.pid`.** `hello.pid` is not checked against peer
  credentials, because Node has no `SO_PEERCRED`. Attestation walks that pid's
  ancestry and session files, and it trusts the pid it is given.
- **Attestation's limits.** Any same-uid process can already read the machine
  token in `machine.json` and Claude's session keys in `~/.claude/sessions`.
  Attestation therefore stops accidental identity sharing, such as a
  session claiming another session's ref or an outer session being claimed
  from inside a nested one. It does not stop a hostile process running as the
  same user.
- **Revoke.** Only the hub's answer revokes: a `4403` close, or `401` at the
  upgrade (CONTRACT §GET /hub). A `403` (a WAF or a proxy) or any other
  refusal is retried with backoff. The revoked marker names the refused token
  by its sha256, so a newer token `login` saved since is never blocked by it.
