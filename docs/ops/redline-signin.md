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
   3. The page ends on a sign-in error or retry page. That is expected: the
      browser doesn't hold the install's sign-in cookie, so nothing is used.
   4. In DevTools, right-click the newest `callback/google?…code=…` request,
      choose **Copy**, then **Copy URL**.
   5. Back in the terminal, press Enter. The script checks it, saves it and
      clears the clipboard. If it says the URL is wrong, copy it again.
5. After prompt 5 the suite runs on its own and prints the gate result. Do all
   5 sign-ins within about 8 minutes (Google codes expire). If you run out of
   time, start again from step 3.

## What each sign-in proves

| Prompt | Started at | User | Used for |
|---|---|---|---|
| 1 | rl-a | alice | hd of A at B: A's own sign-in works |
| 2 | rl-b | alice | hd of A at B: refused at B (tenant) |
| 3 | rl-a | alice | A's aud at B: refused at B, then still signs in at A |
| 4 | rl-b | dave | hd of A at B: B's own sign-in works |
| 5 | rl-b | dave | A's aud at B: B's own sign-in works |

Codes are single use, so each of the 3 legs per case (B's own success, A's own
success, A's value refused at B) needs its own sign-in; the aud case gets two
legs from one capture (refused at B first, then accepted at A).

Other sign-in cases need no human: OIDC state replay, one-time codes and
guests run live; the tampered broker install id runs on staging from a real
broker state. The cases Google can't produce and the broker's signed redeem
assertion are covered by fixtures (see the P5 plan, Task 6).
