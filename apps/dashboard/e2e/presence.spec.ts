// Who's viewing (#949 Task 9, mock): the stack in the title bar's right group,
// in /full's pill, on a phone, light and dark; nothing in an embed or when gone.
import { expect, type Page, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs"; // owned, v2 current
const POLL = "Gh9kLmNpQrAsTuVx"; // public

const ARTIFACT = `<!doctype html><script>
  const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
</script><h1>Pricing launch plan</h1>`;

test.beforeEach(async ({ context }) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: ARTIFACT }),
  );
});

const key = (i: number) => `${"k".repeat(14)}${String(i).padStart(2, "0")}`;
const MAYA = {
  key: key(0),
  kind: "person",
  name: "Maya Chen",
  named: true,
  color: 2,
};
const DUCK = {
  key: key(1),
  kind: "anon",
  name: "Anonymous Duck",
  named: false,
  color: 6,
  animal: "duck",
};
const AGENT = {
  key: key(2),
  kind: "agent",
  name: "Claude Code",
  named: true,
  color: 4,
  agent: {
    owner: "Sam Ortiz",
    state: "editing",
    activity: "Rewriting the pricing table",
  },
};
const PRIYA = {
  key: key(3),
  kind: "person",
  name: "Priya Nair",
  named: true,
  color: 5,
};
const OTTER = {
  key: key(4),
  kind: "anon",
  name: "Anonymous Otter",
  named: false,
  color: 0,
  animal: "otter",
};
const LLAMA = {
  key: key(5),
  kind: "anon",
  name: "Anonymous Llama",
  named: false,
  color: 8,
  animal: "llama",
};

const connected = (page: Page, id: string) =>
  expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (
            window as unknown as {
              __oaEvents: { connections(id: string): number };
            }
          ).__oaEvents.connections(id),
        id,
      ),
    )
    .toBe(1);

const emit = (page: Page, id: string, viewers: unknown[]) =>
  page.evaluate(
    ({ id, viewers }) =>
      (
        window as unknown as {
          __oaEvents: {
            emitPresence(id: string, v: unknown[], you?: string): number;
          };
        }
      ).__oaEvents.emitPresence(id, viewers, undefined),
    // The server sends newest first; tests list oldest first, as shown.
    { id, viewers: [...viewers].reverse() },
  );

const open = async (page: Page, path: string, id: string) => {
  await page.goto(path);
  await expect(page.locator("iframe.oa-vframe")).toBeVisible();
  await connected(page, id);
};

for (const theme of ["light", "dark"] as const)
  test(`signed in, ${theme}: faces first in the right group, before Comments and the version chip`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1440, height: 800 });
    await open(page, `/a/${LANDING}`, LANDING);
    await emit(page, LANDING, [MAYA, DUCK, AGENT, PRIYA]);
    const stack = page.getByRole("group", { name: "4 people here now" });
    await expect(stack).toBeVisible();
    await expect(page.locator(".oa-pstack")).toHaveCount(1);
    await expect(stack.locator("[data-shape]")).toHaveCount(4);
    await expect(stack.locator('[data-shape="square"]')).toHaveCount(1);
    const first = await page.evaluate(() =>
      document
        .querySelector(".oa-vt > div:last-child")
        ?.firstElementChild?.getAttribute("role"),
    );
    expect(first).toBe("group");
    const faces = await stack.locator("[data-shape]").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, w: r.width, h: r.height };
      }),
    );
    for (const f of faces) expect(f.w).toBe(28);
    for (let i = 1; i < faces.length; i++)
      expect(
        (faces[i] as { x: number }).x -
          ((faces[i - 1] as { x: number }).x + 28),
      ).toBe(4);
    const stackBox = (await stack.boundingBox()) as { x: number };
    const versionChip = (await page
      .getByRole("button", { name: /^Version:/ })
      .boundingBox()) as { x: number };
    expect(stackBox.x).toBeLessThan(versionChip.x);
  });

test("six others: three faces and +3; the list is headed '3 more here'; Escape closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await open(page, `/a/${LANDING}`, LANDING);
  await emit(page, LANDING, [MAYA, DUCK, AGENT, OTTER, PRIYA, LLAMA]);
  const stack = page.getByRole("group", { name: "6 people here now" });
  await expect(stack.locator("[data-shape]")).toHaveCount(3);
  await stack.getByRole("button", { name: "3 more here" }).click();
  const list = page.getByRole("dialog", { name: "3 more here" });
  await expect(list).toContainText("Anonymous Otter");
  await expect(list).toContainText("Priya Nair");
  await expect(list).not.toContainText("Maya Chen");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
});

test("a face opens its card; no email anywhere", async ({ page }) => {
  await open(page, `/a/${LANDING}`, LANDING);
  await emit(page, LANDING, [MAYA, AGENT]);
  await page.getByRole("button", { name: "Claude Code" }).click();
  const card = page.getByRole("dialog");
  await expect(card).toContainText("Sam Ortiz's agent · Editing");
  await expect(card).toContainText("“Rewriting the pricing table”");
  await expect(card).toContainText("In the agent's own words");
  expect(await card.textContent()).not.toContain("@");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});

test("anonymous: the faces are first in the right group (no version chip)", async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    const f = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === "/api/v1/me")
        return new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "no" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      return f(req);
    };
  });
  await open(page, `/a/${POLL}`, POLL);
  await emit(page, POLL, [MAYA, DUCK]);
  const stack = page.getByRole("group", { name: "2 people here now" });
  await expect(stack).toBeVisible();
  await expect(page.getByRole("button", { name: /^Version:/ })).toHaveCount(0);
  const first = await page.evaluate(() =>
    document
      .querySelector(".oa-vt > div:last-child")
      ?.firstElementChild?.getAttribute("role"),
  );
  expect(first).toBe("group");
});

test("/full: the stack sits in the pill before Exit; exactly one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, `/a/${LANDING}/full`, LANDING);
  await emit(page, LANDING, [MAYA, DUCK, AGENT, OTTER, PRIYA, LLAMA]);
  const stack = page
    .locator(".oa-fsbar")
    .getByRole("group", { name: "6 people here now" });
  await expect(stack).toBeVisible();
  await expect(page.locator(".oa-pstack")).toHaveCount(1);
  const s = (await stack.boundingBox()) as { x: number };
  const x = (await page.locator(".oa-fsx").boundingBox()) as { x: number };
  expect(s.x).toBeLessThan(x.x);
});

test("phone at 390: one face plus +N, and a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page, `/a/${LANDING}`, LANDING);
  await emit(page, LANDING, [MAYA, DUCK, AGENT, OTTER, PRIYA, LLAMA]);
  const stack = page.getByRole("group", { name: "6 people here now" });
  await expect(stack.locator("[data-shape]")).toHaveCount(1);
  await stack.getByRole("button", { name: "5 more here" }).click();
  const sheet = page.getByRole("dialog", { name: "5 more here" });
  await expect(sheet).toContainText("Anonymous Duck");
  await expect(sheet).toContainText("Anonymous Llama");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("a gone artifact shows no stack", async ({ page }) => {
  await open(page, `/a/${LANDING}`, LANDING);
  await emit(page, LANDING, [MAYA]);
  await expect(page.getByRole("group", { name: /here now/ })).toBeVisible();
  await page.evaluate(async (id) => {
    await fetch(`/api/v1/artifacts/${id}`, { method: "DELETE" });
  }, LANDING);
  await expect(page.getByRole("group", { name: /here now/ })).toHaveCount(0);
});
