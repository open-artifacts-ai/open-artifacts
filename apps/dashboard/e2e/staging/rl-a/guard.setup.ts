import { expect, test } from "@playwright/test";
import { HOOK_WINDOW_MS } from "../hook-ledger";
import { clearT19HookWindow } from "../hook-pace";
import { sendRead } from "../retry";
import { FETCH_MS, rlA } from "../targets";

// Before any rl-a case: the host is rl-a itself (its own installId) and has
// test hooks, so a misrouted or prod host never gets a single write.
test("rl-a reports testHooks and its own installId", async () => {
  const a = rlA();
  const res = await sendRead("GET", () =>
    fetch(`${a.app}/healthz`, { signal: AbortSignal.timeout(FETCH_MS) }),
  );
  expect(res.status).toBe(200);
  const h = (await res.json()) as { testHooks?: boolean; installId?: string };
  expect(h.installId).toBe(a.installId);
  expect(h.testHooks).toBe(true);
  // T19 tests a release candidate: CI pins it (redline-staging.yml).
  const want = process.env.T19_EXPECT_VERSION;
  if (want) expect((h as { version?: string }).version).toBe(want);
});

// #1254: the red-line live suite runs just before on the same runner and
// shares rl-a's hook bucket. Start T19 with its calls out of the window, so
// T19's spread calls never wait past a test's own timeout.
test("rl-a's hook budget is clear of earlier calls", async () => {
  test.setTimeout(HOOK_WINDOW_MS + 30_000);
  await clearT19HookWindow(rlA().app);
});
