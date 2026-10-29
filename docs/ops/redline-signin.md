# Red line: the real-tenant sign-in step (one command, about 5 minutes)

Two gate cases need tokens only Google can issue: **hd of A at B** and **A's
aud at B** (`tests/redline/live/signin.test.ts`). Without this step they report
`unproven-live` and the gate fails. The step is **5 Google sign-ins** with two
test users, then the suite runs. The suite never mints or signs a token.

You run one command and type two test accounts' passwords into Chrome. Nothing
is copied, pasted or clicked in the terminal. Why it is built this way, and
what it replaced: `docs/ops/redline-capture-audit.md`.

## Run it

From this repo (any checkout with this command; the suite itself runs from
the frozen checkout, see "The gate binding"):

```sh
pnpm -C tests/redline capture
```

That is all. The first time, or when the admin secrets are missing, add
`--make-creds` to have it make them (it shows the commands first; see
"Credentials").

For each of the 5 prompts it prints one line, for example

```
[1/5] rl-a: sign in as alice@oa-redline-a.fyi in the Chrome window that just opened (Google offers only oa-redline-a.fyi accounts). Google may ask you to confirm it's you; that's normal. The window closes by itself.
```

and opens a new Chrome window already on Google's sign-in page. Type the
named account and its password (password manager). When Google hands the
sign-in back, the window closes on its own and the terminal prints
`captured, N of 5` and each leg's verdict (`pass`, or `fail` with the
reason). Then the next window opens. After prompt 5 the live suite runs with
`--gate` and prints the gate result.

If a prompt sees no sign-in within 5 minutes (`--prompt-timeout-min <n>`), the
window closes and the terminal says which prompt to redo and as whom:

```
[2/5] No sign-in came back within 5 min.
  Redo prompt 2 of 5: sign in as alice@oa-redline-a.fyi at rl-b. Press r to retry it (Ctrl-C stops).
```

Press `r`: a fresh window opens for that prompt only. Ctrl-C at any point
stops Chrome, deletes its temporary profile and the verdicts, and exits.

If Google refuses the window itself ("This browser or app may not be secure",
or any Google automation or unsupported-browser page), the run stops at once
with:

```
Stopped at prompt 1 of 5 (rl-a, alice@oa-redline-a.fyi): Google's block page (/v3/signin/rejected).
  This is Google refusing to sign in from the browser this script started (its automation or unsupported-browser block), not a red-line test failure. Nothing was retried and nothing was redeemed.
```

It never retries on its own. Tell Platform.

## What it checks first (each refusal names its fix)

In order, all before any window opens:

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
   else it asks once and saves it there (0600). Those commands also need, and
   it checks first: the Keychain item `oa-hosted-staging` (account
   `open-artifacts`), `gh auth status`, `git config user.email`, and each
   install's `~/.open-artifacts/hosted-staging/<app host>-hook-key` (0600).
3. **The preflight** (below), with `REDLINE_ALLOW_UNCHECKED_BROKER=1` built in
   until the broker-probe hook ships (#846). The override applies only when
   the hook answers 404; any other answer still refuses.
4. **The capture**, then **the suite** with `--gate` (and
   `REDLINE_DELETED_HOSTS` set to the rl-del hosts unless `targets.json` has
   `deletedHosts`).

Every flag and environment variable the old steps needed is built in.

## Platform's dry run

```sh
pnpm -C tests/redline capture:dry-run
```

Runs the prerequisites and the preflight, then for each of the 5 prompts
starts a real sign-in at the install, opens Chrome up to Google's sign-in
page with no credentials, and checks: the Google URL carries `hd` for
a-alice, a-alice-replay, b-dave and b-dave-2 and has **no** `hd` for b-alice;
the broker state names this install and this start; the interception is armed
(and answers a probe) for this install's callback host and this start's
state; Google's page loaded with no block; `navigator.webdriver` is false.
Then it closes the window and deletes the profile. It redeems nothing and
runs no suite. It prints one line per prompt and exits 0 only when all 5 are
clean.

## How the window works

- Chrome is the installed Google Chrome, started as a **normal process**
  with a fresh temporary profile per prompt (`--user-data-dir`), so alice's
  Google session never reaches dave's prompt. A fresh profile can make Google
  ask you to confirm it's you (a new-device check); that is normal, not a
  block. Chrome is not started by an automation library and has no
  `--enable-automation`: Google refuses sign-in in browsers that look
  automated. Current Chrome sets `navigator.webdriver` whenever a debugging
  port is open, so the launch adds
  `--disable-blink-features=AutomationControlled`; the value is checked in a
  throwaway first tab, never in the sign-in tab.
- The debugging port listens on 127.0.0.1 only, on a port Chrome picks
  (`--remote-debugging-port=0`), only while the prompt's window is open.
- The driver speaks raw CDP over one WebSocket to the browser endpoint and
  uses only the `Target` and `Fetch` domains there. `Fetch` is enabled on
  the browser session itself, before the sign-in tab exists, so it holds
  every tab's navigations (the new tab's very first one, popups) with
  nothing to race. The sign-in tab is created with
  `Target.createTarget(<Google URL>)` and the driver never opens a session
  on it: no `Runtime`, no `Page`, no init script, no user-agent override.
  (Per-tab `Fetch` after auto-attach with `waitForDebuggerOnStart` missed a
  new tab's first navigation on Chrome 156 in the rehearsal, so it is not
  used.)
- `Fetch` at the Request stage is armed for **this prompt's install callback
  only** (`https://<install>/auth/callback/google*`). The callback arrives as
  the broker's 302 target, and the Request stage pauses that redirect hop.
  The first request carrying this prompt's state is captured and failed in
  the browser, so the install never sees it and never starts its automatic
  retry (no `r1.` screen); nothing reloads or revisits it, the window just
  closes. A callback for another host or another state is never captured.
  Before the Google page opens, a probe callback navigation in a tab of its
  own proves the interception is armed (it is held and the tab closed).
- A Google block is recognized from the sign-in tab's URL (Google's
  `/signin/rejected` pages), seen through `Fetch` and target-info events, so
  no script ever runs in that tab.
- The captured URL stays in memory: it is checked by the frozen capture code
  and redeemed at once (its legs run right after its own prompt), each leg's
  verdict going to a 0600 verdicts file in a 0700 temporary directory that is
  removed at the end. It is never printed, logged, put on the clipboard or
  written anywhere else.
- Chrome and its profile are removed on every exit path: success, error,
  timeout, a Google block, Ctrl-C, SIGTERM and SIGHUP.

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
token's tenant. Each prompt has its own fresh profile, so there is nothing to
sign out of between alice and dave.

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
in that checkout too. To make one:

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
(`src/oneshot/driver.ts`, the same Chrome launch, raw CDP and `Fetch`
interception) against a frozen suite checkout it makes at the expected
commit, with real Chrome. The test types each account and password into the
fake Google's form over its own CDP session, standing in for you; the
driver is checked to have held no session on the sign-in tab at all. Chrome runs headless there
(`--headless`, rehearsal only; it changes nothing else), and the local pair's
https origins are answered over loopback http by the interceptor
(`--loopback`, rehearsal only). Both flags, `--idp` and `--flows` are refused
with staging targets. It proves:

- each prompt captures the first callback, caught as the broker's 302
  target, and the install never starts its retry (the fake Google sees
  exactly one visit per prompt);
- the driver opens no CDP session on the sign-in tab (its only page session
  is the throwaway tab's `navigator.webdriver` check; the rest is `Target`
  and `Fetch` on the browser session);
- a callback for another host, or with an `r1.` or other state, is never
  captured;
- each prompt's profile is fresh: alice's Google session never reaches
  dave's prompt (and does persist within one profile, the control);
- the timeout prints the prompt, the user and the key, and `r` retries it;
- a Google block page stops the run with the plain message, once;
- Ctrl-C mid-prompt leaves no Chrome process and no profile;
- the debugging port listens on 127.0.0.1 only;
- the binding refuses another commit and a dirty tree;
- the dry run's checks, all 5 prompts;
- and the suite, run with `--gate` from the frozen checkout, passes both
  ID-token cases from the capture's verdicts.

`rehearsal.test.ts` drives the capture library (`src/capture.ts`) with a
scripted browser: the preflight's gaps, the foreign flow's dropped `hd`, the
broker relaying every code, the replay leg, and codes that die 30 s after
issue still passing when each is redeemed after its own prompt.

What neither can prove: Google itself (its account chooser, its code
lifetime, its automation checks, real Workspace tenants), TLS, and the hosted
dispatch Worker in front of the installs. The dry run on staging covers the
path up to Google's sign-in page.

## The old clipboard flow

`tests/redline/scripts/signin-capture.ts` (copy the callback URL by hand) is
still in the tree, but the one command replaces it.
