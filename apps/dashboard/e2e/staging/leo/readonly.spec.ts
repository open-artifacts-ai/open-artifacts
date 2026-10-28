import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { R } from "@oa/shared";
import { expect, test } from "@playwright/test";
import { FETCH_MS, LEO } from "../targets";

// leo is the user's install: anonymous GETs and page loads only. Nothing here
// signs in, creates, or changes anything.

const get = (path: string) =>
  fetch(`${LEO}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_MS),
  });

test("leo runs a release build: healthz ok, a version, and no test hooks", async () => {
  const res = await get("/healthz");
  expect(res.status).toBe(200);
  const h = (await res.json()) as Record<string, unknown>;
  expect(h.ok).toBe(true);
  expect(String(h.version)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(h).not.toHaveProperty("testHooks");
  const want = process.env.T19_EXPECT_VERSION;
  if (want) expect(h.version).toBe(want);
});

test("usage_off: R.usage is 404 on leo", async () => {
  expect((await get(R.usage)).status).toBe(404);
});

test("the sign-in page never calls leo self-hosted", async ({ page }) => {
  await page.goto(`${LEO}/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Self-hosted on Cloudflare")).toHaveCount(0);
});

test("the sign-in page says it's hosted by Open Artifacts", async ({
  page,
}) => {
  await page.goto(`${LEO}/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Hosted by Open Artifacts")).toHaveCount(1);
});

// A leo spec that could sign in or write would break the rule above: no
// import of rl-a's helpers or the test hooks, and no hook path.
test("no leo spec imports rl-a's session or API helpers", async () => {
  const dir = import.meta.dirname;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    expect(src, f).not.toMatch(/^import[^;]*(rl-a\/|TEST_HOOKS)/m);
    expect(src, f).not.toContain(["/__", "test/"].join(""));
  }
});
