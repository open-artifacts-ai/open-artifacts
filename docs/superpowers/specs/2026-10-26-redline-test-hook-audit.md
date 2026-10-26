# Red-line test hooks: `POST /__test/audit` (addendum)

Adds one hook to the contract in
`docs/superpowers/specs/2026-10-20-redline-test-hooks.md` (PR #637). Once
#637 merges, fold this into its "Hooks" section and drop this file.

## `POST /__test/audit`

Read-only. For the P5 case "a hook call is audited" on staging, which has no
D1 read in CI.

- Gates: identical to every hook (build flag, `TEST_HOOKS=1`, 32+ char
  `TEST_HOOK_KEY` compared in constant time, non-empty `TEST_DOMAIN`,
  `RL_ANON` `test:` bucket, app host only). Every refusal is the same 404.
- Body (`TestAuditInputSchema`, strict): `{ since }`, ms since the epoch,
  integer ≥ 0. Anything else: audit `refused`, 404.
- Returns `200 { events }`: `{ action, at, actorId, targetId, detail }` per
  row with `at >= since`, newest first, at most `TEST_AUDIT_LIMIT` (200).
- Only `test_hook.*` rows, enforced in SQL: `actor_kind = 'test_hook'` and
  `substr(action, 1, 10) = 'test_hook.'` (no `LIKE` wildcards). No other
  audit event can leave through it.
- Audited like every hook (`test_hook.audit`, outcome `ok`), written after
  the read: the response is the log as it stood, and the call's own row shows
  up in the next read.
- `GET /api/v1/audit` and its export are unchanged: still no `test_hook`
  rows.
- Release builds drop it with the rest of `test-hooks/`
  (`test-hooks-strip.test.ts` marker, `check-no-test-hooks` path list).

## Suite check, staging

`since = Date.now()`, call `/__test/session`, then `/__test/audit { since }`:
expect an event with `action = 'test_hook.session'`. This replaces the
`unproven-live` report for that check.
