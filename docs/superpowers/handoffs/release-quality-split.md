# Release Quality handoff: split freeze

Status page: https://artifacts.leourbina.com/a/LVXbn6G5V6xiMNXu

Frozen until the repository split is done. Do not merge this WIP branch.

## Queue position

Next: #1428, issue read only. No implementation started.

1. #1533: historical root cause and positive control complete; issue disposition pending.
2. #1242: already fixed by merged #1264, fresh suite 7/7; issue disposition pending.
3. #1428: whole-page negative matches against random codes/nonces; inspect rendered network line instead. Not yet verified against current code.
4. #1356: wfp-create random-secret /hook/i match.
5. #1575: remaining wfp-create T3b flake.
6. #1364: red-line R15 classification.
7. #1416: smoke waits for running staging deploy.
8. #1420: smoke pins staging spaces state.
9. #1438: smoke full MCP tool set.

Issue URLs: https://github.com/open-artifacts-ai/open-artifacts/issues/<number>

## #1637 must be withdrawn, not merged

https://github.com/open-artifacts-ai/open-artifacts/pull/1637
Head before this handoff: 2532f704b43829820272dedea6b335842aa58f87.

The timeout-only mitigation is unsupported. The initial stalled-runner diagnosis was wrong and was withdrawn in a PR comment. A close attempt was refused; Manager is coordinating permissions. Leave it open during the freeze; close after the freeze and permission clarification. Keep this WIP on a separate branch, not the PR head.

## #1533 evidence

Historical run: https://github.com/open-artifacts-ai/open-artifacts/actions/runs/42098416740
Historical source: 7f5ce1ed059dfb20d9f9a11273109d43e2b6cbfa.

The old test seeded inboxes before synchronizing its final unacknowledged close. If that close lands after seeding, the last churn agent is omitted from inbox seeding and then becomes the empty-inbox preferred eviction victim, instead of the original intended recipient. No expected expiry receipt arrives. The failed log also contained a decoder-rejected receipt ID seed-4cN1sQ7yWw6s3yZL.

Both issues were already fixed by https://github.com/open-artifacts-ai/open-artifacts/pull/1521, commit 403a749be3a3c4a2b43a97825e9a02c82e03a554 (ancestry verified).

Negative control: delay the last close until after inbox seeding. Test expected churn_998 to remain, but the original recipient remained instead. Failed in 20.56 s.

Positive control: observe the final close before seeding, then assert exact receipt ID, expired state, recipient_closed reason and intended recipient eviction. Passed twice. Second pass used original 15 s per-frame timeout and original 120 s test timeout: 1/1, test time 26.94 s, total 34.25 s.

Research source saved in apps/server/test/bus/rq1533-ordering-repro.test.ts on this WIP branch. It is a scratch positive control, not a proposed production test or mergeable fix. It includes copied helper code and unused timeout constants from the rejected PR; clean it up or discard after the handoff, not during the freeze.

Published source: https://artifacts.leourbina.com/a/LgEbfLBi1p29atTL v1.

## #1242 evidence

https://github.com/open-artifacts-ai/open-artifacts/pull/1264
Commit f5ef498ff6e3b76c1c4f677279b2c9b59ede90af replaces the cumulative assertion with per-alarm invocation accounting and exact nonempty runs [50, 7]. Workerd's automatic alarm can run in addition to the test's explicit alarm; the old count included multiple valid bounded invocations.

Fresh worktree oa-wt-rq-1242 on rq/1242 at 05202e53 (release 0.134.0). Offline install, test:prep, server gen succeeded. suspend.sockets.test.ts: 7/7 passed, 1.57 s tests, 6.26 s total. No source changes. Historical forced-order and mutation evidence in #1264 was not rerun.

## Local leftovers

- oa-wt-rq-1533: ignored generated files and untracked packages/auth-core/tsconfig.tsbuildinfo, a build byproduct; not committed.
- oa-wt-rq-1242: dependencies/generated files from verification; no intended source changes.
- No merge, deployment, deletion, or cleanup authorized by this handoff.
