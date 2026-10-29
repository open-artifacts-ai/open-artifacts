# Red line: the real-tenant sign-in step (one command, about 5 minutes)

Two gate cases need tokens only Google can issue: **hd of A at B** and **A's
aud at B** (`tests/redline/live/signin.test.ts`). Without this step they report
`unproven-live` and the gate fails. The step is **5 Google sign-ins** with two
test users, then the suite runs. The suite never mints or signs a token.

You run one command, load a small extension into the Chrome window it opens
(once per run), and type two test accounts' passwords. Nothing is copied or
pasted. Why it is built this way, and what it replaced:
`docs/ops/redline-capture-audit.md`.

## Run it

From this repo (any checkout with this command; the suite itself runs from
the frozen checkout, see "The gate binding"):

```sh
pnpm -C tests/redline capture
```

The first time, or when the admin secrets are missing, add `--make-creds`
to have it make them (it shows the commands first; see "What it checks
first").

1. After its checks it prints the run's temp dir
   (`~/.open-artifacts/redline-capture/run-XXXX`, 0700), then opens Google
   Chrome on its Extensions page with a temporary profile, and prints:

   ```
   Chrome is open on its Extensions page, with a temporary profile for this run. Load the capture extension once, in the Chrome window that just opened (not your own Chrome):
     1. Turn on "Developer mode" (top right).
     2. Click "Load unpacked" and choose this folder: /Users/you/.open-artifacts/redline-capture/run-XXXX/extension
        (In the folder picker press Cmd-Shift-G, paste the path, press Return, then Select.)
   Waiting for the extension to check in (Ctrl-C stops).
   ```

   Do those two clicks **in the Chrome window that just opened**. (Chrome
   137 and later ignore the command-line switch that used to load
   extensions, so this step is by hand.) The command waits until the
   extension checks in with this run's token, from that Chrome. It has no
   other way forward. If you load it in your own Chrome by mistake, the
   command refuses it (it only talks to the Chrome it started, by process
   group, so your own Chrome's Google cookies are never cleared) and says:

   ```
   The capture extension checked in from another Chrome. Load it in the Chrome window that just opened, not your own Chrome. Still waiting.
   ```

   Remove it from your own Chrome afterwards.
2. For each of the 5 prompts it first checks the `hd` hint in the Google
   sign-in URL it is about to open (built before any tab exists): present
   and right for a-alice, a-alice-replay, b-dave and b-dave-2 (the
   install's tenant), absent for b-alice. If it is wrong, the run stops
   before opening anything and asks for no sign-in:

   ```
   Stopped before prompt 1 of 5 (rl-a, alice@oa-redline-a.fyi): the Google sign-in URL has hd=oa-redline-c.fyi, but this prompt needs hd=oa-redline-a.fyi.
     Don't sign in. Nothing was redeemed. This is a setup problem (the broker registry's domains for the install), not a red-line result. Tell Platform.
   ```

   When the hint is right it clears Google's cookies, sends a probe callback
   the extension must block and report, opens a new tab on Google's sign-in
   page and waits for the extension to classify that page (a block page
   stops the run here, before you are asked anything). Google may drop `hd`
   after its own redirects, so the page itself is never judged on it. Then
   it prints one line, for example

   ```
   [1/5] rl-a: sign in as alice@oa-redline-a.fyi in the new Chrome tab (Google offers only oa-redline-a.fyi accounts). Google may ask you to confirm it's you; that's normal. The tab closes by itself.
   ```

   Type the named account and its password (password manager). When Google
   hands the sign-in back, the tab closes on its own and the terminal prints
   `captured, N of 5` and each leg's verdict (`pass`, or `fail` with the
   reason).
3. After prompt 5, Chrome quits, the frozen checkout is checked again, and
   the live suite runs with `--gate` and prints the gate result.

If a prompt sees no sign-in within 5 minutes (`--prompt-timeout-min <n>`):

```
[2/5] No sign-in came back within 5 min.
  Redo prompt 2 of 5: sign in as alice@oa-redline-a.fyi at rl-b. Press r to retry it (Ctrl-C stops).
```

If Chrome closes during a prompt (a crash, or you quit it), it says so at
once:

```
[2/5] Chrome closed during this prompt.
  Redo prompt 2 of 5: sign in as alice@oa-redline-a.fyi at rl-b. Press r to reopen Chrome and retry it (Ctrl-C stops).
```

Press `r`: Chrome reopens on the same profile (the extension stays loaded)
and that prompt starts again. Ctrl-C at any point, including at the account
id question, quits Chrome, deletes the temp dir and exits.

If Google refuses the browser (its "This browser or app may not be secure"
page, another automation or unsupported-browser page, or an OAuth error page
such as `disallowed_useragent`), the extension classifies the page as a block
and the run stops at once:

```
Stopped at prompt 1 of 5 (rl-a, alice@oa-redline-a.fyi): Google showed its block page.
  This is Google refusing to sign in from this browser (its automation, unsupported-browser or OAuth error page), not a red-line test failure. Nothing was retried and nothing was redeemed.
```

It never retries on its own. Tell Platform.

### If the command itself is killed hard

Ctrl-C, SIGTERM and SIGHUP clean up. A `kill -9` of the command can't: its
Chrome may stay open and its temp dir (the one printed as `Temp dir for this
run:`) stays on disk, holding Google session cookies. Quit that Chrome
window (Cmd-Q), then delete the dir:

```sh
rm -rf ~/.open-artifacts/redline-capture/run-XXXX   # the path it printed
```

## What it checks first (each refusal names its fix)

In order, all before Chrome opens:

1. **Prerequisites.** macOS; Google Chrome at `/Applications/Google Chrome.app`
   (`--chrome <path>` otherwise); the frozen suite checkout (below) at the
   expected commit with a clean tree, installed and generated;
   `~/.open-artifacts/redline-capture/targets.json` (0600, staging); each
   install's Turnstile token file (0600).
2. **Credentials.** Each install's admin PAT and hook key under
   `~/.open-artifacts/redline-capture/secrets/` (0600). When one is missing it
   prints the exact commands, for example

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<id> pnpm -C ~/code/projects/openartifacts-capture oa:hosted redline-creds --env staging --install ijzbmraouh5r --confirm ijzbmraouh5r
   ```

   and, with `--make-creds`, runs them. The account id comes from
   `CLOUDFLARE_ACCOUNT_ID`, else `~/.open-artifacts/redline-capture/cloudflare-account-id`,
   else it asks once and saves it there (0600, dir 0700). Those commands
   also need, and it checks first: the Keychain item `oa-hosted-staging`
   (account `open-artifacts`), `gh auth status`, `git config user.email`,
   and each install's `~/.open-artifacts/hosted-staging/<app host>-hook-key`
   (0600).
3. **The preflight** (below), with `REDLINE_ALLOW_UNCHECKED_BROKER=1` built in
   until the broker-probe hook ships (#846). The override applies only when
   the hook answers 404; any other answer still refuses.
4. **The capture**, then **the suite** with `--gate` (and
   `REDLINE_DELETED_HOSTS` set to the rl-del hosts unless `targets.json` has
   `deletedHosts`).

Every flag and environment variable the old steps needed is built in.

There is no separate dry run: each prompt's `hd` check, the interception
probe and the block-page check happen in the real run, before you are asked
to sign in.

## How the browser half works

- **Plain Chrome.** The installed Google Chrome is started (in its own
  process group, so the command can quit all of it) with exactly
  `--user-data-dir=<temp profile> --no-first-run chrome://extensions/`: no
  debugging port, no automation or blink switches (a unit test asserts the
  argv). The profile is fresh for the run, so Google may ask you to confirm
  it's you (a new-device check); that is normal, not a block.
- **The capture extension** (`tests/redline/capture-extension/`, MV3). For
  each run the command writes a copy into the temp dir with that run's
  `manifest.json`, `rules.json` and `config.js`: the listener port and a
  random token. Its host permissions are only the two install app origins
  from `targets.json`, `http://127.0.0.1/*` for the listener, and
  `https://accounts.google.com/*`, observe only, to classify Google's
  top-level pages in a prompt's tab. For Google it never sends the command a
  URL, path or query string (those carry sign-in state): only
  `{ prompt, google: "signin" | "block", hd }`, computed inside the extension
  (`classify.js`). The listener refuses any other shape.
  - `declarativeNetRequest` blocks top-level requests to
    `<install>/auth/callback/google*`, so the browser never spends a code.
    The callback arrives as the broker's 302 target and the block catches
    that redirect hop: the install never receives it, so it never starts
    its automatic retry (no `r1.` screen).
  - `webRequest`, observe only: on that block
    (`net::ERR_BLOCKED_BY_CLIENT`) it sends the URL to the command's
    127.0.0.1 listener with the run's token and closes the tab. The listener
    refuses any request without the token. The command takes only this
    prompt's host and state, once. Another host, another state or an `r1.`
    retry is never captured.
  - On the command's request, before each prompt, it clears the cookies
    and storage of accounts.google.com, www.google.com and google.com (`chrome.browsingData`)
    and closes the tabs it opened, so alice's Google session never reaches
    dave's prompt. This only ever runs inside the temp profile.
  - It opens each prompt's tab (`chrome.tabs.create`). It logs nothing.
- The captured URL stays in memory: it is checked by the frozen capture code
  and redeemed at once, each leg's verdict going to a 0600 verdicts file in
  the 0700 temp dir. It is never printed, logged, put on the clipboard or
  written anywhere else.
- On every exit path (success, error, timeout, a Google block, Ctrl-C,
  SIGTERM, SIGHUP) the command quits Chrome (kills the process group it
  started and waits for it) and deletes the temp dir.

## The preflight

The command checks everything else first and **refuses to start**, naming
each gap, if anything would leave a case unproven or failing for setup
reasons. All checks are read-only; secret files are checked for existence and
mode 0600 only, and nothing secret is printed.

| Check | Gap means |
|---|---|
| Each install's admin PAT file exists, mode 0600 | the capture prints (or with `--make-creds` runs) `redline-creds` |
| Each install's Turnstile token file exists, mode 0600 | set `turnstileFile` on that target |
| `strayHost` is set in `targets.json` | add it to the kit's `targets.json` |
| Both `/healthz` versions are equal and at least the suite's release | upgrade the installs first |
| Google sign-in is on at each install (`/auth/providers`) | turn it on |
| `TEST_DOMAIN` is not in `AUTH_DOMAINS`, and each install's tenant domain is | in-domain addresses never get codes on a google+email install |
| alice is invited to (or a member of) `rl-a`, dave of `rl-b` (`GET /api/v1/members`, admin PAT) | invite them |
| Each install's sign-in start reaches Google through the broker | the broker or its registry is down |
| Each install's server reaches its broker (`POST /__test/broker-probe`) | "rl-x: install can't reach the auth broker (status N)". Until the hook ships it reads "unchecked (hook not deployed)", allowed by the built-in override |

The inventory key is a GitHub secret only, so on a laptop the inventory check
says **CI-only (not-local)** instead of refusing: the inventory cases then
report unproven (their reason says CI-only) and never count as a pass.

## What each sign-in proves

| Prompt | Install (tenant) | Google offers | Sign in as | Expected | Used for |
|---|---|---|---|---|---|
| 1 | rl-a (A) | oa-redline-a.fyi | alice@oa-redline-a.fyi | succeeds | hd of A at B: A's own sign-in works |
| 2 | rl-b (C) | any account (the hint is removed) | alice@oa-redline-a.fyi | refused, on purpose | hd of A at B: B refuses tenant A's user |
| 3 | rl-a (A) | oa-redline-a.fyi | alice@oa-redline-a.fyi | refused at rl-b, then succeeds at rl-a | A's aud at B |
| 4 | rl-b (C) | oa-redline-c.fyi | dave@oa-redline-c.fyi | succeeds | hd of A at B: B's own sign-in works |
| 5 | rl-b (C) | oa-redline-c.fyi | dave@oa-redline-c.fyi | succeeds | A's aud at B: B's own sign-in works |

Prompt 2's mismatch is the test. The broker asks Google to offer only the
install's tenant (`hd`), so for prompt 2 the capture removes that hint, as
someone from another tenant would, and rl-b must still refuse alice on her
token's tenant. Google's cookies are cleared before each prompt, so there is
nothing to sign out of between alice and dave.

Codes are single use, so each of the 3 legs per case (B's own success, A's own
success, A's value refused at B) needs its own sign-in; the aud case gets two
legs from one capture (refused at B first, then accepted at A).

Other sign-in cases need no human: OIDC state replay, one-time codes and
guests run live; the tampered broker install id runs on staging from a real
broker state. The cases Google can't produce and the broker's signed redeem
assertion are covered by fixtures (see the P5 plan, Task 6).

## The gate binding

`verdicts.json` records what the capture ran against: a random `runNonce`,
both install ids, their `/healthz` versions, the suite's commit (`suiteSha`),
`startedAt`, `finishedAt` and a timestamp per leg. `suiteSha` is git HEAD of
the directory holding `capture.ts`, and the gate compares it with CI's
`GITHUB_SHA`. So the command never uses its own copy of the capture: it
imports `runCaptures`, the preflight and the suite runner from a **frozen
suite checkout** (`--suite <path>`, default `~/code/projects/openartifacts-capture`)
and refuses unless that checkout's HEAD is `--expect-sha` (default
`5469cf7811e17857091d49dc18e0daa327bdbf89`) and its tree is clean (no
modified, staged or untracked files). The live suite after the capture runs
in that checkout too, and the binding is checked again right before it
starts, so an edit to the checkout during the capture is caught. To make
one:

```sh
git worktree add --detach ~/code/projects/openartifacts-capture 5469cf7811e17857091d49dc18e0daa327bdbf89
pnpm -C ~/code/projects/openartifacts-capture install --frozen-lockfile
pnpm -C ~/code/projects/openartifacts-capture --filter @oa/provision build
```

In CI (no capture) the two ID-token cases report `unproven: needs capture`.
`combine(ciReport, verdicts)` in `tests/redline/src/combine.ts` (for R7)
replaces exactly those two cases, and only when the install ids, versions and
commit match the CI report's `binding` and the verdicts are at most 24 h old;
otherwise it refuses with the reason. (`markRun` will send the `runNonce` to a
`POST /__test/mark` hook at the start and end of a run; it is a no-op until
that server hook exists.)

## If a case fails

`report.json` (and the printed summary) records, for every case that isn't a
pass, a redacted reason: the error message with codes, states, cookies, tokens
and emails replaced, plus the leg (for example "A's credential at B"), the
install, and the expected and actual verdict. Each capture leg also records
what the install itself logged for that sign-in (its `test_hook.signin` audit
row, through `POST /__test/audit`), verbatim as
`[install: refused: stage broker_http status 522]`, or
`[install: (stage unavailable)]` until the server ships those rows. A capture
problem (missing, too old, for other installs, not from this run) is
`unproven-live` with its reason, never a bare fail.

## The rehearsals (no human)

```sh
cd tests/redline && REDLINE_REHEARSAL=1 pnpm exec vitest run test/oneshot-rehearsal.test.ts
cd tests/redline && REDLINE_REHEARSAL=1 pnpm exec vitest run test/rehearsal.test.ts
```

Both boot the local pair with a local auth broker (`apps/auth-broker` under
`wrangler dev`, bound to the installs as `BROKER` through a shared dev
registry) and a fake Google on 127.0.0.1 whose key is made per run. The local
builds alias `@oa/auth-core` to `tests/redline/src/fake-idp/auth-core-shim.ts`,
which swaps Google's authorize, token and JWKS URLs and key for the fake's;
no release config does (a test checks), and the shim refuses to load without
its build-time defines.

`oneshot-rehearsal.test.ts` runs **the one command's own code path**
(`src/oneshot/driver.ts`: the same plain Chrome launch, the same extension
copy, the listener, the pre-sign-in checks and the suite) against a frozen suite
checkout it makes at the expected commit. The stand-in for you is the
test's harness. The rehearsal-only `--rehearsal-harness` flag starts the
same installed Chrome headless with a debugging port that only the test
uses: it does "Load unpacked" (CDP `Extensions.loadUnpacked`) and types each
account and password into the fake Google's form. The command never
connects to that port. Other rehearsal-only flags: `--loopback` (the
extension's copy also redirects the pair's https origins to http, since the
local servers speak http), `--idp`, `--flows`, `--prompt-timeout-ms`; all are
refused with staging targets. It proves:

- (a) the extension's block catches the callback as a redirect hop (the
  fake Google's 302 to the broker, the broker's 302 to the install) with
  `net::ERR_BLOCKED_BY_CLIENT`, and the install never receives it: the fake
  Google sees exactly one visit per prompt, no retry;
- (b) one profile for the whole run, yet the fake Google sees no session
  cookie on any of the 5 prompts, though each sign-in set one; a control
  shows the cookie does persist in the profile until the extension's clear;
- (c) with the extension not loaded, the command waits with the plain
  message and never falls back; requests with a wrong token get 403 and
  change nothing; the listener is on 127.0.0.1 only;
- a callback for another host, or with an `r1.` or other state, is blocked
  but never captured; this prompt's is captured once;
- the timeout prints the prompt, the user and the key, and `r` retries it;
- Chrome closing mid-prompt is noticed at once, and `r` reopens it on the
  same profile;
- a Google block page, reported by the extension, stops the run with the
  plain message, once;
- Ctrl-C (exit 130) and SIGTERM (exit 143) quit Chrome and delete the temp
  dir;
- a copy of the extension loaded in another Chrome is refused with the plain
  message, and the run goes on once it is loaded in the window that just
  opened;
- the binding refuses another commit and a dirty tree;
- each prompt's `hd` is checked on the URL the command opens, before the
  tab opens (right for all 5), and a wrong `hd` stops the run with the plain
  message, no tab and no sign-in; the page is classified by the extension
  before the sign-in is asked for;
- every Google observation the extension sends is `{ prompt, google, hd }`
  with no URL-like string (no `://`, no `?`, no path);
- and the suite, run with `--gate` from the frozen checkout, passes both
  ID-token cases from the capture's verdicts.

What it can't prove: the manual Load unpacked itself (the harness's
`loadUnpacked` stands in for it), real Google (its account chooser,
new-device checks, automation detection and google.com cookies), TLS, and
the hosted dispatch Worker.

`rehearsal.test.ts` drives the capture library (`src/capture.ts`) with a
scripted browser: the preflight's gaps, the foreign flow's dropped `hd`, the
broker relaying every code, the replay leg, and codes that die 30 s after
issue still passing when each is redeemed after its own prompt.

Neither can prove Google itself (its code lifetime, real Workspace tenants).
On staging, each prompt's checks before the sign-in (probe, `hd`, block
page) cover the path up to Google's sign-in page.

## The old clipboard flow

`tests/redline/scripts/signin-capture.ts` (copy the callback URL by hand) is
still in the tree, but the one command replaces it.
