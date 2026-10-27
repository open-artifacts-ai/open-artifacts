# Red line: the real-tenant sign-in step (about 10 minutes)

Two gate cases need tokens only Google can issue: **hd of A at B** and **A's
aud at B** (`tests/redline/live/signin.test.ts`). Without this step they report
`unproven-live` and the gate fails. The step is **5 Google sign-ins** with two
test users, then the suite runs. The suite never mints or signs a token.

The callback URL you copy is a live credential for a few minutes: it goes from
the clipboard into a 0600 file the suite reads, and the clipboard is cleared.
**Never paste it into chat, an issue or a terminal.**

## Before you start

- A Mac with this repo, `REDLINE_TARGETS` for `rl-a`/`rl-b` and its 0600
  secret files (as for any staging red-line run).
- The passwords of `alice@oa-redline-a.fyi` and `dave@oa-redline-c.fyi`
  (password manager).
- Once, by an admin: `rl-a` has Google sign-in on, `AUTH_DOMAINS=oa-redline-a.fyi`
  and alice invited; `rl-b` has Google sign-in on, `AUTH_DOMAINS=oa-redline-c.fyi`
  and dave invited; the broker registry lists each install with its own domain.
- The one-time-code cases (no human step) need a Turnstile token when the
  installs enforce hosted Turnstile: put one the installs' Turnstile secret
  accepts in a 0600 file and set `turnstileFile` on each target in
  `REDLINE_TARGETS`. Without it those cases fail at the code request.

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
   5. Back in the terminal, press Enter. The script checks it, saves it and
      clears the clipboard. If it says the URL is wrong, copy it again.
5. After prompt 5 the suite runs on its own and prints the gate result. Do all
   5 sign-ins within about 8 minutes (Google codes expire). If you run out of
   time, start again from step 3.

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
