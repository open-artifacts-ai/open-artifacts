# Contributing

Rules for everyone working in this repo, people and agents alike.

## Talk to us

Join the [Open Artifacts Discord](https://discord.gg/3BwpMufj4a) to discuss a proposal before you build it, ask about an open PR, or get setup help. Decisions and reviews still happen on GitHub issues and PRs.

## Git

- **Never use `git stash`.** The stash is shared by every worktree of a clone, so a
  `pop` in one worktree can apply or drop someone else's work. Commit work in progress
  to your own branch instead.
- One task per branch and PR. Branch from an up-to-date `origin/main`.
- Never force-push.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `ci:`, `test:`, `chore:`; add `!` for breaking changes). release-please uses
them to build the changelog and choose the next version.

## Merging

- `main` merges through the merge queue: `gh pr merge <number> --squash --auto`.
  The queue re-runs the required checks (lint, typecheck, test, build, e2e) on top of
  `main` and squash-merges once they pass. You don't need to update your branch first.
- No admin bypass. If staging goes red after a merge, merges pause until it's green again.

## Releases

A PR that changes what installs serve to agents (`apps/server/src/mcp/`: the skill, the upgrade guide, `llms.txt`, the MCP instructions and tool text, and their emitters `apps/server/scripts/emit-skill.ts` and `emit-upgrade.ts`) must be titled `fix:` or `feat:` (or a breaking `type!:`). The squash commit takes the PR title, and release-please ships no release for any other title (`test:`, `docs:`, `chore:`, `ci:`, or no type), so the `release-title` check fails such a PR until it is retitled (it runs again when the title is edited).

release-please opens a release PR that only bumps versions: `CHANGELOG.md`, `.release-please-manifest.json`, and the `"version"` field of `package.json` files. Such a PR, and its merge-queue run, takes a fast path. There is no separate job: `typecheck`, `test`, `build` and `e2e` each start with a full checkout and a `release-only` step that copies `scripts/ci/release-only.ts` out of the **base** commit (never the code under test) and runs it on the base and head. When every changed file is a release file (a `package.json` counts only if a semver `"version"` is the sole key that differs; a rename or delete never counts), the job still runs and reports, but skips its heavy steps, so the required checks finish in about a minute instead of nine. Any error, a script missing at the base (the first rollout), or any output other than exactly `release-only` means full CI. This is safe because the base commit is on main, which only the merge queue can update, and the PR changes no code, scripts or dependencies; the job doesn't claim CI passed, only that nothing needing it changed. `lint` always runs in full, including a check that the root version, the manifest and the first `## ` heading in `CHANGELOG.md` agree. The decision uses only the script's output, never a label, branch name or author. Push events and every other PR are unchanged.

Releases ship on events, never on a timer. The `release-cadence` workflow runs when `CI` finishes (the release PR's own checks), when `release-please` finishes, and on manual dispatch. On every event it finds the open release PR, reads its head, and reads every check main requires (what the rules on main list at that moment, read from `rules/branches/main`, and never fewer than `lint`, `typecheck`, `test`, `build`, `e2e`, `no-test-hooks` and `authz-matrix` from GitHub Actions; an unreadable list fails the run) on that exact head SHA through the check-runs API, so a release PR whose own CI event was dropped or replaced in the one-slot concurrency queue is still picked up by the next event. Only when each one's newest run passed does it put the PR at the front of the merge queue with the release App's token (GraphQL `enqueuePullRequest` with `jump: true`), pinned to that head (`expectedHeadOid`). It re-reads the PR head right before queueing; if release-please pushed a new head since, it does nothing and a later event handles the new head. It refuses (the plan step fails and says why in the run summary) unless the title's version, `.release-please-manifest.json`, `package.json` and `CHANGELOG.md`'s first heading all agree and that version is above the latest `vX.Y.Z` tag and above main's own manifest and `package.json` versions (an unreadable main refuses too). A draft release PR is never queued. There is no wait for the queue to drain and no cap: the release PR jumps ahead of any queued code PRs, so its merge group holds only the release and keeps the release-only fast path, and code PRs queued behind it go into the next release. If GitHub's reply puts it anywhere but position 1, the run fails and names the position. A release PR already in the queue, or one that already landed, is left alone. If the release PR's checks fail, or it has been open for more than 24 hours, the workflow opens (or refreshes, only when the text changed) one issue labelled `blocker`, titled "Release blocked: ...", with links to the failing checks; on every run, any such issue older than the latest published release is closed with a comment naming the tag. After a release is created and deployed, the `verify-release` job (skipped for pre-release tags) polls prod `/healthz` until its `version` is the released one (up to 3 minutes) and checks that the landing page's `<meta name="oa-version">` matches; if not, it opens a `blocker` issue "Release vX.Y.Z not live: ..." and fails, and a later successful verify closes it. A manual cut is still fine: queue the release PR any time.


New server migrations that change existing data, rebuild tables or contain SQL
the CI check cannot classify as additive require `-- oa:non-additive` as the
first line. Add a `-- oa:verify` comment describing the before/after evidence
the reviewer should check. Released migration files are immutable.
