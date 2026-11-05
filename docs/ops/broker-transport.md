# Broker transport (install side)

How an install reaches the auth broker (`auth.<zone>`) and the directory
broker (`directory.<zone>`), and what to expect across versions. Code:
`apps/server/src/auth/broker-transport.ts`. Platform's side (the BrokerGate in
dispatch and the scheduler) is in `docs/ops/hosted.md`.

## Precedence

For each broker, the first that is available:

1. A service binding: `BROKER` (auth) or `DIRECTORY_BROKER` (directory).
   This is for a self-hosted install on the broker's account.
2. The invocation's props: `ctx.props.AUTH_BROKER` or
   `ctx.props.DIRECTORY_BROKER`. Hosted installs get these from dispatch (user
   requests) and from the scheduler (`scheduled()`). A stub is valid only
   during the invocation that received it.
3. HTTPS to `AUTH_BROKER_URL` or `DIRECTORY_BROKER_URL`. Self-host only.
   `HOSTED=1` never uses HTTPS, because a Worker reaching a Route on its own
   zone gets 522.

A hosted install with no binding and no props fails closed:

| Failure | Sign-in (OIDC stage) | Directory (stage) |
| --- | --- | --- |
| No binding and no props | `broker_unavailable` | `broker_unavailable` |
| The gate refused the call (`x-oa-gate: 1`) | `broker_gate_refused` | `gate_refused` |
| A stub used past its invocation | `broker_unavailable` | `gate_stale` (nothing sent, retried next tick) |

The broker's own 401 is still `broker_http_401` for sign-in and `refused` for
directory.

## Directory sync on hosted installs

The `DirectorySync` alarm never calls a broker. The scheduler runs the system
job `oa:directory-sync` every 2 min. When a run is due and the DO holds no
token, the job mints the Google access token through `DIRECTORY_BROKER` and
hands the token (never the stub) to the DO. The DO keeps it in memory only,
for 45 min, and its alarm runs the sync as before. A request's kick (Sync now,
a held confirm, a mapping change, a connect) feeds the token the same way.

The cadence is unchanged: fast every 2 min, reconcile hourly, backoff from
2 to 30 min, hourly retries.

If no token arrives for 15 min while a lane is due, the lane fails as
`transport_no_feed`. That brings the usual health state, the
`directory.sync.failed` audit row, the stale mark after 7 days and the owner
alert. Check the scheduler feed first: an install that gets
`oa:directory-sync` without props logs `directory_feed` with outcome
`no_props`.

## Version skew

- **Deploy order.** Platform's BrokerGate (#720) and its `x-oa-gate` refusal
  header (#725) must be on staging, then production, before an install
  release with this transport (#722) rolls out. A hosted install on the new
  release without props fails closed instead of trying HTTPS. HTTPS already
  answered 522 there, so sign-in and sync are no worse.
- **Older installs** (before #722) reject `oa:directory-sync` with
  `unknown system job`. Until every install has upgraded, the scheduler should
  count that answer as expected, not alert on it.
- **Older installs** ignore the props and keep using HTTPS, which still 522s.
  Upgrading is the fix.
- **Self-hosted installs** are unaffected. With a binding, HTTPS, or their own
  Google app, the alarm mints the token itself, as before.
