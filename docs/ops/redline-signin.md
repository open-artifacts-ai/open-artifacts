# Red line: real-tenant sign-in cases (staging)

P5 R6. `tests/redline/live/signin.test.ts` reports the Google ID-token cases
`unproven-live` ("needs real-tenant tokens") unless `REDLINE_SIGNIN_CAPTURES`
points at fresh captures of real sign-ins. The suite never mints or signs a
token: every value it replays was issued by an install, the broker or Google.
Until then those cases run on P2's fake-Google fixture
(`apps/server/test/xt-google.local.test.ts`).

## Prerequisites (once)

- `rl-a`: Google sign-in on (broker transport), `AUTH_DOMAINS=oa-redline-a.fyi`;
  `alice@` and `bob@oa-redline-a.fyi` invited as members (hosted installs
  admit by invite only).
- `rl-b`: the same with `AUTH_DOMAINS=oa-redline-c.fyi`; `dave@` and
  `erin@oa-redline-c.fyi` invited.
- The broker registry lists each install with its own domain.
- The tenant users' passwords stay in the user's password manager (or, for CI,
  0600 files); 2-step verification off for these test users if CI signs in.

## Each run (all within 9 minutes: Google codes and broker states expire)

1. Start the flows (writes `<dir>/flows.json` and `<dir>/urls.txt`, 0600; the
   install's state cookies stay in `flows.json`, the browser never gets them):

   ```sh
   REDLINE_TARGETS=... node --experimental-strip-types tests/redline/scripts/signin-capture.ts <dir>
   ```

2. For each line of `urls.txt` (`flow`, `user`, URL), in a fresh browser
   profile, open the URL and sign in at Google as that **real** user:

   | flow | started at | sign in as | proves |
   |---|---|---|---|
   | `a-alice` | rl-a | alice@oa-redline-a.fyi | A's own success leg |
   | `b-dave` | rl-b | dave@oa-redline-c.fyi | B's own success leg |
   | `b-alice` | rl-b | alice@oa-redline-a.fyi | hd of A at B is refused |
   | `a-replay` | rl-a | bob@oa-redline-a.fyi | A's code and broker state (A's client flow) refused at B, then still valid at A |
   | `b-erin` | rl-b | erin@oa-redline-c.fyi | B's own success leg for the replay case |

3. Capture the URL the broker sends the browser to
   (`https://<install>/auth/callback/google?code=…&state=…&bstate=…`)
   **without letting the install consume it**, and save it, alone, to
   `<dir>/<flow>.url` (mode 0600). The install can't consume it anyway (the
   browser lacks the state cookie, so it fails before redeeming), but take the
   URL from the request itself:
   - Human: DevTools, Network, "Preserve log"; copy the request URL of
     `/auth/callback/google`.
   - CI: a browser automation (e.g. Playwright) that signs in with the
     tenant user's password from a 0600 file, aborts the request to
     `/auth/callback/google` and writes its URL.

4. Run the suite with `REDLINE_SIGNIN_CAPTURES=<dir>`. Each capture is used
   once (codes are single use). Delete `<dir>` afterwards.

## Never producible, even with real tenants

- A token with a B email domain but `hd` of A, and a token with no `hd` and a
  B email: `oa-redline-c.fyi` is verified to tenant B, so no tenant-A or
  consumer account can carry it. Fixture only.

## Not replayable

- The broker redeem assertion (A's at B, B's at A) is Ed25519-signed by the
  install server-side and never leaves the install-broker channel; there is no
  real value to capture, and minting one would be forging. Fixture:
  `apps/auth-broker/test/broker.test.ts`. The `a-replay` flow is the
  real-value equivalent (A's code and broker state redeemed by B).
- The tampered-install-id case needs no capture: it runs on staging from a
  real broker state taken from a sign-in start.
