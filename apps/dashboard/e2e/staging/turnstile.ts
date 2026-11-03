// The code-request page's Turnstile slot, on rl-a (#1251). The live suite
// sends Cloudflare's dummy token, which rl-a's always-pass test secret
// accepts (tests/redline/src/signin.ts TURNSTILE_DUMMY_TOKEN;
// .github/workflows/redline-staging.yml writes the same token). T19 does the
// same through the UI: this init script stands in for Cloudflare's widget
// script, so the page hands the dummy token to the real code request without
// waiting on a third party. The dashboard keeps a page's own window.turnstile
// (apps/dashboard/src/pages/Turnstile.tsx loadTurnstile), and the server still
// verifies the token with Cloudflare.

export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** Runs in the page before any of its scripts (Playwright addInitScript). */
export function stubTurnstile(token: string): void {
  let n = 0;
  (window as unknown as { turnstile: unknown }).turnstile = {
    render(_el: unknown, options: { callback?: (t: string) => void }) {
      n += 1;
      setTimeout(() => options.callback?.(token), 0);
      return `t19-${n}`;
    },
    reset() {},
    remove() {},
  };
}
