import { R } from "@oa/shared";
import { expect, test } from "@playwright/test";
import { leoPin } from "../gate";
import { sendRead } from "../retry";
import { FETCH_MS, LEO } from "../targets";

// leo is the user's install: anonymous GETs and page loads only. Nothing here
// signs in, creates, or changes anything.

const get = (path: string) =>
  sendRead("GET", () =>
    fetch(`${LEO}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_MS),
    }),
  );

test("leo runs a release build: healthz ok, a version, and no test hooks", async () => {
  const res = await get("/healthz");
  expect(res.status).toBe(200);
  const h = (await res.json()) as Record<string, unknown>;
  expect(h.ok).toBe(true);
  expect(String(h.version)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(h).not.toHaveProperty("testHooks");
  // leo's own pin (#1251), unset in CI: leo can lag the tag until #955 keeps
  // it current, which is what lets CI set T19_EXPECT_LEO_VERSION.
  const want = leoPin(process.env);
  if (want) expect(h.version).toBe(want);
});

test("usage_off: R.usage is 404 on leo", async () => {
  expect((await get(R.usage)).status).toBe(404);
});

// Cut (#1251): "the sign-in page never calls leo self-hosted". The page shows
// one line or the other (apps/dashboard/src/pages/SignIn.tsx), so the test
// below covers it.
test("the sign-in page says it's hosted by Open Artifacts", async ({
  page,
}) => {
  await page.goto(`${LEO}/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Hosted by Open Artifacts")).toHaveCount(1);
});

// "no leo spec imports rl-a's session or API helpers" is a source check, not a
// product one: it moved to apps/dashboard/test/t19-leo-isolation.test.ts (#1251).
