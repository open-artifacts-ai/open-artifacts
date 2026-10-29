# Red line: audit of the real-tenant sign-in capture (before the one-shot)

What the person running the capture met on 2026-10-28 with
`scripts/signin-capture.ts` (the clipboard flow), every way it failed, and
how the one-shot driver (`pnpm -C tests/redline capture`,
`tests/redline/scripts/capture-oneshot.ts`) removes each. Runbook:
`docs/ops/redline-signin.md`.

## Everything the person met

### Commands

| Command | Where | Why |
|---|---|---|
| `pnpm oa:hosted redline-creds --env staging --install <id> --confirm <id>` | repo root, once per install (rl-a `ijzbmraouh5r`, rl-b `i42fdk7ahvs2`) | mints the admin PAT, copies the hook key, writes `~/.open-artifacts/redline-capture/secrets/` |
| `~/.open-artifacts/redline-capture/run-capture.sh [--gate]` | anywhere | the kit's wrapper: exports `REDLINE_TARGETS`, `REDLINE_DELETED_HOSTS`, `cd`s into a checkout, runs `signin-capture.ts` |
| or `cd tests/redline && node --experimental-strip-types scripts/signin-capture.ts --gate` | a checkout | the documented form |
| `scripts/redline.ts --gate` (spawned) | the same checkout | the live suite after the 5 prompts |

### Flags

| Flag | Needed by | Easy to miss because |
|---|---|---|
| `--env staging` | every `oa:hosted` command | the doc's `redline-creds` line left it out |
| `--install <id>` and `--confirm <id>` (same id) | `redline-creds` | two copies of an id the person has to look up |
| `--gate` | the capture, passed on to the suite | without it the run reports but never gates |

### Environment

| Variable | Set by | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the person, by hand | `oa:hosted` refuses without it (32 hex); no file holds it |
| `REDLINE_TARGETS` | `run-capture.sh` (`cat targets.json`) | JSON, not a path |
| `REDLINE_DELETED_HOSTS` | `run-capture.sh` | the rl-del hosts; without it one edge case is unproven |
| `REDLINE_ALLOW_UNCHECKED_BROKER=1` | the person, by hand | the approved override until the broker-probe hook ships (#846); applies only on its 404 |
| `REDLINE_SIGNIN_CAPTURES`, `REDLINE_CAPTURE_RUN`, `REDLINE_CAPTURE_NONCE` | the capture, for its suite child | never by hand |

### Files

| File | Mode | Made by |
|---|---|---|
| `~/.open-artifacts/redline-capture/targets.json` | 0600 | Platform, once (the kit) |
| `~/.open-artifacts/redline-capture/run-capture.sh` | 0700 | Platform, once; holds a hard-coded checkout path |
| `~/.open-artifacts/redline-capture/turnstile-token` | 0600 | Platform, once |
| `~/.open-artifacts/redline-capture/secrets/REDLINE_RL_{A,B}_{PAT,HOOK_KEY}` | 0600 | `redline-creds` |
| `~/.open-artifacts/hosted-staging/<app host>-hook-key` | 0600 | `oa:hosted create --test-hooks` (read by `redline-creds`) |
| Keychain item `oa-hosted-staging` (account `open-artifacts`) | Keychain | the hosted operator, once (read by every `oa:hosted` command) |
| `gh auth` login | `~/.config/gh` | `redline-creds` sets the GitHub Environment secrets through `gh` |
| `git config user.email` | git | `oa:hosted` records it as the audit actor |
| A suite checkout | git | whatever `run-capture.sh` points at |

### Hosts

- `rl-a.open-artifacts-staging.app`, `rl-b.open-artifacts-staging.app` (the installs; their `/auth/login/google` and `/auth/callback/google`)
- the auth broker (`/google/authorize`, `/google/callback`)
- `accounts.google.com` (account chooser, password, consent)
- `rl-stray.open-artifacts-staging.app`, the rl-del hosts (suite only)

### Screens

1. Terminal: the preflight table, then 5 prompts of 6 lines each.
2. A Chrome Incognito window, with the browser's network inspector open, "Preserve log" ticked and a
   `callback/google` filter typed.
3. Google: account chooser (filtered by `hd` on 4 of the 5 prompts), password, sometimes 2-step.
4. The install's sign-in error or retry page after the first callback.
5. A second Google screen from the install's automatic `r1.` retry, showing
   the other tenant's `hd` (for prompt 2 it shows tenant C's hint while the
   person signs in as tenant A's alice).
6. The network inspector's request list: right-click, Copy, Copy URL, on the FIRST callback of the
   prompt.

## Friction and failures, and how the one-shot removes each

| # | What happened | Cause | One-shot |
|---|---|---|---|
| 1 | `redline-creds` refused | `--env staging` missing from the doc | the driver prints (or with `--make-creds` runs) the exact command with `--env staging`; flags checked against `scripts/hosted/src/cli.ts` and `--help` |
| 2 | `redline-creds` refused again, then again | `CLOUDFLARE_ACCOUNT_ID` unset; then the Keychain item, `gh auth` and the hook-key file each found one at a time | prerequisites checked up front, all at once, each with its exact fix; the account id is read from the env or `~/.open-artifacts/redline-capture/cloudflare-account-id`, else asked once and saved there (0600) |
| 3 | Preflight refused on the broker probe | the server hook was never built (#846) | `REDLINE_ALLOW_UNCHECKED_BROKER=1` is built in (it still refuses on anything but the hook's 404) |
| 4 | Wrong callback host copied | the inspector lists several callbacks; the person picked another host's | no copying: the driver intercepts the callback in Chrome itself, armed for this prompt's install origin and state only |
| 5 | Confused by the `r1.` retry screen showing the other tenant's `hd` | the browser consumed the first callback and the install retried | the first callback is held by the driver (CDP `Fetch.failRequest`) before it leaves the browser, so the install never sees it and never retries; the window closes at once |
| 6 | `run-capture.sh` ran a stale checkout | a hard-coded path in the kit | the driver runs from this repo and imports the suite from `--suite` (default `~/code/projects/openartifacts-capture`), refusing unless its HEAD is `--expect-sha` and its tree is clean |
| 7 | The secrets dir was empty | `redline-creds` never ran on this Mac | prerequisite check names each missing file and the command that writes it |
| 8 | Couldn't run as a `!` command | 5 prompts waited for Enter after a clipboard copy | the terminal needs no input on the happy path; the only key is `r` to retry a prompt that timed out |
| 9 | alice's Google session reached dave's prompt | one Incognito window for all prompts | a fresh temporary Chrome profile per prompt, deleted when the prompt ends |
| 10 | The clipboard held a live credential | pbcopy/pbpaste | no clipboard anywhere; the URL stays in the driver's memory |
| 11 | The person had to read and follow a 6-line instruction per prompt | the manual inspector flow | one line per prompt: who to sign in as and what Google will offer |
| 12 | A slow prompt meant re-reading the doc | only a "too old" message after the paste | a per-prompt timeout (5 min, `--prompt-timeout-min`) names the prompt, the user and the key to retry it |
| 13 | Google could refuse an automated browser | n/a with a manual window, but a risk for any driver | Chrome is started as a normal process (no `--enable-automation`, `navigator.webdriver` false, checked in a throwaway tab), driven by raw CDP with only `Target` and `Fetch` on the browser session and no session at all on the sign-in tab (no `Runtime`, no `Page`, no init script); if Google still shows "This browser or app may not be secure" or another block, the driver stops with a plain message saying it is Google refusing the automated browser, not a test failure, and never retries on its own |
| 14 | Verdicts bound to whatever checkout ran | `suiteSha()` is git HEAD of the directory holding `capture.ts` | the driver imports `capture.ts` from the frozen checkout, so the verdicts carry its SHA, which matches CI's `GITHUB_SHA` for that commit |

## Failure modes the one-shot keeps or adds

- Ctrl-C, SIGTERM or SIGHUP at any point: Chrome (its whole process group, by PID) is
  stopped and its profile deleted; the verdicts directory is removed.
- Chrome missing, not macOS, the suite checkout dirty or at another commit:
  refused before anything starts, with the fix.
- A callback for another host, or with another state (including any `r1.`):
  never captured. With the interception pattern scoped to the prompt's
  install origin, another host's callback is not even paused.
- The remote-debugging port listens on 127.0.0.1 only, on a port Chrome picks
  (`--remote-debugging-port=0`), and only while the prompt's window is open.
