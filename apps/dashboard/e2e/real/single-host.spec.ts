import { R } from "@oa/shared";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

test.skip(
  process.env.OA_E2E_SINGLE_HOST !== "1",
  "opt-in single-host compatibility experiment",
);

test("private multi-file HTML retains opaque execution, bridge, update and anonymous denial", async ({
  page,
  member,
  browser,
}) => {
  const files = {
    "index.html":
      '<!doctype html><link rel="stylesheet" href="styles.css"><p id="out">loading</p><script type="module" src="app.js"></script>',
    "styles.css": "#out { color: rgb(10, 20, 30); }",
    "app.js":
      'await window.openArtifacts.ready; await window.openArtifacts.db.collection("notes").set("n1", {revision:1}); document.getElementById("out").textContent="module v1 中文";',
  };
  const { id } = await publishViaApi(member.pat, {
    title: `Single host ${uniq()}`,
    format: "html",
    files,
    entry: "index.html",
    visibility: "private",
    capabilities: { db: true },
  });
  await page.goto(`/a/${id}`);
  const out = artifactFrame(page).locator("#out");
  await expect(out).toHaveText("module v1 中文");
  await expect(out).toHaveCSS("color", "rgb(10, 20, 30)");
  const el = page.locator("iframe.oa-vframe");
  const src = await el.getAttribute("src");
  expect(new URL(src ?? "").origin).toBe(APP);
  expect(await el.getAttribute("sandbox")).not.toContain("allow-same-origin");
  const frame = await (await el.elementHandle())?.contentFrame();
  if (!frame) throw new Error("missing artifact frame");
  const originalName = `Single host ${uniq()}`;
  const renamed = await page.request.patch(`${APP}${R.me}`, {
    headers: { "X-OA-Request": "1" },
    data: { displayName: originalName },
  });
  expect(renamed.ok()).toBe(true);
  const denied = await frame.evaluate(async (api) => {
    let parentBlocked = false;
    let cookieBlocked = false;
    try {
      void parent.document.body;
    } catch {
      parentBlocked = true;
    }
    try {
      void document.cookie;
    } catch {
      cookieBlocked = true;
    }
    const attempt = async (init: RequestInit) => {
      try {
        const r = await fetch(api, init);
        await r.text();
        return "readable";
      } catch {
        return "blocked";
      }
    };
    return {
      parentBlocked,
      cookieBlocked,
      cookieRead: await attempt({ credentials: "include" }),
      customHeader: await attempt({
        method: "PATCH",
        credentials: "include",
        headers: { "X-OA-Request": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "artifact changed the viewer" }),
      }),
    };
  }, `${APP}${R.me}`);
  expect(denied).toEqual({
    parentBlocked: true,
    cookieBlocked: true,
    cookieRead: "blocked",
    customHeader: "blocked",
  });
  // A real form POST to a valid state-changing endpoint, not a schema/method error.
  const logout = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/auth/logout" &&
      r.request().method() === "POST",
  );
  await frame.evaluate((action) => {
    const sink = document.createElement("iframe");
    sink.name = "logout-sink";
    document.body.append(sink);
    const form = document.createElement("form");
    form.action = action;
    form.method = "POST";
    form.target = sink.name;
    document.body.append(form);
    form.submit();
  }, `${APP}/auth/logout`);
  expect((await logout).status()).toBe(403);
  const stillSignedIn = await page.request.get(`${APP}${R.me}`);
  expect(stillSignedIn.ok()).toBe(true);
  expect(await stillSignedIn.json()).toMatchObject({
    user: { name: originalName },
  });
  const db = await page.request.get(`${APP}${R.dataDoc(id, "notes", "n1")}`);
  expect(db.ok()).toBe(true);
  expect(await db.json()).toMatchObject({ data: { revision: 1 } });

  const anonymous = await browser.newContext();
  try {
    expect(
      (await anonymous.request.get(`${APP}/p/${id}/v1/__view`)).status(),
    ).toBe(404);
    const deniedApi = await anonymous.request.get(`${APP}${R.artifact(id)}`);
    expect([401, 404]).toContain(deniedApi.status());
  } finally {
    await anonymous.close();
  }

  const update = await page.request.post(`${APP}${R.versions(id)}`, {
    headers: { "X-OA-Request": "1" },
    data: {
      id,
      expectedVersion: 1,
      format: "html",
      entry: "index.html",
      files: {
        ...files,
        "app.js":
          'await window.openArtifacts.ready; document.getElementById("out").textContent="module v2 中文";',
      },
    },
  });
  expect(update.ok(), await update.text()).toBe(true);
  await page.reload();
  await expect(artifactFrame(page).locator("#out")).toHaveText(
    "module v2 中文",
  );
  expect(
    new URL((await page.locator("iframe.oa-vframe").getAttribute("src")) ?? "")
      .pathname,
  ).toContain("/v2/");
});

test("public content keeps CSP on direct visits, misses and assets", async ({
  member,
  browser,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Public ${uniq()}`,
    format: "html",
    content: '<!doctype html><p id="public">public HTML</p>',
    visibility: "public",
  });
  const anonymous = await browser.newContext();
  try {
    const p = await anonymous.newPage();
    await p.goto(`${APP}/a/${id}`);
    await expect(artifactFrame(p).locator("#public")).toHaveText("public HTML");
    await p.goto(`${APP}/p/${id}/v1/__view`);
    expect(new URL(p.url()).pathname).toBe(`/a/${id}/full`);
    for (const path of [
      "/c/nope",
      "/p/nope",
      "/_oa/nope.js",
      "/%63/nope",
      "/c%2fnope",
    ]) {
      const r = await anonymous.request.get(APP + path);
      expect(r.status()).toBe(404);
      expect(r.headers()["content-security-policy"]).toContain("sandbox");
      expect(r.headers()["access-control-allow-credentials"]).toBeUndefined();
    }
  } finally {
    await anonymous.close();
  }
});
