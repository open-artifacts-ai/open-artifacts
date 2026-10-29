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
| 4 | Wrong callback host copied | the inspector lists several callbacks; the person picked another host's | no copying: the capture extension blocks the callback in Chrome and reports it to the command, which accepts only this prompt's install origin and state, once |
| 5 | Confused by the `r1.` retry screen showing the other tenant's `hd` | the browser consumed the first callback and the install retried | the extension's `declarativeNetRequest` rule blocks the callback (the broker's 302 target) before it leaves the browser, so the install never sees it and never retries; the tab closes at once |
| 6 | `run-capture.sh` ran a stale checkout | a hard-coded path in the kit | the driver runs from this repo and imports the suite from `--suite` (default `~/code/projects/openartifacts-capture`), refusing unless its HEAD is `--expect-sha` and its tree is clean; checked again right before the suite runs |
| 7 | The secrets dir was empty | `redline-creds` never ran on this Mac | prerequisite check names each missing file and the command that writes it |
| 8 | Couldn't run as a `!` command | 5 prompts waited for Enter after a clipboard copy | the terminal needs no input on the happy path (one Load unpacked in Chrome per run, then only the Google sign-ins); the only key is `r` to retry a prompt |
| 9 | alice's Google session reached dave's prompt | one Incognito window for all prompts | one temporary profile per run; before each prompt the extension clears the cookies and storage of accounts.google.com and google.com; the profile is deleted at exit |
| 10 | The clipboard held a live credential | pbcopy/pbpaste | no clipboard anywhere; the URL goes from the extension to the command's 127.0.0.1 listener (token-guarded) and stays in memory |
| 11 | The person had to read and follow a 6-line instruction per prompt | the manual inspector flow | one line per prompt: who to sign in as and what Google will offer |
| 12 | A slow prompt meant re-reading the doc | only a "too old" message after the paste | a per-prompt timeout (5 min, `--prompt-timeout-min`) names the prompt, the user and the key to retry it; Chrome closing mid-prompt is noticed at once |
| 13 | Google could refuse an automated browser | n/a with a manual window, but a risk for any driver | there is no automation: plain Chrome with only `--user-data-dir`, `--no-first-run` and a URL (no debugging port, no automation or blink switches; a unit test asserts the argv), and an extension the person loads. If Google still shows a block page (automation, unsupported browser, OAuth error such as `disallowed_useragent`), the extension reports its URL and the command stops with a plain message saying it is Google refusing the browser, not a test failure, and never retries |
| 14 | Verdicts bound to whatever checkout ran | `suiteSha()` is git HEAD of the directory holding `capture.ts` | the driver imports `capture.ts` from the frozen checkout, so the verdicts carry its SHA, which matches CI's `GITHUB_SHA` for that commit |

## Failure modes the one-shot keeps or adds

- Ctrl-C, SIGTERM or SIGHUP at any point (including at the account id
  question): Chrome (the process group the command started) is quit and the
  temp dir (profile, extension copy, verdicts) is deleted.
- `kill -9` of the command: it can't clean up. It prints the temp dir at
  start; the runbook says how to quit that Chrome and delete the dir by hand.
- The extension isn't loaded: the command waits with a plain message and has
  no fallback. Requests without the run's token get 403.
- Chrome missing, not macOS, the suite checkout dirty or at another commit:
  refused before anything starts, with the fix.
- A callback for another host, or with another state (including any `r1.`):
  blocked by the extension (the code is never spent) and never captured.
- Chrome closes mid-prompt: noticed at once; `r` reopens it on the same
  profile and retries that prompt.
- Chrome 137 and later ignore the command-line extension switch, so the
  extension is loaded by hand once per run (Developer mode, Load unpacked).
