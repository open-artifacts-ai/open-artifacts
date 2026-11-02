import { expect, test } from "@playwright/test";
import { FETCH_MS, rlA } from "../targets";

// Before any rl-a case: the host is rl-a itself (its own installId) and has
// test hooks, so a misrouted or prod host never gets a single write.
test("rl-a reports testHooks and its own installId", async () => {
  const a = rlA();
  const res = await fetch(`${a.app}/healthz`, {
    signal: AbortSignal.timeout(FETCH_MS),
  });
  expect(res.status).toBe(200);
  const h = (await res.json()) as { testHooks?: boolean; installId?: string };
  expect(h.installId).toBe(a.installId);
  expect(h.testHooks).toBe(true);
  // T19 tests a release candidate: CI pins it (redline-staging.yml).
  const want = process.env.T19_EXPECT_VERSION;
  if (want) expect((h as { version?: string }).version).toBe(want);
});
