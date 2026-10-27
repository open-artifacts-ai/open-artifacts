# Red line: the real-tenant sign-in step (about 10 minutes)

Two gate cases need tokens only Google can issue: **hd of A at B** and **A's
aud at B** (`tests/redline/live/signin.test.ts`). Without this step they report
`unproven-live` and the gate fails. The step is **5 Google sign-ins** with two
test users, then the suite runs. The suite never mints or signs a token.

The callback URL you copy is a live credential for a few minutes. The script
reads it from the clipboard, clears the clipboard and redeems it **at once**
(it never goes to disk): it runs that sign-in's legs right after its own
prompt (the same checks the suite's `crossCheck` makes) and writes each leg's
verdict, with a redacted reason, to a 0600 verdicts file. The suite's two
ID-token cases then report from those verdicts. **Never paste the URL into
chat, an issue or a terminal.**

The whole path is rehearsed with no human against a fake Google on the local
pair (`tests/redline/test/rehearsal.test.ts`, below), so a green rehearsal and
a green preflight leave only the Google sign-ins to you.

## Before you start

- A Mac with this repo, `REDLINE_TARGETS` for `rl-a`/`rl-b` (the kit's
  `targets.json`, with `strayHost`) and its 0600 secret files. The admin PAT
  copies come from `pnpm oa:hosted redline-creds --install <id> --confirm <id>`
  (one run per install; it writes `~/.open-artifacts/redline-capture/secrets/`).
- The passwords of `alice@oa-redline-a.fyi` and `dave@oa-redline-c.fyi`
  (password manager).
- Once, by an admin: `rl-a` has Google sign-in on, `AUTH_DOMAINS=oa-redline-a.fyi`
  and alice invited; `rl-b` has Google sign-in on, `AUTH_DOMAINS=oa-redline-c.fyi`
  and dave invited; the broker registry lists each install with its own domain.
- The one-time-code cases (no human step) need a Turnstile token when the
  installs enforce hosted Turnstile: put one the installs' Turnstile secret
  accepts in a 0600 file and set `turnstileFile` on each target in
  `REDLINE_TARGETS`. Without it those cases fail at the code request.

## The preflight

The script checks everything else first and **refuses to start**, naming each
gap, if anything would leave a case unproven or failing for setup reasons. All
checks are read-only; secret files are checked for existence and mode 0600
only, and nothing secret is printed.

| Check | Gap means |
|---|---|
| Each install's admin PAT file exists, mode 0600 | run the `redline-creds` command it prints |
| Each install's Turnstile token file exists, mode 0600 | set `turnstileFile` on that target |
| `strayHost` is set in `REDLINE_TARGETS` | add it to the kit's `targets.json` |
| Both `/healthz` versions are equal and at least the suite's release | upgrade the installs first |
| Google sign-in is on at each install (`/auth/providers`) | turn it on |
| `TEST_DOMAIN` is not in `AUTH_DOMAINS`, and each install's tenant domain is | in-domain addresses never get codes on a google+email install |
| alice is invited to (or a member of) `rl-a`, dave of `rl-b` (`GET /api/v1/members`, admin PAT) | invite them |
| Each install's sign-in start reaches Google through the broker | the broker or its registry is down |
| Each install's server reaches its broker (`POST /__test/broker-probe`: a signed redeem with a junk code; green only on the broker's own 401) | "rl-x: install can't reach the auth broker (status N)", e.g. 522. Until the server ships the hook this reads "unchecked (hook not deployed)" and refuses: upgrade the installs first. Your run never skips this check |

The inventory key is a GitHub secret only, so on a laptop the inventory check
says **CI-only (not-local)** instead of refusing: the inventory cases then
report unproven (their reason says CI-only) and never count as a pass.

"Preflight green: only the Google sign-ins are left to you." means go.

## Steps

1. In Chrome, open a new **Incognito** window (Shift-Cmd-N).
2. Open DevTools (Opt-Cmd-I), click the **Network** tab, tick **Preserve log**,
   and type `callback/google` in the filter box. Keep DevTools open.
3. In a terminal, from the repo:

   ```sh
   cd tests/redline && node --experimental-strip-types scripts/signin-capture.ts --gate
   ```

4. The script says which user to sign in as and puts a sign-in URL on the
   clipboard. For each of its 5 prompts:
   1. Click the Incognito window's address bar, paste (Cmd-V), press Enter.
   2. At Google, choose or enter the named user and their password.
      (Prompts 1 to 3 are alice, 4 and 5 are dave. For prompt 4, sign alice
      out first: avatar, top right, **Sign out of all accounts**, or open a
      new Incognito window and repeat step 2.)
   3. The page ends on a sign-in error or retry page, or a second Google
      screen from the automatic retry. That is expected: the browser doesn't
      hold the install's sign-in cookie, so nothing is used. Close or ignore
      the second screen.
   4. In DevTools, right-click the FIRST `callback/google?…code=…` request
      for this prompt (its `state=` doesn't start with `r1.`), choose
      **Copy**, then **Copy URL**. Not the newest: after the first callback
      fails, the browser retries with its own new sign-in, and that retry's
      callback (`state=r1.…`) can't be used. Click Clear (the ⊘ button) in
      DevTools before each prompt so the first one is easy to find.
   5. Back in the terminal, press Enter. The script checks it locally (this
      install's callback, this prompt's state, the broker state naming this
      install, the age), clears the clipboard and prints
      `captured, N of 5` with the time left, then redeems it and prints each
      leg's verdict (`pass`, or `fail` with the reason). If it says the URL
      is wrong, copy it again; if the capture is too old, it starts that
      sign-in again.
5. After prompt 5 the suite runs on its own and prints the gate result. Each
   code is redeemed right after its own prompt, so only that prompt is timed:
   copy the callback URL and press Enter within a few minutes of signing in.

## What each sign-in proves

| Prompt | Install (tenant) | Google offers | Sign in as | Expected | Used for |
|---|---|---|---|---|---|
| 1 | rl-a (A) | oa-redline-a.fyi | alice@oa-redline-a.fyi | succeeds | hd of A at B: A's own sign-in works |
| 2 | rl-b (C) | any account (the script removed the hint) | alice@oa-redline-a.fyi | refused, on purpose | hd of A at B: B refuses tenant A's user |
| 3 | rl-a (A) | oa-redline-a.fyi | alice@oa-redline-a.fyi | refused at rl-b, then succeeds at rl-a | A's aud at B |
| 4 | rl-b (C) | oa-redline-c.fyi | dave@oa-redline-c.fyi (sign alice out first) | succeeds | hd of A at B: B's own sign-in works |
| 5 | rl-b (C) | oa-redline-c.fyi | dave@oa-redline-c.fyi | succeeds | A's aud at B: B's own sign-in works |

Prompt 2's mismatch is the test. The broker asks Google to offer only the
install's tenant (`hd`), so for prompt 2 the script removes that hint from the
URL it copies, as someone from another tenant would, and rl-b must still refuse
alice on her token's tenant. The script follows the broker's redirect itself,
so the URL you paste is Google's own. After each callback the browser retries
on its own and may show a second Google screen or sign in;
close or ignore it. The script prints the same line for each prompt.

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
`startedAt`, `finishedAt` and a timestamp per leg. In CI (no capture) the two
ID-token cases report `unproven: needs capture`. `combine(ciReport, verdicts)`
in `tests/redline/src/combine.ts` (for R7) replaces exactly those two cases,
and only when the install ids, versions and commit match the CI report's
`binding` and the verdicts are at most 24 h old; otherwise it refuses with the
reason. (`markRun` will send the `runNonce` to a `POST /__test/mark` hook at the
start and end of a run; it is a no-op until that server hook exists.)

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

## The rehearsal (no human)

```sh
cd tests/redline && REDLINE_REHEARSAL=1 pnpm exec vitest run test/rehearsal.test.ts
```

It boots the local pair with a local auth broker (`apps/auth-broker` under
`wrangler dev`, bound to the installs as `BROKER` through a shared dev
registry) and a fake Google on 127.0.0.1 whose key is made per run. The local
builds alias `@oa/auth-core` to `tests/redline/src/fake-idp/auth-core-shim.ts`,
which swaps Google's authorize, token and JWKS URLs and key for the fake's;
no release config does (a test checks), and the shim refuses to load without
its build-time defines. A fake browser plays you. It proves, through the real
capture code (`src/capture.ts`, `src/preflight.ts`) and the real suite cases:

- the preflight names the gaps (users not invited) and turns green after;
- each prompt's first, cookieless callback is refused by the install, the
  install's `r1.` retry follows, and the script refuses the retry's URL and
  takes the first;
- the foreign flow drops `hd` (with it, the IdP refuses tenant A's user);
- the broker relays every code (authorize, callback, signed redeem);
- the replay leg: A's code and broker state refused at B, then signed in at A;
- codes that die 30 s after issue still pass when each is redeemed after its
  own prompt (20 s of simulated human time each), and a redeem past expiry
  is a fail with its reason (`error=failed`), never a pass.

What it can't prove: Google itself (its account chooser, its code lifetime,
real Workspace tenants), TLS (the registry and `AUTH_BROKER_URL` say https,
the local servers speak http, so the fake browser rewrites `https://*.localhost`
to http), the hosted dispatch Worker in front of the installs, and Chrome's
own behaviour (cookies, DevTools copying).

